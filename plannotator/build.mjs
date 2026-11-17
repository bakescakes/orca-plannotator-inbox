#!/usr/bin/env node
/**
 * Builds the Orca build of Plannotator: one single-file binary for one target. Run by CI and by developers, never on
 * end users' machines. Node built-ins only (plus `git` and `tar` on PATH).
 *
 *   node build.mjs --version 0.28.66 --target darwin-arm64 --out dist/plannotator-orca-darwin-arm64
 *     [--source <plannotator checkout>] [--commit <sha>] [--work <dir>] [--bun <path>] [--gates-only] [--keep]
 *   node build.mjs --check-binary <file> --version 0.28.66
 *
 * Steps: fetch Plannotator's tag (or use --source) and verify its commit; verify every file of this folder against
 * recipe.json; `git apply --check`, then apply, each patch in order; copy the modules and gates; run the build steps;
 * compile for the target; run the gates; run `--version` when the binary runs here; print its sha256 and size.
 *
 * The commit: recipe.json names the one for its own version. Another version needs --commit (CI resolves the tag
 * with `git ls-remote` and passes it), so a moved tag is refused rather than built.
 *
 * Bun: --bun, else $ORCA_BUILD_BUN, else the recipe's pinned Bun for this machine, downloaded from the npm registry
 * and checked against the recipe's sha512 integrity.
 *
 * Output: stdout carries only the final one-line JSON report; every step's output goes to stderr.
 *
 * Exit codes: 0 built; 2 usage; 3 a patch no longer applies; 4 a gate or check failed; 5 the source or a file of this
 * folder does not match the recipe; 1 anything else. A failure prints one line starting with "orca-build: ".
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
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gates-only" || a === "--keep") out.flags.add(a.slice(2));
    else if (/^--(version|target|out|source|commit|work|bun|check-binary)$/.test(a)) {
      if (i + 1 >= argv.length) fail(2, `${a} needs a value`);
      out[a.slice(2)] = argv[++i];
    } else fail(2, `unknown argument ${a}`);
  }
  return out;
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

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
}

function checkVersion(binary, version) {
  const out = run([binary, "--version"], { capture: true, failCode: 4, what: `${binary} --version` }).trim();
  if (out !== `plannotator ${version}`) fail(4, `${binary} --version printed "${out}", not "plannotator ${version}"`);
  return out;
}

function report(binary, extra = {}) {
  const info = { file: resolve(binary), sha256: sha256(binary), size: statSync(binary).size, ...extra };
  process.stdout.write(JSON.stringify(info) + "\n");
}

async function main() {
  const a = args(process.argv.slice(2));
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
    const check = spawnSync("git", ["-C", tree, "apply", "--check", file], { encoding: "utf8" });
    if (check.status !== 0) fail(3, `patch ${patch.name} no longer applies to Plannotator ${a.version}: ${(check.stderr || "").trim().split("\n")[0]}`);
    run(["git", "-C", tree, "apply", file], { failCode: 3, what: `applying ${patch.name}` });
  }
  for (const entry of [...recipe.modules, ...recipe.gates]) {
    const target = join(tree, entry.target);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(HERE, entry.file), target);
  }

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
  for (const gate of recipe.gates) run(fill(gate.run), { cwd: tree, env, failCode: 4, what: `gate ${gate.target}` });
  if (gatesOnly) {
    say(`gates passed for Plannotator ${a.version} (${a.target})`);
    return;
  }
  const out = resolve(a.out);
  const native = a.target === HOST;
  const version = native ? checkVersion(out, a.version) : null;
  report(out, { plannotator: a.version, target: a.target, smoke: version ? "native" : "not runnable here" });
  if (!a.flags.has("keep") && !a.work) rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  if (error instanceof Stop) {
    say(error.message);
    process.exit(error.code);
  }
  say(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
