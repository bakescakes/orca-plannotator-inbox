#!/usr/bin/env node
/**
 * The publishing side of the Orca build workflow (.github/workflows/orca-build.yml). Node built-ins only.
 *
 *   node release.mjs manifest --dir out --version 0.28.67 --build orca.1 --commit <sha> --recipe <sha256>
 *     Reads each target's binary and `<binary>.build.json` (build.mjs's report) from --dir. Every target must have
 *     built, with the same recipe and the same left-out patches and features, and each binary must still match its
 *     report's sha256; else it fails and nothing is published. Writes manifest.json and notes.md to --dir, and prints
 *     `reduced=` and `omitted=` lines (for $GITHUB_OUTPUT).
 *
 *   node release.mjs verdict --dir reports --version 0.28.67 --build-result <result> --windows-result <result>
 *     --publish-result <result> [--tag <tag>]
 *     After the jobs: what the run ended as. Prints one JSON line {kind: full|reduced|failed|none, cause, line}:
 *     `cause` names the patch or gate (or the step) for an issue; `line` is the first error line.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];
export const assetOf = (target) => "plannotator-orca-" + target + (target.startsWith("win32") ? ".exe" : "");
const PLUGIN_MIN = "0.2.0";
const recipe = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "recipe.json"), "utf8"));
/** The features a left-out patch carries (recipe.json), so the notes can say what a reduced build lacks. */
const featuresOf = (name) => recipe.patches.find((p) => p.name === name)?.features ?? [];

function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--[a-z-]+$/.test(argv[i]) || i + 1 >= argv.length) throw Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const names = (omitted) => (omitted ?? []).map((o) => o.name).sort();

/** The manifest and release notes for one build, or an error when the targets disagree or a binary changed. */
export function manifest(dir, { version, build, commit, recipe }) {
  const assets = {};
  const reports = {};
  for (const target of TARGETS) {
    const name = assetOf(target);
    const reportFile = join(dir, name + ".build.json");
    if (!existsSync(reportFile) || !existsSync(join(dir, name))) throw Error(`${target} has no build`);
    const report = readJson(reportFile);
    if (report.ok !== true) throw Error(`${target} did not build: ${report.error ?? "no error line"}`);
    if (report.plannotator !== version || report.target !== target) throw Error(`${name}'s report is for ${report.plannotator} ${report.target}`);
    if (recipe && report.recipe !== recipe) throw Error(`${target} was built from recipe ${report.recipe}, not ${recipe}`);
    const bytes = readFileSync(join(dir, name));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (report.sha256 !== sha256) throw Error(name + " changed between its build and publishing");
    assets[target] = { name, sha256, size: bytes.length };
    reports[target] = report;
  }
  const first = reports[TARGETS[0]];
  for (const target of TARGETS.slice(1)) {
    const r = reports[target];
    if (JSON.stringify(names(r.omitted)) !== JSON.stringify(names(first.omitted)))
      throw Error(`the targets left out different patches: ${TARGETS[0]} ${JSON.stringify(names(first.omitted))}, ${target} ${JSON.stringify(names(r.omitted))}`);
    if (JSON.stringify(r.features) !== JSON.stringify(first.features)) throw Error(`the targets carry different features: ${TARGETS[0]} ${JSON.stringify(first.features)}, ${target} ${JSON.stringify(r.features)}`);
  }
  const omitted = names(first.omitted);
  const result = { v: 1, plannotator: version, build, pluginMin: PLUGIN_MIN, assets, features: [...first.features], omitted, recipe: first.recipe };
  const lacking = [...new Set(omitted.flatMap(featuresOf))].filter((f) => !first.features.includes(f));
  const why = (first.omitted ?? []).map((o) => `- \`${o.name}\` (${featuresOf(o.name).join(", ") || "no feature"}): ${o.forced ? "left out on purpose (--without)" : "no longer applies to this Plannotator release"} (${o.reason}).`);
  const notes = [
    `The Orca build of Plannotator ${version} (upstream commit ${commit}), for the Orca plugin. See manifest.json for each binary's sha256.`,
    "",
    omitted.length
      ? [`**A reduced build.** It lacks ${lacking.join(", ") || "nothing it serves"}: it leaves out ${omitted.length === 1 ? "one optional Orca change" : "some optional Orca changes"}. The plugin works with it and says what is missing.`, "", ...why, "", `Features it serves: ${result.features.join(", ")}.`].join("\n")
      : `A full build: every Orca change is in it. Features: ${result.features.join(", ")}.`,
    "",
    `Recipe ${first.recipe}.`,
  ].join("\n");
  return { manifest: result, notes: notes.trimEnd() + "\n" };
}

/** What a run ended as, from the build reports and the jobs' results. */
export function verdict(dir, { version, tag, buildResult, windowsResult, publishResult }) {
  const reports = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".build.json"))
        .map((f) => readJson(join(dir, f)))
    : [];
  if (publishResult === "success") {
    const r = reports.find((x) => x.ok === true);
    const omitted = r?.omitted ?? [];
    if (omitted.length === 0) return { kind: "full", cause: null, line: `${tag} is a full build.` };
    return { kind: "reduced", cause: "left-out:" + names(omitted).join(","), line: omitted.map((o) => `${o.name}: ${o.reason}`).join("; ") };
  }
  const failed = reports.filter((x) => x.ok === false).sort((a, b) => (a.exit === 3 ? -1 : 0) - (b.exit === 3 ? -1 : 0));
  if (failed.length) {
    const error = String(failed[0].error ?? "orca-build: failed").split("\n")[0];
    const patch = /patch (\S+) no longer applies/.exec(error);
    const gate = /gate (\S+) failed/.exec(error);
    const cause = patch ? "patch:" + patch[1] : gate ? "gate:" + gate[1] : "build:" + (failed[0].exit ?? 1);
    return { kind: "failed", cause, line: `${failed[0].target ?? "a target"}: ${error}` };
  }
  const ok = reports.filter((x) => x.ok === true);
  const sets = new Set(ok.map((x) => JSON.stringify(names(x.omitted))));
  if (sets.size > 1) return { kind: "failed", cause: "targets-disagree", line: `The targets left out different patches: ${[...sets].join(" vs ")}.` };
  if (buildResult !== "success") {
    const missing = TARGETS.filter((t) => !ok.some((x) => x.target === t));
    return { kind: "failed", cause: "build", line: `No build report from ${missing.join(", ") || "a target"}: the job failed or was cancelled before build.mjs wrote one.` };
  }
  if (windowsResult !== "success") return { kind: "failed", cause: "windows-check", line: "The gates on Windows or the --version smoke of the Windows binary failed." };
  if (publishResult === "skipped" || publishResult === "cancelled") return { kind: "none", cause: null, line: `Publishing was ${publishResult}.` };
  return { kind: "failed", cause: "publish", line: "Publishing failed after every target built and passed." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    const o = options(rest);
    if (command === "manifest") {
      const { manifest: m, notes } = manifest(o.dir, { version: o.version, build: o.build, commit: o.commit, recipe: o.recipe });
      writeFileSync(join(o.dir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
      writeFileSync(join(o.dir, "notes.md"), notes);
      process.stderr.write(JSON.stringify(m) + "\n");
      process.stdout.write(`reduced=${m.omitted.length > 0}\nomitted=${m.omitted.join(",")}\nfeatures=${m.features.join(",")}\n`);
    } else if (command === "verdict") {
      const v = verdict(o.dir, { version: o.version, tag: o.tag, buildResult: o["build-result"], windowsResult: o["windows-result"], publishResult: o["publish-result"] });
      process.stdout.write(JSON.stringify(v) + "\n");
    } else throw Error("usage: release.mjs manifest|verdict --option value ...");
  } catch (error) {
    process.stderr.write(`orca-release: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
