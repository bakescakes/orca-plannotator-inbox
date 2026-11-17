/**
 * Orca build gate for the `mark-faces` feature (patch agent-marks), drawn in a DOM (happy-dom, as upstream's DOM
 * tests). Run with Bun in the patched source tree; the build leaves it out with that patch.
 *
 * Proves: a `mark:<host>` face the plugin keeps for an agent draws that host's own mark, the same as the host's plain
 * mark, in the agent's icon (HostMark) and in its sidebar mark (AgentMark), with Settings → Rows' Agent icons at the
 * default and at "From the project name". The project setting never turns it into the project's tile, and the picker
 * keeps it as it is. A control agent with no face shows that the setting is on (it draws its project's tile).
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const cwd = realpathSync(process.cwd());
let checks = 0;
const check = (condition: unknown, message: string) => {
  checks++;
  if (!condition) throw Error("Orca marks proof: " + message);
};
const fromDir = (dir: string, name: string) => import(pathToFileURL(Bun.resolveSync(name, join(cwd, dir))).href);
const file = (path: string) => import(pathToFileURL(join(cwd, path)).href);

const { GlobalRegistrator } = await fromDir("packages/ui", "@happy-dom/global-registrator");
GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const query = (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} });
(window as unknown as { matchMedia: unknown }).matchMedia = query;
(globalThis as unknown as { matchMedia: unknown }).matchMedia = query;
// No server: every request answers here, and nothing leaves the process.
globalThis.fetch = (async () => new Response(JSON.stringify({ faces: {}, rev: 0 }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

const { act, createElement } = await fromDir("packages/inbox", "react");
const { createRoot } = await fromDir("packages/inbox", "react-dom/client");
const icons = await file("packages/inbox/icons.tsx");
const ui = await file("packages/ui/components/inbox-thread/icons.tsx");
const marks = await file("packages/inbox/letterMarks.tsx");
const { AgentMark } = await file("packages/inbox/agents/AgentMark.tsx");
const faces = await file("packages/inbox/agents/agentFaces.ts");
const project = await file("packages/inbox/agents/projectFace.tsx");
const { setInboxAgents } = await file("packages/inbox/agentsList.ts");
const { LIST_LOOK_DEFAULT } = await file("packages/inbox/listLook.ts");
const { setStorageBackend } = await file("packages/ui/utils/storage.ts");
const { INBOX_MARK_FACE } = await file("packages/core/inbox-types.ts");

const kept = new Map<string, string>();
setStorageBackend({ getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) });

let root: { render(node: unknown): void; unmount(): void } | null = null;
function draw(node: unknown): HTMLElement {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  const box = document.createElement("div");
  box.className = "pn-inbox";
  document.body.append(box);
  root = createRoot(box);
  act(() => root!.render(node));
  return box;
}
const agent = (id: string, host: string, name: string) => ({ id, session: id, host, project: { id: `prj_${id}`, name }, state: "idle", waiting: 0, live: true, started_at: null, last_seen_at: null });

// Pure: the face shown and the face kept leave a `mark:<host>` face as it is, setting on or off.
check(INBOX_MARK_FACE.test("mark:codex") && !INBOX_MARK_FACE.test("mark"), "INBOX_MARK_FACE takes mark:<host> and not upstream's bare mark");
for (const on of [false, true]) {
  check(project.shownAgentFace("mark:codex", on) === "mark:codex", `shownAgentFace keeps mark:codex (project setting ${on})`);
  check(project.keptAgentFace("mark:codex", on) === "mark:codex", `keptAgentFace keeps mark:codex (project setting ${on})`);
}

const hosts = ["codex", "claude-code", "pi", "opencode", "cursor"];
setInboxAgents([{ agents: [agent("ses_o", "orca", "orchard"), agent("ses_c", "claude-code", "orchard"), ...hosts.map((h) => agent(`ses_${h}`, "orca", "orchard"))], total: 2 + hosts.length, ended_today: 0 }]);
const picked = Object.fromEntries([["ses_o", { face: "mark:codex", sessions: [] }], ...hosts.map((h) => [`ses_${h}`, { face: `mark:${h}`, sessions: [] }])]);
check(faces.hearAgentFacesEvent({ faces: picked, rev: 1 }), "the faces event is heard");

const markOf = (id: string, host: string, fromProject: boolean) =>
  draw(createElement(marks.RowMarksScope, { look: { ...LIST_LOOK_DEFAULT, agentProjectIcons: fromProject } }, createElement(icons.HostMark, { host, agent: id })));
const plain = (host: string) => draw(createElement(ui.HostMark, { host })).innerHTML;

// Control: with the setting on, an agent with no face picked draws its project's tile, so the setting is in force here.
check(markOf("ses_c", "claude-code", true).querySelector('[data-agent-face="project"]'), "the control agent draws its project's tile under the setting");
check(!markOf("ses_c", "claude-code", false).querySelector('[data-agent-face="project"]'), "the control agent draws no tile at the default");

for (const fromProject of [false, true]) {
  for (const host of hosts) {
    const el = markOf(`ses_${host}`, "orca", fromProject);
    check(el.innerHTML === plain(host), `HostMark: mark:${host} draws ${host}'s own mark (project setting ${fromProject})`);
    check(!el.querySelector('[data-agent-face="project"], .ib-pf'), `HostMark: mark:${host} is no project tile (project setting ${fromProject})`);
  }
  check(markOf("ses_o", "orca", fromProject).innerHTML !== plain("orca"), `HostMark: mark:codex is not Orca's own mark (project setting ${fromProject})`);

  // The sidebar mark: the same agent through AgentMark, inside the same look.
  const side = draw(
    createElement(marks.RowMarksScope, { look: { ...LIST_LOOK_DEFAULT, agentProjectIcons: fromProject } }, createElement("div", { className: "ib-sbagent" }, createElement(AgentMark, { id: "ses_o", host: "orca", name: "An Orca chat" }))),
  );
  check(side.querySelector('[data-agent-icon="ses_o"]'), `AgentMark draws (project setting ${fromProject})`);
  check(!side.querySelector('[data-agent-face="project"], .ib-pf'), `AgentMark: mark:codex is no project tile (project setting ${fromProject})`);
}

// The sidebar mark of a codex agent with no face, at the default: what mark:codex must look like in the same place.
setInboxAgents([{ agents: [agent("ses_o", "codex", "orchard")], total: 1, ended_today: 0 }]);
faces.resetAgentFaces();
const sideOf = (host: string, fromProject: boolean) =>
  draw(createElement(marks.RowMarksScope, { look: { ...LIST_LOOK_DEFAULT, agentProjectIcons: fromProject } }, createElement("div", { className: "ib-sbagent" }, createElement(AgentMark, { id: "ses_o", host, name: "An Orca chat" })))).innerHTML;
const codexSide = sideOf("codex", false);
setInboxAgents([{ agents: [agent("ses_o", "orca", "orchard")], total: 1, ended_today: 0 }]);
check(faces.hearAgentFacesEvent({ faces: { ses_o: { face: "mark:codex", sessions: [] } }, rev: 2 }), "the faces event is heard again");
for (const fromProject of [false, true]) check(sideOf("orca", fromProject) === codexSide, `AgentMark: mark:codex draws codex's own sidebar mark (project setting ${fromProject})`);

act(() => root?.unmount());
console.log(JSON.stringify({ ok: true, checks }));
process.exit(0);
