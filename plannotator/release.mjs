#!/usr/bin/env node
/**
 * The publishing side of the Orca build workflow (.github/workflows/orca-build.yml). Node built-ins only.
 *
 *   node release.mjs manifest --dir out --version 0.28.67 --build orca.1 --commit <sha> --recipe <sha256>
 *     Reads each target's binary and `<binary>.build.json` (build.mjs's report) from --dir. Every target must have
 *     built, with the same recipe and the same left-out groups and features, and each binary must still match its
 *     report's sha256; else it fails and nothing is published. Writes manifest.json and notes.md to --dir, and prints
 *     `reduced=` and `omitted=` lines (for $GITHUB_OUTPUT).
 *
 *   node release.mjs verdict --dir reports --version 0.28.67 --build-result <result> --windows-result <result>
 *     --publish-result <result> [--tag <tag>]
 *     After the jobs: what the run ended as. Prints one JSON line {kind: full|reduced|failed|none, cause, line}:
 *     `cause` names the group or gate (or the step) for an issue; `line` is the first error line.
 *
 *   node release.mjs main --dir report --head <sha> --base <sha or tag> --upstream owner/repo [--run <url>]
 *     The daily check against upstream's main (.github/workflows/orca-build-main.yml): reads `fit.json` (build.mjs
 *     --fit) and `check.json` (build.mjs --check-only --report) from --dir. Prints one JSON line {kind: fits|reduced|
 *     broken|unknown, key, line, title, body}: `key` changes only when what no longer fits changes; `body` is the
 *     issue's text. `unknown` means the check itself did not run to an answer (a download failed, say).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];
export const assetOf = (target) => "plannotator-orca-" + target + (target.startsWith("win32") ? ".exe" : "");
const PLUGIN_MIN = "0.2.0";
const recipe = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "recipe.json"), "utf8"));
/** The features a left-out group carries (recipe.json), so the notes can say what a reduced build lacks. */
const featuresOf = (name) => recipe.groups.find((g) => g.name === name)?.features ?? [];
const knownGroup = (name) => recipe.groups.some((g) => g.name === name);
const knownFeature = (name) => recipe.groups.some((g) => g.features.includes(name));
const knownGate = (file) => recipe.gates.some((g) => g.target === file);
/** Every edit the recipe has, as `group/id`: the only edit names a report may give back. */
const EDIT_NAMES = new Set(
  recipe.groups.flatMap((g) => {
    try {
      const data = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), g.file), "utf8"));
      return (Array.isArray(data.edits) ? data.edits : []).map((e) => `${g.name}/${e.id}`);
    } catch {
      return [];
    }
  }),
);
/** A report's `satisfied` (the edits Plannotator makes itself): only names the recipe has, sorted, once each. */
const satisfiedOf = (list) => [...new Set((Array.isArray(list) ? list : []).filter((n) => typeof n === "string" && EDIT_NAMES.has(n)))].sort();

/**
 * Text that came from a build report (and so may hold upstream's words), made safe to place anywhere: one line, no
 * control characters, no backticks (so it cannot end a code span), no `<!` or `-->` (so it can neither open nor close
 * an HTML comment, nor pass for an issue's marker), at most 300 characters.
 */
const plain = (text) =>
  String(text ?? "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replaceAll("`", "'")
    .replace(/\s+/g, " ")
    .replaceAll("<!", "\u2039!")
    .replace(/-+>/g, (arrow) => arrow.slice(0, -1) + "\u203a")
    .trim()
    .slice(0, 300);
/** Such text in Markdown: one code span, never a mention, a link, an HTML comment or a table break. */
const code = (text) => "`" + plain(text).replaceAll("|", "\\|") + "`";

function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--[a-z-]+$/.test(argv[i]) || i + 1 >= argv.length) throw Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const names = (omitted) => (Array.isArray(omitted) ? omitted : []).map((o) => String(o?.name)).sort();

/** The manifest and release notes for one build, or an error when the targets disagree or a binary changed. */
export function manifest(dir, { version, build, commit, recipe }) {
  const assets = {};
  const reports = {};
  for (const target of TARGETS) {
    const name = assetOf(target);
    const reportFile = join(dir, name + ".build.json");
    if (!existsSync(reportFile) || !existsSync(join(dir, name))) throw Error(`${target} has no build`);
    const report = readJson(reportFile);
    if (report.ok !== true) throw Error(`${target} did not build: ${plain(report.error ?? "no error line")}`);
    if (report.plannotator !== version || report.target !== target) throw Error(`${name}'s report is for ${plain(report.plannotator)} ${plain(report.target)}`);
    if (recipe && report.recipe !== recipe) throw Error(`${target} was built from recipe ${plain(report.recipe)}, not ${recipe}`);
    const bytes = readFileSync(join(dir, name));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (report.sha256 !== sha256) throw Error(name + " changed between its build and publishing");
    assets[target] = { name, sha256, size: bytes.length };
    // Reports come from jobs that ran upstream's build steps: only names the recipe knows may reach
    // $GITHUB_OUTPUT, the manifest or the notes.
    const strange = [...(report.omitted ?? []).map((o) => o?.name).filter((n) => !knownGroup(n)), ...(Array.isArray(report.features) ? report.features : [null]).filter((f) => !knownFeature(f))];
    if ((report.satisfied ?? []).some((n) => !EDIT_NAMES.has(n))) strange.push("satisfied");
    if (strange.length) throw Error(`${name}'s report names groups or features the recipe does not have`);
    reports[target] = report;
  }
  const first = reports[TARGETS[0]];
  for (const target of TARGETS.slice(1)) {
    const r = reports[target];
    if (JSON.stringify(names(r.omitted)) !== JSON.stringify(names(first.omitted)))
      throw Error(`the targets left out different groups: ${TARGETS[0]} ${JSON.stringify(names(first.omitted))}, ${target} ${JSON.stringify(names(r.omitted))}`);
    if (JSON.stringify(r.features) !== JSON.stringify(first.features)) throw Error(`the targets carry different features: ${TARGETS[0]} ${JSON.stringify(first.features)}, ${target} ${JSON.stringify(r.features)}`);
    if (JSON.stringify(satisfiedOf(r.satisfied)) !== JSON.stringify(satisfiedOf(first.satisfied))) throw Error(`the targets found different edits made by Plannotator itself`);
  }
  const satisfied = satisfiedOf(first.satisfied);
  const omitted = names(first.omitted);
  const result = { v: 1, plannotator: version, build, pluginMin: PLUGIN_MIN, assets, features: [...first.features], omitted, satisfied, recipe: first.recipe };
  const lacking = [...new Set(omitted.flatMap(featuresOf))].filter((f) => !first.features.includes(f));
  const why = (first.omitted ?? []).map((o) => `- \`${o.name}\` (${featuresOf(o.name).join(", ") || "no feature"}): ${o.forced ? "left out on purpose (--without)" : "no longer fits this Plannotator release"}: ${code(o.reason)}.`);
  const notes = [
    `The Orca build of Plannotator ${version} (upstream commit ${commit}), for the Orca plugin. See manifest.json for each binary's sha256.`,
    "",
    omitted.length
      ? [`**A reduced build.** It lacks ${lacking.join(", ") || "no feature the plugin reads"}: it leaves out ${omitted.length === 1 ? "one optional group of Orca edits" : "some optional groups of Orca edits"}. The plugin works with it and says what is missing.`, "", ...why, "", `Features it serves: ${result.features.join(", ")}.`].join("\n")
      : `A full build: every Orca change is in it. Features: ${result.features.join(", ")}.`,
    ...(satisfied.length
      ? ["", `Plannotator makes ${satisfied.length === 1 ? "one of these changes" : `${satisfied.length} of these changes`} itself now, so the build leaves ${satisfied.length === 1 ? "that line" : "those lines"} as Plannotator has ${satisfied.length === 1 ? "it" : "them"}: ${satisfied.map((n) => "`" + n + "`").join(", ")}.`]
      : []),
    "",
    `Recipe ${first.recipe}.`,
    "",
    "This is Plannotator with a few changes for Orca, kept in this repository under `plannotator/`. Plannotator is by backnotprop and is licensed MIT or Apache-2.0; both license texts are attached as LICENSE-MIT and LICENSE-APACHE.",
  ].join("\n");
  return { manifest: result, notes: notes.trimEnd() + "\n" };
}

/**
 * What a run ended as, from the build reports and the jobs' results. Its line goes into an issue and the run's
 * summary, so whatever branch wrote it, it leaves through `plain`.
 */
export function verdict(dir, inputs) {
  const result = verdictOf(dir, inputs);
  return { ...result, line: plain(result.line) };
}

function verdictOf(dir, { version, tag, buildResult, windowsResult, publishResult }) {
  const reports = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".build.json"))
        .map((f) => readJson(join(dir, f)))
    : [];
  if (publishResult === "success") {
    const r = reports.find((x) => x.ok === true);
    const omitted = r?.omitted ?? [];
    if (omitted.length === 0) return { kind: "full", cause: null, line: `${tag} is a full build.` };
    const known = omitted.filter((o) => knownGroup(o?.name));
    return { kind: "reduced", cause: "left-out:" + (names(known).join(",") || "unknown"), line: plain(known.map((o) => `${o.name}: ${plain(o.reason)}`).join("; ")) };
  }
  const failed = reports.filter((x) => x.ok === false).sort((a, b) => (a.exit === 3 ? -1 : 0) - (b.exit === 3 ? -1 : 0));
  if (failed.length) {
    const error = String(failed[0].error ?? "orca-build: failed").split("\n")[0];
    // The cause goes into an issue's title and marker: only a group or gate the recipe has, or the exit code.
    const group = /^orca-build: (?:required )?group ([a-z0-9-]+) no longer fits/.exec(error);
    const gate = /^orca-build: (?:gate )?(tests\/[A-Za-z0-9._-]+) failed/.exec(error);
    const exit = Number.isInteger(failed[0].exit) ? failed[0].exit : 1;
    const cause = group && knownGroup(group[1]) ? "group:" + group[1] : gate && knownGate(gate[1]) ? "gate:" + gate[1] : "build:" + exit;
    const target = TARGETS.includes(failed[0].target) ? failed[0].target : "a target";
    return { kind: "failed", cause, line: plain(`${target}: ${error}`) };
  }
  const ok = reports.filter((x) => x.ok === true);
  // Only groups the recipe has are named: a report's other words stay out of the issue.
  const left = (x) => names(x.omitted).filter(knownGroup).join(", ") || "none the recipe has";
  const sets = new Set(ok.map((x) => JSON.stringify(names(x.omitted))));
  if (sets.size > 1) return { kind: "failed", cause: "targets-disagree", line: `The targets left out different groups: ${[...new Set(ok.map(left))].join(" vs ")}.` };
  if (buildResult !== "success") {
    const missing = TARGETS.filter((t) => !ok.some((x) => x.target === t));
    return { kind: "failed", cause: "build", line: `No build report from ${missing.join(", ") || "a target"}: the job failed or was cancelled before build.mjs wrote one.` };
  }
  if (windowsResult !== "success") return { kind: "failed", cause: "windows-check", line: "The gates on Windows or the --version smoke of the Windows binary failed." };
  if (publishResult === "skipped" || publishResult === "cancelled") return { kind: "none", cause: null, line: `Publishing was ${publishResult}.` };
  return { kind: "failed", cause: "publish", line: "Publishing failed after every target built and passed." };
}

/** The daily check's issue key: the only shapes it can have (the workflow reads it back with the same pattern). */
export const KEY = /^(?:fits|unknown|(?:reduced|broken):[0-9a-f]{16})$/;

/** What the daily check against upstream's main found, and the issue's text for it. */
export function mainVerdict(dir, { head, base, upstream, run }) {
  // The reports come from a job that ran upstream's code: read as data, and only names the recipe knows are kept.
  const read = (name) => {
    try {
      return existsSync(join(dir, name)) ? readJson(join(dir, name)) : null;
    } catch {
      return null;
    }
  };
  const fit = read("fit.json"), check = read("check.json");
  const known = (name) => recipe.groups.find((g) => g.name === name);
  const misfits = (Array.isArray(fit?.groups) ? fit.groups : [])
    .filter((g) => known(g?.name) && Array.isArray(g.edits))
    .flatMap((g) => g.edits.filter((e) => e && e.fits === false && typeof e.id === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(e.id) && e.id.length <= 64).map((e) => ({ group: g.name, required: known(g.name).required, edit: `${g.name}/${e.id}`, file: plain(e.file), why: plain(e.why) })));
  // Where the issue's links point: only shapes these can have, else none.
  if (!/^[0-9a-f]{40}$|^v\d+\.\d+\.\d+$/.test(String(base))) base = recipe.plannotator.tag;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(upstream))) upstream = "backnotprop/plannotator";
  if (!/^https:\/\/[A-Za-z0-9._~:/?#@!$&'*+,;=%-]+$/.test(String(run ?? "")) || /[()]/.test(String(run))) run = "";
  const short = String(head).slice(0, 12);
  // The edits Plannotator's main makes itself: from the check's report, else from --fit; names the recipe has only.
  const upstreamHas = satisfiedOf(
    Array.isArray(check?.satisfied)
      ? check.satisfied
      : (Array.isArray(fit?.groups) ? fit.groups : []).filter((g) => known(g?.name) && Array.isArray(g.edits)).flatMap((g) => g.edits.filter((e) => e?.satisfied === true).map((e) => `${g.name}/${e.id}`)),
  );
  const itself = upstreamHas.length ? ` Plannotator makes ${upstreamHas.length} of the edits itself now: ${upstreamHas.join(", ")}.` : "";
  let kind, line;
  if (!/^[0-9a-f]{40}$/.test(String(head))) {
    kind = "unknown";
    line = "No upstream head was read.";
  } else if (!check) {
    kind = "unknown";
    line = "The check wrote no report.";
  } else if (check.ok === false) {
    const error = plain(check.error ?? "orca-build: failed");
    // An edit that does not fit (3) or a check or gate that fails on the edited source (4) is a break; anything else
    // (a download, the checkout, the runner) says nothing about the edits.
    const edits = check.exit === 3 || (check.exit === 4 && !/\binstall\b|sync-manifest|could not start/.test(error));
    kind = edits ? "broken" : "unknown";
    line = error;
  } else if (Array.isArray(check.omitted) && check.omitted.length > 0) {
    kind = "reduced";
    line = plain(check.omitted.filter((o) => known(o?.name)).map((o) => `${o.name}: ${plain(o.reason)}`).join("; ")) || "Some edits were left out.";
  } else {
    kind = misfits.length ? "reduced" : "fits";
    line = kind === "fits" ? `Every edit fits ${short} and its checks and gates pass.${itself}` : "Some edits do not fit.";
  }
  const left = (Array.isArray(check?.omitted) ? check.omitted : []).map((o) => o?.name).filter(known).sort();
  // The key says what no longer fits, so a change gets a comment. It goes into an HTML comment, so it holds no
  // upstream text: the kind and a hash of the edits, the groups left out and (for a break) its line without numbers.
  const found = JSON.stringify([misfits.map((m) => m.edit).sort(), left, kind === "broken" ? line.replace(/\d+/g, "#") : ""]);
  const key = kind === "fits" || kind === "unknown" ? kind : `${kind}:${createHash("sha256").update(found).digest("hex").slice(0, 16)}`;
  if (!KEY.test(key)) throw Error("the issue key has an unexpected shape");
  const what = left.length ? left.join(", ") : misfits.length ? [...new Set(misfits.map((m) => m.group))].join(", ") : "a check";
  const title = kind === "broken" ? `Orca build edits break on Plannotator main: ${what}` : `Orca build edits no longer all fit Plannotator main: ${what} left out`;
  const compare = `https://github.com/${upstream}/compare/${base}...${head}`;
  const lacking = [...new Set(left.flatMap(featuresOf))];
  const body = [
    kind === "broken"
      ? "Plannotator's `main` breaks the Orca build: a release made from it now would publish no Orca build."
      : `Plannotator's \`main\` no longer takes every Orca edit: a release made from it now would publish a reduced Orca build, without ${lacking.join(", ") || "some optional edits"}.`,
    "Nothing was built or published; this check only looks ahead, so the edits can be refitted before the release.",
    "",
    `- Upstream main: [${short}](https://github.com/${upstream}/commit/${head})`,
    `- Commits since main last took every edit: ${compare}`,
    `- Result: ${code(line)}`,
    ...(run ? [`- Run: ${run}`] : []),
    ...(upstreamHas.length ? [`- Made by Plannotator itself now (left as it has them): ${upstreamHas.map((n) => "`" + n + "`").join(", ")}`] : []),
    "",
    ...(misfits.length
      ? ["| Edit | Group | File | What it found |", "|---|---|---|---|", ...misfits.slice(0, 50).map((m) => `| ${code(m.edit)} | ${m.group}${m.required ? " (required)" : ""} | ${code(m.file)} | ${code(m.why)} |`), ""]
      : []),
    "To refit: check out that commit, run `node plannotator/build.mjs --fit <checkout>` to list each edit that does not fit and what it found, change the edit in `plannotator/edits/<group>.json` (a new anchor, or the token it now has to change), update its sha256 in `recipe.json`, and build. An edit that relies on something upstream changed in meaning is refused on purpose: refit what it inserts, not only its anchor.",
    "",
    "Each daily check updates this issue, comments when what breaks changes, and closes it when main takes every edit again.",
    "",
    `<!-- orca-build-main key=${key} -->`,
  ].join("\n");
  return { kind, key, line, summary: `${kind}: ${code(line)}`, title: title.slice(0, 200), body: body + "\n", head };
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
    } else if (command === "main") {
      process.stdout.write(JSON.stringify(mainVerdict(o.dir, { head: o.head, base: o.base, upstream: o.upstream, run: o.run })) + "\n");
    } else if (command === "verdict") {
      const v = verdict(o.dir, { version: o.version, tag: o.tag, buildResult: o["build-result"], windowsResult: o["windows-result"], publishResult: o["publish-result"] });
      process.stdout.write(JSON.stringify(v) + "\n");
    } else throw Error("usage: release.mjs manifest|verdict|main --option value ...");
  } catch (error) {
    process.stderr.write(`orca-release: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
