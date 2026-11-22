/**
 * The Orca build's edits to Plannotator's own files, applied by content rather than by line number. Node built-ins
 * only; build.mjs uses it, and so do the plugin's tests.
 *
 * An edit file (`edits/<group>.json`) is `{"v":1,"edits":[…]}`. Each edit:
 *
 *   {"id": "run-line-open-in",            a name, unique in its file, that a failure report gives
 *    "file": "packages/server/x.ts",      the upstream file it changes
 *    "anchor": "const runOfRoot = (",     the line it works on: the lines that contain this text. An array finds the
 *                                         first text, then each next text on the first line after it that has it
 *                                         (within 40 lines); the edit works on the last line found
 *    "count": 1,                          how many lines the first text must be on (default 1); any other number
 *                                         refuses the edit
 *    "has": ["children"],                 text the line must also have, so a change in meaning refuses the edit
 *    "replace": [["from", "to"], …],      in that line, `from` (exactly once) becomes `to`
 *    "before": ["line", …],               lines put before it, or
 *    "after": ["line", …]}                after it, each indented by that line's own indentation
 *
 * Matching ignores indentation and whatever else is on the line, and sees only Plannotator's own lines: never a line
 * another edit put in. Edits that put lines at the same place stack in the order they are applied.
 *
 * It fails closed. An edit is refused, with what was found, when its anchor is missing or on more or fewer lines
 * than `count`, when the line lacks a `has` text, when `from` is not on the line exactly once, or when the line
 * already carries the change (a `to` already on it, or the lines already there): never guessed, never applied twice.
 * After each edit, the same edit is tried once more on the result and must be refused; an edit that would apply
 * twice is a broken recipe.
 *
 * A group of edits applies whole or not at all (`applyGroup`); `applyGroups` takes the recipe's groups in order, leaves
 * out an optional group that does not fit (and any group that needs it), and stops at a required one. Each line an edit changed or put in remembers which
 * edit did (`editedLines`), so an error a type check reports on that line can be laid on its group.
 */

const WITHIN = 40;
const KEYS = new Set(["id", "file", "anchor", "count", "has", "replace", "before", "after"]);

export class EditRefused extends Error {
  constructor(edit, why) {
    super(why);
    this.edit = edit;
    this.why = why;
  }
}

const isText = (value) => typeof value === "string" && !value.includes("\n") && !value.includes("\r");
const isLines = (value) => Array.isArray(value) && value.length > 0 && value.every(isText);

/** An edit file's edits, checked against the format; throws with what is wrong. */
export function parseEdits(text, name = "edits") {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw Error(`${name} is not JSON: ${error.message}`);
  }
  if (!data || data.v !== 1 || !Array.isArray(data.edits) || data.edits.length === 0) throw Error(`${name} needs {"v":1,"edits":[…]}`);
  const ids = new Set();
  for (const [i, edit] of data.edits.entries()) {
    const where = `${name} edit ${edit && typeof edit.id === "string" ? edit.id : "#" + (i + 1)}`;
    if (!edit || typeof edit !== "object") throw Error(`${where} is not an object`);
    for (const key of Object.keys(edit)) if (!KEYS.has(key)) throw Error(`${where} has an unknown field ${key}`);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(edit.id ?? "")) throw Error(`${where} needs an id of lowercase letters, digits and dashes`);
    if (ids.has(edit.id)) throw Error(`${where}: the id is used twice`);
    ids.add(edit.id);
    if (typeof edit.file !== "string" || !/^[A-Za-z0-9_.@-]+(\/[A-Za-z0-9_.@-]+)*$/.test(edit.file) || edit.file.split("/").includes("..")) throw Error(`${where} needs a relative file path`);
    const anchor = typeof edit.anchor === "string" ? [edit.anchor] : edit.anchor;
    if (!Array.isArray(anchor) || anchor.length === 0 || !anchor.every((a) => isText(a) && a.trim().length > 0)) throw Error(`${where} needs an anchor: one line's text, or a list of them`);
    if (edit.count !== undefined && !(Number.isInteger(edit.count) && edit.count >= 1)) throw Error(`${where}: count must be a whole number from 1`);
    if (edit.has !== undefined && !(Array.isArray(edit.has) && edit.has.every((h) => isText(h) && h.length > 0))) throw Error(`${where}: has must be a list of texts`);
    if (edit.replace !== undefined && !(Array.isArray(edit.replace) && edit.replace.length > 0 && edit.replace.every((pair) => Array.isArray(pair) && pair.length === 2 && isText(pair[0]) && pair[0].length > 0 && isText(pair[1]) && pair[0] !== pair[1])))
      throw Error(`${where}: replace must be a list of [from, to] texts`);
    if (edit.before !== undefined && !isLines(edit.before)) throw Error(`${where}: before must be a list of lines`);
    if (edit.after !== undefined && !isLines(edit.after)) throw Error(`${where}: after must be a list of lines`);
    if (!edit.replace && !edit.before && !edit.after) throw Error(`${where} changes nothing: give replace, before or after`);
  }
  return data.edits;
}

/** A file as lines that remember whether Plannotator wrote them (`own`) and where an edit put them. */
export function openFile(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const parts = text.split(eol);
  const last = parts.length > 1 && parts[parts.length - 1] === "";
  if (last) parts.pop();
  return { eol, last, lines: parts.map((line) => ({ text: line, own: true, after: null, before: null })) };
}

export const fileText = (doc) => doc.lines.map((line) => line.text).join(doc.eol) + (doc.last ? doc.eol : "");

const copyFile = (doc) => {
  const map = new Map();
  const lines = doc.lines.map((line) => {
    const next = { ...line };
    map.set(line, next);
    return next;
  });
  for (const line of lines) {
    if (line.after) line.after = map.get(line.after) ?? line.after;
    if (line.before) line.before = map.get(line.before) ?? line.before;
  }
  return { ...doc, lines };
};

const shown = (text) => JSON.stringify(text.length > 80 ? text.slice(0, 77) + "..." : text);
const times = (n) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);
const occurrences = (text, part) => {
  let n = 0;
  for (let at = text.indexOf(part); at !== -1; at = text.indexOf(part, at + part.length)) n++;
  return n;
};
const indentOf = (text) => /^[ \t]*/.exec(text)[0];

/** The lines an edit works on (indexes into doc.lines), or a refusal. */
function anchored(doc, edit) {
  const anchor = typeof edit.anchor === "string" ? [edit.anchor] : edit.anchor;
  const count = edit.count ?? 1;
  const first = [];
  doc.lines.forEach((line, i) => {
    if (line.own && line.text.includes(anchor[0])) first.push(i);
  });
  if (first.length !== count) throw new EditRefused(edit, `anchor ${shown(anchor[0])} is on ${first.length === 0 ? "no line" : first.length === 1 ? "1 line" : `${first.length} lines`}, expected ${count}`);
  return first.map((start) => {
    let at = start;
    for (const next of anchor.slice(1)) {
      let found = -1;
      for (let i = at + 1, seen = 0; i < doc.lines.length && seen < WITHIN; i++) {
        if (!doc.lines[i].own) continue;
        seen++;
        if (doc.lines[i].text.includes(next)) {
          found = i;
          break;
        }
      }
      if (found === -1) throw new EditRefused(edit, `${shown(next)} is not within ${WITHIN} lines after ${shown(doc.lines[at].text.trim())}`);
      at = found;
    }
    return at;
  });
}

/** Is `want` (trimmed lines) already next to line `at`: starting within WITHIN lines after it, or ending within WITHIN before? */
function nearby(doc, at, want, side) {
  const same = (start) => want.every((text, i) => doc.lines[start + i]?.text.trim() === text);
  for (let d = 1; d <= WITHIN; d++) {
    const start = side > 0 ? at + d : at - d - want.length + 1;
    if (start < 0 || start + want.length > doc.lines.length) continue;
    if (same(start)) return true;
  }
  return false;
}

/** Applies one edit to an open file in place, or throws EditRefused naming what was found. `by` marks the lines it touches. */
export function applyEdit(doc, edit, by = null) {
  const targets = anchored(doc, edit);
  for (const at of targets) {
    const line = doc.lines[at];
    for (const need of edit.has ?? []) if (!line.text.includes(need)) throw new EditRefused(edit, `the line ${shown(line.text.trim())} no longer has ${shown(need)}`);
    for (const [from, to] of edit.replace ?? []) {
      if (line.text.includes(to)) throw new EditRefused(edit, `the line already has ${shown(to)} (applied already, or Plannotator changed it)`);
      const n = occurrences(line.text, from);
      if (n !== 1) throw new EditRefused(edit, `${shown(from)} is ${n === 0 ? "not on" : times(n) + " on"} the line ${shown(line.text.trim())}, expected once`);
    }
    for (const [side, block] of [[-1, edit.before], [1, edit.after]]) {
      if (!block) continue;
      if (nearby(doc, at, block.map((text) => text.trim()), side)) throw new EditRefused(edit, `the lines ${side < 0 ? "before" : "after"} ${shown(line.text.trim())} are already near it (applied already, or Plannotator added them)`);
    }
  }
  // Every target checked: only now is anything changed, so a refused edit leaves the file as it was.
  for (const at of [...targets].sort((a, b) => b - a)) {
    const line = doc.lines[at];
    for (const [from, to] of edit.replace ?? []) line.text = line.text.replace(from, () => to);
    if (edit.replace) line.by = by;
    const indent = indentOf(line.text);
    const made = (text, key) => ({ text: text === "" ? "" : indent + text, own: false, by, after: key === "after" ? line : null, before: key === "before" ? line : null });
    if (edit.after) {
      let pos = at + 1;
      while (pos < doc.lines.length && doc.lines[pos].after === line) pos++;
      doc.lines.splice(pos, 0, ...edit.after.map((text) => made(text, "after")));
    }
    if (edit.before) {
      let pos = at;
      doc.lines.splice(pos, 0, ...edit.before.map((text) => made(text, "before")));
    }
  }
}

/** Would `edit` apply to this text? Null when it would, else why not. */
export function refusalOf(text, edit) {
  try {
    applyEdit(openFile(text), edit);
    return null;
  } catch (error) {
    if (error instanceof EditRefused) return error.why;
    throw error;
  }
}

/**
 * Applies a group's edits to `files` (a Map of path → open file, filled from `read(path)` on first use). All or
 * nothing: on a refusal `files` is left as it was. Returns null when every edit applied, else
 * `{ edit, file, why }` for the first edit refused.
 */
export function applyGroup(files, edits, read, group = "edits") {
  const work = new Map();
  const open = (path) => {
    if (!work.has(path)) {
      if (files.has(path)) work.set(path, copyFile(files.get(path)));
      else {
        const text = read(path);
        if (text === null) return null;
        work.set(path, openFile(text));
      }
    }
    return work.get(path);
  };
  for (const edit of edits) {
    const doc = open(edit.file);
    const name = `${group}/${edit.id}`;
    if (!doc) return { edit: name, file: edit.file, why: `${edit.file} is not in this Plannotator` };
    try {
      applyEdit(doc, edit, name);
    } catch (error) {
      if (error instanceof EditRefused) return { edit: name, file: edit.file, why: error.why };
      throw error;
    }
    // Idempotence: the result, read afresh, must refuse the same edit.
    if (refusalOf(fileText(doc), edit) === null) throw Error(`edit ${name} would apply twice to ${edit.file}; give it an anchor or change it no longer matches once it is applied`);
  }
  for (const [path, doc] of work) files.set(path, doc);
  return null;
}

/** The lines of an open file that edits changed or put in: `{ line, by }`, line numbers from 1. */
export const editedLines = (doc) => doc.lines.flatMap((line, i) => (line.by ? [{ line: i + 1, by: line.by }] : []));

/**
 * The recipe's groups in order (`{ name, required, needs? }`), each group's edits from `editsOf(name)`, files from
 * `read(path)` (text, or null when absent). `without`: names left out on purpose; `dropped`: `{ name, reason, edit? }`
 * left out for a reason found later (a type check). Returns `{ files, applied, omitted, stopped }`: `omitted` entries
 * are `{ name, reason, forced, edit?, file? }`; `stopped` is `{ group, edit, file, why }` when a required group did not
 * fit, and then nothing after it was tried and nothing should be written.
 */
export function applyGroups(groups, editsOf, read, { without = [], dropped = [] } = {}) {
  const files = new Map();
  const applied = [], omitted = [];
  const left = (name) => omitted.some((o) => o.name === name);
  for (const group of groups) {
    if (without.includes(group.name)) {
      omitted.push({ name: group.name, reason: "left out with --without", forced: true });
      continue;
    }
    const drop = dropped.find((d) => d.name === group.name);
    if (drop) {
      omitted.push({ name: group.name, reason: drop.reason, forced: false, ...(drop.edit ? { edit: drop.edit } : {}) });
      continue;
    }
    const need = (group.needs ?? []).find(left);
    if (need) {
      omitted.push({ name: group.name, reason: `needs ${need}, which is left out`, forced: false });
      continue;
    }
    const refused = applyGroup(files, editsOf(group.name), read, group.name);
    if (refused) {
      if (group.required) return { files, applied, omitted, stopped: { group: group.name, ...refused } };
      omitted.push({ name: group.name, reason: `edit ${refused.edit} (${refused.file}): ${refused.why}`, forced: false, edit: refused.edit, file: refused.file });
      continue;
    }
    applied.push(group.name);
  }
  return { files, applied, omitted, stopped: null };
}
