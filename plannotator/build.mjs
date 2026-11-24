#!/usr/bin/env node
/**
 * Builds the Orca build of Plannotator: one single-file binary for one target. Run by CI and by developers, never on
 * end users' machines. Node built-ins only (plus `git` and `tar` on PATH).
 *
 *   node build.mjs --version 0.28.67 --target darwin-arm64 --out dist/plannotator-orca-darwin-arm64
 *     [--source <plannotator checkout>] [--commit <sha>] [--work <dir>] [--bun <path>] [--without <group>]...
 *     [--gates-only | --check-only] [--report <file>] [--keep]
 *   node build.mjs --fit <plannotator checkout>
 *   node build.mjs --check-binary <file> --version 0.28.67
 *   node build.mjs --recipe-hash
 *
 * Steps: fetch Plannotator's tag (or use --source) and verify its commit; verify every file of this folder against
 * recipe.json; apply each group of edits in order (edits.mjs: each edit finds its line by content and fails closed);
 * copy the modules and gates; write the build's own list of what it carries (the recipe's generated module); run the
 * build steps; compile for the target; run the gates; run `--version` when the binary runs here; print its sha256,
 * size and what it carries.
 *
 * Optional groups: a group the recipe marks `"required": false` whose edits no longer fit is left out whole, with the
 * modules and gates that name it (`"group"`) and any group that `"needs"` it, and the build goes on without the
 * features it carries. `--without <group>` (repeatable) leaves one out on purpose. A required group that no longer
 * fits stops the build (exit 3). The build's report, on stdout and in `<out>.build.json` (or `--report`), names the
 * groups applied, the groups left out (each with why: the edit refused and what it found, or `--without`) and the
 * final `features` list. A failed build writes the report too, with `ok: false`, its exit code and its error line.
 * A type check that fails only on lines an optional group's edits changed or put in, or in its added files, leaves
 * that group out the same way: the tree is reset and the build starts again without it (once per group at most).
 *
 * `--gates-only` runs the edits, the prepare steps and the gates; `--check-only` also runs the check steps (type
 * checks and upstream's tests). Neither compiles. `--fit <checkout>` changes nothing: it tries every edit on that
 * checkout and prints which fit and why the others do not (exit 0 all fit, 3 a required group does not, 6 only
 * optional groups do not).
 *
 * `--recipe-hash` prints the sha256 of what decides a build's content here (recipe.json, this script and edits.mjs),
 * so a published build can say which recipe made it.
 *
 * The commit: recipe.json names the one for its own version. Another version needs --commit (CI resolves the tag
 * with `git ls-remote` and passes it), so a moved tag is refused rather than built.
 *
 * Bun: --bun, else $ORCA_BUILD_BUN, else the recipe's pinned Bun for this machine, downloaded from the npm registry
 * and checked against the recipe's sha512 integrity.
 *
 * Output: stdout carries only the final one-line JSON report; every step's output goes to stderr.
 *
 * Exit codes: 0 built (a reduced build too); 2 usage; 3 a required group no longer fits; 4 a gate or check failed;
 * 5 the source or a file of this folder does not match the recipe; 1 anything else. A failure prints one line
 * starting with "orca-build: ".
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyGroups, applyOrSatisfy, editedLines, EditRefused, fileText, openFile, parseEdits } from "./edits.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const recipe = JSON.parse(readFileSync(join(HERE, "recipe.json"), "utf8"));
const TARGETS = recipe.targets;
const HOST = `${process.platform}-${process.arch}`;

class Stop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new Stop(code, message);
};
const say = (text) => process.stderr.write(`orca-build: ${text}\n`);

function args(argv) {
  const out = { flags: new Set(), without: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gates-only" || a === "--check-only" || a === "--keep" || a === "--recipe-hash") out.flags.add(a.slice(2));
    else if (a === "--without") {
      if (i + 1 >= argv.length) fail(2, `${a} needs a value`);
      out.without.push(argv[++i]);
    } else if (/^--(version|target|out|source|commit|work|bun|check-binary|report|fit)$/.test(a)) {
      if (i + 1 >= argv.length) fail(2, `${a} needs a value`);
      out[a.slice(2)] = argv[++i];
    } else fail(2, `unknown argument ${a}`);
  }
  return out;
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** What decides a build's content here: recipe.json (which pins every edit file, module and gate) and the scripts that apply them. */
function recipeHash() {
  const hash = createHash("sha256");
  for (const name of ["recipe.json", "build.mjs", "edits.mjs"]) hash.update(name + "\0" + readFileSync(join(HERE, name), "utf8").replaceAll("\r\n", "\n") + "\0");
  return hash.digest("hex");
}

/** The generated module: the features and left-out groups of one build (the repo's copy is the full build's). */
const BUILD_INFO = recipe.modules.find((entry) => entry.generated === "build-info");
function buildInfoText(features, omitted) {
  return [
    "/**",
    " * What this Orca build of Plannotator carries. Written by build.mjs from recipe.json for each build: the copy in the",
    " * Orca plugin's build folder is a full build's, and build.mjs refuses to build when it differs from that.",
    " * `features`: what `GET /api/inbox/orca` serves. `omitted`: the optional groups of edits this build left out.",
    " */",
    `export const ORCA_BUILD: { readonly features: readonly string[]; readonly omitted: readonly string[] } = {`,
    `  features: ${JSON.stringify(features)},`,
    `  omitted: ${JSON.stringify(omitted)},`,
    "};",
    "",
  ].join("\n");
}
const allFeatures = () => recipe.groups.flatMap((group) => group.features ?? []);

function run(argv, options = {}) {
  const shown = argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
  say(`$ ${shown}`);
  const result = spawnSync(argv[0], argv.slice(1), { stdio: options.capture ? ["ignore", "pipe", "pipe"] : ["ignore", 2, 2], encoding: "utf8", ...options });
  if (result.error) fail(options.failCode ?? 1, `${argv[0]} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const why = options.capture ? `${result.stderr || result.stdout}`.trim().split("\n")[0] : `exit ${result.status ?? result.signal}`;
    fail(options.failCode ?? 1, `${options.what ?? shown} failed: ${why}`);
  }
  return options.capture ? result.stdout : "";
}

/** The recipe's Bun for this machine: from the npm registry, its sha512 integrity checked, unpacked under `dir`. */
async function pinnedBun(dir) {
  const pkg = recipe.bun.packages[HOST];
  if (!pkg) fail(1, `no pinned Bun for ${HOST}; pass --bun`);
  const bin = join(dir, "bun-" + recipe.bun.version + "-" + HOST, "package", "bin", process.platform === "win32" ? "bun.exe" : "bun");
  if (existsSync(bin)) return bin;
  const response = await fetch(`https://registry.npmjs.org/${pkg.name}/-/${pkg.name.split("/")[1]}-${recipe.bun.version}.tgz`);
  if (!response.ok) fail(1, `Bun ${recipe.bun.version} download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  if (integrity !== pkg.integrity) fail(5, `Bun ${recipe.bun.version} for ${HOST} does not match the recipe's integrity`);
  const into = join(dir, "bun-" + recipe.bun.version + "-" + HOST);
  mkdirSync(into, { recursive: true });
  const tgz = join(into, "bun.tgz");
  writeFileSync(tgz, bytes);
  // Relative names from inside the folder: GNU tar (Git Bash on Windows) reads "C:\…" as a remote host.
  run(["tar", "-xzf", "bun.tgz"], { cwd: into, what: "unpacking Bun" });
  if (process.platform !== "win32") chmodSync(bin, 0o755);
  return bin;
}

/** Every group's edits, parsed (verifyFolder checks them first). */
const EDITS = new Map();

function verifyFolder() {
  for (const entry of [...recipe.groups, ...recipe.modules, ...recipe.gates]) {
    const path = join(HERE, entry.file);
    if (!existsSync(path)) fail(5, `${entry.file} is missing`);
    if (sha256(path) !== entry.sha256) fail(5, `${entry.file} does not match recipe.json (update its sha256 deliberately)`);
  }
  const names = new Set(recipe.groups.map((group) => group.name));
  if (names.size !== recipe.groups.length) fail(5, "recipe.json names a group twice");
  for (const [i, group] of recipe.groups.entries()) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(group.name ?? "")) fail(5, `group ${group.name} needs a name of lowercase letters, digits and dashes`);
    if (typeof group.required !== "boolean" || !Array.isArray(group.features)) fail(5, `group ${group.name} needs "required" and "features" in recipe.json`);
    for (const need of group.needs ?? []) {
      if (!recipe.groups.slice(0, i).some((g) => g.name === need)) fail(5, `group ${group.name} needs ${need}, which is not a group before it`);
      if (group.required && !recipe.groups.find((g) => g.name === need).required) fail(5, `required group ${group.name} needs optional group ${need}`);
    }
    try {
      EDITS.set(group.name, parseEdits(readFileSync(join(HERE, group.file), "utf8"), group.file));
    } catch (error) {
      fail(5, error.message);
    }
  }
  for (const entry of [...recipe.modules, ...recipe.gates]) if (entry.group !== undefined && !names.has(entry.group)) fail(5, `${entry.file} names an unknown group ${entry.group}`);
  for (const entry of [...recipe.modules, ...recipe.gates]) if (entry.group !== undefined && recipe.groups.find((g) => g.name === entry.group).required) fail(5, `${entry.file} is tied to required group ${entry.group}; tie only optional ones`);
  if (!BUILD_INFO) fail(5, `recipe.json has no generated "build-info" module`);
  // No drift: the repo's copy is exactly what a full build writes, so the source reads the same list the recipe has.
  if (readFileSync(join(HERE, BUILD_INFO.file), "utf8").replaceAll("\r\n", "\n") !== buildInfoText(allFeatures(), [])) fail(5, `${BUILD_INFO.file} is not the full build's list of features in recipe.json (regenerate it)`);
}

/** Reads a file of the Plannotator tree for the edits: its text, or null when it is not there. */
const reader = (tree) => (path) => {
  const full = join(tree, path);
  return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : null;
};

/**
 * Applies the groups in order to the tree (edits.mjs `applyGroups`): each whole or not at all. Fills `applied`,
 * `omitted` and `satisfied` (the edits Plannotator makes itself, so nothing was changed for them); a required group
 * that does not fit stops the build (exit 3) before anything is written.
 */
function applyToTree(tree, { without = [], dropped = [], version = "this Plannotator", applied, omitted, satisfied }) {
  const result = applyGroups(recipe.groups, (name) => EDITS.get(name), reader(tree), { without, dropped });
  applied.push(...result.applied);
  omitted.push(...result.omitted);
  satisfied.push(...result.satisfied.map((s) => s.edit));
  for (const s of result.satisfied) say(`edit ${s.edit} (${s.file}): Plannotator makes this change itself (${JSON.stringify(s.proof.slice(0, 120))}); nothing changed`);
  for (const o of result.omitted) {
    const group = recipe.groups.find((g) => g.name === o.name);
    say(`left out ${o.forced ? "" : "optional "}group ${o.name}${o.forced ? " (--without)" : `: ${o.reason}`}; without it: ${group.features.join(", ") || "no feature"}`);
  }
  if (result.stopped) {
    const { group, edit, file, why } = result.stopped;
    fail(3, `required group ${group} no longer fits Plannotator ${version}: edit ${edit} (${file}): ${why}`);
  }
  for (const [path, doc] of result.files) writeFileSync(join(tree, path), fileText(doc));
  return result.files;
}

/**
 * A failed type check laid on the optional groups it comes from: each error must be on a line an optional group's
 * edit changed or put in, or in a file one added. Returns Map(group → { reason, edit }), or null when any error lies
 * elsewhere (Plannotator's own lines, or a required group's), which stops the build as before.
 */
function blame(output, files, left) {
  const errors = [...output.matchAll(/^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/gm)];
  if (errors.length === 0) return null;
  const moduleOf = new Map(recipe.modules.filter((m) => m.group !== undefined && !left.has(m.group)).map((m) => [m.target, m.group]));
  const blamed = new Map();
  for (const [, file, line, code, text] of errors) {
    const path = file.replaceAll("\\", "/").replace(/^\.\//, "");
    const by = files.has(path) ? editedLines(files.get(path)).find((l) => l.line === Number(line))?.by : undefined;
    const name = moduleOf.get(path) ?? by?.split("/")[0];
    const group = recipe.groups.find((g) => g.name === name);
    if (!group || group.required) return null;
    if (!blamed.has(name)) blamed.set(name, { reason: `type check: ${path}:${line}: ${code} ${text.trim()}${by ? ` (edit ${by})` : ` (added file of ${name})`}`, ...(by ? { edit: by } : {}) });
  }
  return blamed;
}

/** `--fit`: every edit tried on the tree, nothing written. Within a group a refused edit is skipped and the next tried. */
function fitReport(tree) {
  const read = reader(tree);
  const groups = recipe.groups.map((group) => {
    const files = new Map();
    const edits = EDITS.get(group.name).map((edit) => {
      if (!files.has(edit.file)) {
        const text = read(edit.file);
        files.set(edit.file, text === null ? null : openFile(text));
      }
      const doc = files.get(edit.file);
      if (!doc) return { id: edit.id, file: edit.file, fits: false, why: `${edit.file} is not in this Plannotator` };
      try {
        const done = applyOrSatisfy(doc, edit);
        return { id: edit.id, file: edit.file, fits: true, ...(done.satisfied !== null ? { satisfied: true, proof: done.satisfied } : {}) };
      } catch (error) {
        if (!(error instanceof EditRefused)) throw error;
        return { id: edit.id, file: edit.file, fits: false, why: error.why };
      }
    });
    return { name: group.name, required: group.required, fits: edits.every((e) => e.fits), edits };
  });
  return { v: 1, groups };
}

function checkVersion(binary, version) {
  const out = run([binary, "--version"], { capture: true, failCode: 4, what: `${binary} --version` }).trim();
  if (out !== `plannotator ${version}`) fail(4, `${binary} --version printed "${out}", not "plannotator ${version}"`);
  return out;
}

function report(binary, extra = {}) {
  const info = { file: resolve(binary), sha256: sha256(binary), size: statSync(binary).size, ...extra };
  process.stdout.write(JSON.stringify(info) + "\n");
  return info;
}

/** What the build carries so far; written to `<out>.build.json` at the end, or when it fails. */
const carried = { reportFile: null, base: {}, applied: [], omitted: [], satisfied: [], features: [] };
function writeReport(info) {
  if (!carried.reportFile) return;
  mkdirSync(dirname(carried.reportFile), { recursive: true });
  writeFileSync(carried.reportFile, JSON.stringify(info, null, 2) + "\n");
}

async function main() {
  const a = args(process.argv.slice(2));
  if (a.flags.has("recipe-hash")) {
    process.stdout.write(recipeHash() + "\n");
    return;
  }
  if (a["check-binary"]) {
    if (!a.version) fail(2, "--check-binary needs --version");
    const out = checkVersion(a["check-binary"], a.version);
    report(a["check-binary"], { version: out });
    return;
  }
  if (a.fit) {
    verifyFolder();
    const fit = fitReport(resolve(a.fit));
    process.stdout.write(JSON.stringify(fit) + "\n");
    for (const group of fit.groups) for (const edit of group.edits) if (!edit.fits) say(`${group.required ? "required" : "optional"} group ${group.name}: edit ${group.name}/${edit.id} (${edit.file}) does not fit: ${edit.why}`);
    if (fit.groups.some((g) => g.required && !g.fits)) process.exitCode = 3;
    else if (fit.groups.some((g) => !g.fits)) process.exitCode = 6;
    return;
  }
  if (!a.version || !/^\d+\.\d+\.\d+$/.test(a.version)) fail(2, "--version x.y.z is required");
  if (!a.target || !TARGETS[a.target]) fail(2, `--target must be one of ${Object.keys(TARGETS).join(", ")}`);
  const gatesOnly = a.flags.has("gates-only"), checkOnly = a.flags.has("check-only");
  if (gatesOnly && checkOnly) fail(2, "--gates-only and --check-only do not go together");
  const compile = !gatesOnly && !checkOnly;
  if (compile && !a.out) fail(2, "--out <file> is required");
  const expected = a.commit ?? (a.version === recipe.plannotator.version ? recipe.plannotator.commit : null);
  if (!expected || !/^[0-9a-f]{40}$/.test(expected)) fail(5, `recipe.json pins ${recipe.plannotator.version}; pass --commit <40-hex sha> for ${a.version}`);
  for (const name of a.without) {
    const group = recipe.groups.find((g) => g.name === name);
    if (!group) fail(2, `--without ${name}: no such group (${recipe.groups.map((g) => g.name).join(", ")})`);
    if (group.required) fail(2, `--without ${name}: that group is required`);
  }
  if (a.report) carried.reportFile = resolve(a.report);
  else if (a.out) carried.reportFile = resolve(a.out) + ".build.json";
  carried.base = { plannotator: a.version, commit: expected, target: a.target, recipe: recipeHash() };

  verifyFolder();
  const work = resolve(a.work ?? mkdtempSync(join(tmpdir(), "orca-build-")));
  mkdirSync(work, { recursive: true });
  const bun = resolve(a.bun ?? process.env.ORCA_BUILD_BUN ?? (await pinnedBun(work)));
  const bunVersion = run([bun, "--version"], { capture: true }).trim();
  if (bunVersion !== recipe.bun.version) fail(5, `Bun ${bunVersion} is not the recipe's ${recipe.bun.version}`);

  // The source: a fresh clone of the tag, or a given checkout, at exactly the expected commit and clean.
  let tree;
  if (a.source) tree = resolve(a.source);
  else {
    tree = join(work, "plannotator");
    rmSync(tree, { recursive: true, force: true });
    run(["git", "clone", "--quiet", "--depth", "1", "--branch", `v${a.version}`, recipe.plannotator.repo, tree], { what: `fetching Plannotator v${a.version}` });
  }
  const head = run(["git", "-C", tree, "rev-parse", "HEAD"], { capture: true }).trim();
  if (head !== expected) fail(5, `Plannotator v${a.version} is ${head}, not the expected ${expected}`);
  if (run(["git", "-C", tree, "status", "--porcelain"], { capture: true }).trim()) fail(5, `${tree} is not a clean checkout`);

  // Build steps in an environment that keeps PATH but not the person's Plannotator or Orca settings.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(PLANNOTATOR_|NODE_OPTIONS$|BUN_OPTIONS$)/.test(key)) delete env[key];
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  Object.assign(env, { HOME: home, USERPROFILE: home, PLANNOTATOR_DATA_DIR: join(work, "data"), BUN_INSTALL_CACHE_DIR: join(work, "bun-cache"), PATH: dirname(bun) + (process.platform === "win32" ? ";" : ":") + env.PATH });
  // Plannotator's UI build needs more memory than Node allows itself where its own limit is 2 GB (an Intel Mac runner).
  env.NODE_OPTIONS = "--max-old-space-size=6144";
  const fill = (argv, out) => argv.map((part) => part.replaceAll("{bun}", bun).replaceAll("{version}", a.version).replaceAll("{bunTarget}", TARGETS[a.target]).replaceAll("{out}", out ?? ""));
  const typeCheck = (step) => step.some((part) => /(^|\/)tsc$/.test(part));

  // The edits, the added files and the checks. A type check that fails only on lines or files of optional groups
  // leaves those groups out and starts again from the clean checkout (at most once per group).
  const dropped = [];
  let left, ours;
  rounds: for (;;) {
    carried.applied.length = 0;
    carried.omitted.length = 0;
    carried.satisfied.length = 0;
    const files = applyToTree(tree, { without: a.without, dropped, version: a.version, applied: carried.applied, omitted: carried.omitted, satisfied: carried.satisfied });
    left = new Set(carried.omitted.map((o) => o.name));
    carried.features = recipe.groups.filter((group) => !left.has(group.name)).flatMap((group) => group.features);
    ours = (entry) => entry.group === undefined || !left.has(entry.group);
    for (const entry of [...recipe.modules, ...recipe.gates].filter(ours)) {
      const target = join(tree, entry.target);
      mkdirSync(dirname(target), { recursive: true });
      if (entry === BUILD_INFO) writeFileSync(target, buildInfoText(carried.features, [...left]));
      else copyFileSync(join(HERE, entry.file), target);
    }
    say(`groups applied: ${carried.applied.join(", ") || "none"}; left out: ${[...left].join(", ") || "none"}; features: ${carried.features.join(", ") || "none"}; made by Plannotator itself: ${carried.satisfied.join(", ") || "none"}`);
    for (const step of recipe.steps.prepare) run(fill(step), { cwd: tree, env, failCode: 4 });
    if (gatesOnly) break;
    for (const step of recipe.steps.check) {
      if (!typeCheck(step)) {
        run(fill(step), { cwd: tree, env, failCode: 4 });
        continue;
      }
      const argv = fill(step);
      say(`$ ${argv.join(" ")}`);
      const result = spawnSync(argv[0], argv.slice(1), { cwd: tree, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      process.stderr.write(output);
      if (result.error) fail(4, `${argv[0]} could not start: ${result.error.message}`);
      if (result.status === 0) continue;
      const blamed = blame(output, files, left);
      if (!blamed || dropped.length >= recipe.groups.length) fail(4, `${argv.join(" ")} failed: ${output.trim().split("\n")[0] || `exit ${result.status}`}`);
      for (const [name, why] of blamed) {
        dropped.push({ name, ...why });
        say(`left out optional group ${name}: ${why.reason}`);
      }
      // Back to the clean checkout (ignored files, such as the installed dependencies, stay), then again.
      run(["git", "-C", tree, "checkout", "--quiet", "--", "."], { what: "resetting the checkout" });
      run(["git", "-C", tree, "clean", "-fdq"], { what: "resetting the checkout" });
      continue rounds;
    }
    break;
  }
  if (!gatesOnly && !checkOnly) for (const step of recipe.steps.build) run(fill(step), { cwd: tree, env, failCode: 4 });

  if (compile) {
    const out = resolve(a.out);
    mkdirSync(dirname(out), { recursive: true });
    rmSync(out, { force: true });
    run(fill(recipe.compile, out), { cwd: tree, env, what: "compiling" });
    if (a.target.startsWith("darwin") && process.platform === "darwin") run(["codesign", "--force", "--sign", "-", out], { what: "ad-hoc signing" });
  }
  for (const gate of recipe.gates.filter(ours)) run(fill(gate.run), { cwd: tree, env, failCode: 4, what: `gate ${gate.target}` });
  for (const gate of recipe.gates.filter((g) => !ours(g))) say(`gate ${gate.target} not run: group ${gate.group} is left out`);
  if (!compile) {
    say(`${checkOnly ? "checks and gates" : "gates"} passed for Plannotator ${a.version} (${a.target})`);
    const info = { ...carried.base, mode: checkOnly ? "check-only" : "gates-only", applied: carried.applied, omitted: carried.omitted, satisfied: carried.satisfied, features: carried.features };
    process.stdout.write(JSON.stringify(info) + "\n");
    writeReport({ ok: true, ...info });
    if (!a.flags.has("keep") && !a.work) rmSync(work, { recursive: true, force: true });
    return;
  }
  const out = resolve(a.out);
  const native = a.target === HOST;
  const version = native ? checkVersion(out, a.version) : null;
  const info = report(out, { ...carried.base, smoke: version ? "native" : "not runnable here", applied: carried.applied, omitted: carried.omitted, satisfied: carried.satisfied, features: carried.features });
  writeReport({ ok: true, ...info });
  if (!a.flags.has("keep") && !a.work) rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  const code = error instanceof Stop ? error.code : 1;
  const message = error instanceof Error ? error.message : String(error);
  say(message);
  try {
    writeReport({ ok: false, exit: code, error: `orca-build: ${message}`, ...carried.base, applied: carried.applied, omitted: carried.omitted, satisfied: carried.satisfied, features: carried.features });
  } catch {}
  process.exit(code);
});
