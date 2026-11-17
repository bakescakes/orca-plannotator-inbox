#!/usr/bin/env node
/**
 * Builds the Orca build of Plannotator: one single-file binary for one target. Run by CI and by developers, never on
 * end users' machines. Node built-ins only (plus `git` and `tar` on PATH).
 *
 *   node build.mjs --version 0.28.67 --target darwin-arm64 --out dist/plannotator-orca-darwin-arm64
 *     [--source <plannotator checkout>] [--commit <sha>] [--work <dir>] [--bun <path>] [--without <patch>]...
 *     [--gates-only] [--keep]
 *   node build.mjs --check-binary <file> --version 0.28.67
 *   node build.mjs --recipe-hash
 *
 * Steps: fetch Plannotator's tag (or use --source) and verify its commit; verify every file of this folder against
 * recipe.json; `git apply --check`, then apply, each patch in order; copy the modules and gates; write the build's
 * own list of what it carries (the recipe's generated module); run the build steps; compile for the target; run the
 * gates; run `--version` when the binary runs here; print its sha256, size and what it carries.
 *
 * Optional patches: a patch the recipe marks `"required": false` that no longer applies is left out, with the modules
 * and gates that name it (`"patch"`), and the build goes on without the features it carries. `--without <patch>`
 * (repeatable) leaves one out on purpose. A required patch that no longer applies stops the build (exit 3).
 * The build's report, on stdout and in `<out>.build.json`, names the patches applied, the patches left out (each with
 * why: the first line of git's error, or `--without`) and the final `features` list. A failed build writes
 * `<out>.build.json` too, with `ok: false`, its exit code and its error line.
 *
 * `--recipe-hash` prints the sha256 of what decides a build's content here (recipe.json and this script), so a
 * published build can say which recipe made it.
 *
 * The commit: recipe.json names the one for its own version. Another version needs --commit (CI resolves the tag
 * with `git ls-remote` and passes it), so a moved tag is refused rather than built.
 *
 * Bun: --bun, else $ORCA_BUILD_BUN, else the recipe's pinned Bun for this machine, downloaded from the npm registry
 * and checked against the recipe's sha512 integrity.
 *
 * Output: stdout carries only the final one-line JSON report; every step's output goes to stderr.
 *
 * Exit codes: 0 built (a reduced build too); 2 usage; 3 a required patch no longer applies; 4 a gate or check failed;
 * 5 the source or a file of this folder does not match the recipe; 1 anything else. A failure prints one line
 * starting with "orca-build: ".
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
    if (a === "--gates-only" || a === "--keep" || a === "--recipe-hash") out.flags.add(a.slice(2));
    else if (a === "--without") {
      if (i + 1 >= argv.length) fail(2, `${a} needs a value`);
      out.without.push(argv[++i]);
    } else if (/^--(version|target|out|source|commit|work|bun|check-binary)$/.test(a)) {
      if (i + 1 >= argv.length) fail(2, `${a} needs a value`);
      out[a.slice(2)] = argv[++i];
    } else fail(2, `unknown argument ${a}`);
  }
  return out;
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** What decides a build's content here: recipe.json (which pins every patch, module and gate) and this script. */
function recipeHash() {
  const hash = createHash("sha256");
  for (const name of ["recipe.json", "build.mjs"]) hash.update(name + "\0" + readFileSync(join(HERE, name), "utf8").replaceAll("\r\n", "\n") + "\0");
  return hash.digest("hex");
}

/** The generated module: the features and left-out patches of one build (the repo's copy is the full build's). */
const BUILD_INFO = recipe.modules.find((entry) => entry.generated === "build-info");
function buildInfoText(features, omitted) {
  return [
    "/**",
    " * What this Orca build of Plannotator carries. Written by build.mjs from recipe.json for each build: the copy in the",
    " * Orca plugin's build folder is a full build's, and build.mjs refuses to build when it differs from that.",
    " * `features`: what `GET /api/inbox/orca` serves. `omitted`: the optional patches this build left out.",
    " */",
    `export const ORCA_BUILD: { readonly features: readonly string[]; readonly omitted: readonly string[] } = {`,
    `  features: ${JSON.stringify(features)},`,
    `  omitted: ${JSON.stringify(omitted)},`,
    "};",
    "",
  ].join("\n");
}
const allFeatures = () => recipe.patches.flatMap((patch) => patch.features ?? []);

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

function verifyFolder() {
  for (const entry of [...recipe.patches, ...recipe.modules, ...recipe.gates]) {
    const path = join(HERE, entry.file);
    if (!existsSync(path)) fail(5, `${entry.file} is missing`);
    if (sha256(path) !== entry.sha256) fail(5, `${entry.file} does not match recipe.json (update its sha256 deliberately)`);
  }
  const names = new Set(recipe.patches.map((patch) => patch.name));
  for (const patch of recipe.patches) if (typeof patch.required !== "boolean" || !Array.isArray(patch.features)) fail(5, `patch ${patch.name} needs "required" and "features" in recipe.json`);
  for (const entry of [...recipe.modules, ...recipe.gates]) if (entry.patch !== undefined && !names.has(entry.patch)) fail(5, `${entry.file} names an unknown patch ${entry.patch}`);
  for (const entry of [...recipe.modules, ...recipe.gates]) if (entry.patch !== undefined && recipe.patches.find((p) => p.name === entry.patch).required) fail(5, `${entry.file} is tied to required patch ${entry.patch}; tie only optional ones`);
  if (!BUILD_INFO) fail(5, `recipe.json has no generated "build-info" module`);
  // No drift: the repo's copy is exactly what a full build writes, so the source reads the same list the recipe has.
  if (readFileSync(join(HERE, BUILD_INFO.file), "utf8").replaceAll("\r\n", "\n") !== buildInfoText(allFeatures(), [])) fail(5, `${BUILD_INFO.file} is not the full build's list of features in recipe.json (regenerate it)`);
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
const carried = { reportFile: null, base: {}, applied: [], omitted: [], features: [] };
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
  if (!a.version || !/^\d+\.\d+\.\d+$/.test(a.version)) fail(2, "--version x.y.z is required");
  if (!a.target || !TARGETS[a.target]) fail(2, `--target must be one of ${Object.keys(TARGETS).join(", ")}`);
  const gatesOnly = a.flags.has("gates-only");
  if (!gatesOnly && !a.out) fail(2, "--out <file> is required");
  const expected = a.commit ?? (a.version === recipe.plannotator.version ? recipe.plannotator.commit : null);
  if (!expected || !/^[0-9a-f]{40}$/.test(expected)) fail(5, `recipe.json pins ${recipe.plannotator.version}; pass --commit <40-hex sha> for ${a.version}`);
  for (const name of a.without) {
    const patch = recipe.patches.find((p) => p.name === name);
    if (!patch) fail(2, `--without ${name}: no such patch (${recipe.patches.map((p) => p.name).join(", ")})`);
    if (patch.required) fail(2, `--without ${name}: that patch is required`);
  }
  if (a.out) carried.reportFile = resolve(a.out) + ".build.json";
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

  for (const patch of recipe.patches) {
    const file = join(HERE, patch.file);
    if (a.without.includes(patch.name)) {
      carried.omitted.push({ name: patch.name, reason: "left out with --without", forced: true });
      say(`left out patch ${patch.name} (--without); without it: ${patch.features.join(", ") || "no feature"}`);
      continue;
    }
    const check = spawnSync("git", ["-C", tree, "apply", "--check", file], { encoding: "utf8" });
    if (check.status !== 0) {
      const why = (check.stderr || check.stdout || `git apply exited ${check.status}`).trim().split("\n")[0];
      if (patch.required) fail(3, `patch ${patch.name} no longer applies to Plannotator ${a.version}: ${why}`);
      carried.omitted.push({ name: patch.name, reason: why, forced: false });
      say(`left out optional patch ${patch.name}, which no longer applies to Plannotator ${a.version}: ${why}`);
      continue;
    }
    run(["git", "-C", tree, "apply", file], { failCode: 3, what: `applying ${patch.name}` });
    carried.applied.push(patch.name);
  }
  const left = new Set(carried.omitted.map((o) => o.name));
  carried.features = recipe.patches.filter((patch) => !left.has(patch.name)).flatMap((patch) => patch.features);
  const ours = (entry) => entry.patch === undefined || !left.has(entry.patch);
  for (const entry of [...recipe.modules, ...recipe.gates].filter(ours)) {
    const target = join(tree, entry.target);
    mkdirSync(dirname(target), { recursive: true });
    if (entry === BUILD_INFO) writeFileSync(target, buildInfoText(carried.features, [...left]));
    else copyFileSync(join(HERE, entry.file), target);
  }
  say(`patches applied: ${carried.applied.join(", ") || "none"}; left out: ${[...left].join(", ") || "none"}; features: ${carried.features.join(", ") || "none"}`);

  // Build steps in an environment that keeps PATH but not the person's Plannotator or Orca settings.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(PLANNOTATOR_|NODE_OPTIONS$|BUN_OPTIONS$)/.test(key)) delete env[key];
  const home = join(work, "home");
  mkdirSync(home, { recursive: true });
  Object.assign(env, { HOME: home, USERPROFILE: home, PLANNOTATOR_DATA_DIR: join(work, "data"), BUN_INSTALL_CACHE_DIR: join(work, "bun-cache"), PATH: dirname(bun) + (process.platform === "win32" ? ";" : ":") + env.PATH });
  // Plannotator's UI build needs more memory than Node allows itself where its own limit is 2 GB (an Intel Mac runner).
  env.NODE_OPTIONS = "--max-old-space-size=6144";
  const fill = (argv, out) => argv.map((part) => part.replaceAll("{bun}", bun).replaceAll("{version}", a.version).replaceAll("{bunTarget}", TARGETS[a.target]).replaceAll("{out}", out ?? ""));
  const steps = gatesOnly ? recipe.steps.prepare : [...recipe.steps.prepare, ...recipe.steps.check, ...recipe.steps.build];
  for (const step of steps) run(fill(step), { cwd: tree, env, failCode: 4 });

  if (!gatesOnly) {
    const out = resolve(a.out);
    mkdirSync(dirname(out), { recursive: true });
    rmSync(out, { force: true });
    run(fill(recipe.compile, out), { cwd: tree, env, what: "compiling" });
    if (a.target.startsWith("darwin") && process.platform === "darwin") run(["codesign", "--force", "--sign", "-", out], { what: "ad-hoc signing" });
  }
  for (const gate of recipe.gates.filter(ours)) run(fill(gate.run), { cwd: tree, env, failCode: 4, what: `gate ${gate.target}` });
  for (const gate of recipe.gates.filter((g) => !ours(g))) say(`gate ${gate.target} not run: patch ${gate.patch} is left out`);
  if (gatesOnly) {
    say(`gates passed for Plannotator ${a.version} (${a.target})`);
    return;
  }
  const out = resolve(a.out);
  const native = a.target === HOST;
  const version = native ? checkVersion(out, a.version) : null;
  const info = report(out, { ...carried.base, smoke: version ? "native" : "not runnable here", applied: carried.applied, omitted: carried.omitted, features: carried.features });
  writeReport({ ok: true, ...info });
  if (!a.flags.has("keep") && !a.work) rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  const code = error instanceof Stop ? error.code : 1;
  const message = error instanceof Error ? error.message : String(error);
  say(message);
  try {
    writeReport({ ok: false, exit: code, error: `orca-build: ${message}`, ...carried.base, applied: carried.applied, omitted: carried.omitted, features: carried.features });
  } catch {}
  process.exit(code);
});
