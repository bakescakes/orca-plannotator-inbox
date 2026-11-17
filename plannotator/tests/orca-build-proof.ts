/**
 * Orca build gate: stock behaviour without Orca mode, then Orca mode against an inert fake bridge and a fake updater.
 * Run with Bun in the patched source tree. No network beyond loopback fixtures; nothing outside a temp folder.
 *
 * Proves: Orca mode needs both variables (else stock: /api/inbox/orca 404, stock updater, stock MCP command);
 * `mark:<host>` faces are kept and returned in both modes; the plugin's MCP command (1-3 absolute parts); imported
 * empty projects; the connection card's aggregate and features; the updater's state reaching the stock update model
 * (updating, failed with its sentence, rolled back, ready); Update now starting the updater with `--version`;
 * the launch hosts' bridge request shapes; a Stop Orca refuses reaching the run line as an error, not as stopped;
 * and a `mark:<host>` face drawing that host's mark.
 *
 * A reduced build: the build writes what it carries into packages/server/inbox-orca-build.ts. The card must serve
 * exactly that list, the required patches' features must be in it, and a feature left out must be absent, the source
 * as stock has it: without `mark-faces`, a `mark:<host>` face is refused in both modes as stock refuses it, and the
 * Orca marks file, the `orca` host name and the mark-face pattern are not in the source.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const root = realpathSync(mkdtempSync(join(tmpdir(), "orca-build-proof-")));
let checks = 0;
const check = (condition: unknown, message: string) => {
  checks++;
  if (!condition) throw Error("Orca build proof: " + message);
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, what: string): Promise<T> {
  let value = await read();
  for (let i = 0; i < 100 && !ok(value); i++) {
    await sleep(50);
    value = await read();
  }
  check(ok(value), what);
  return value;
}

Object.assign(process.env, {
  HOME: join(root, "home"),
  USERPROFILE: join(root, "home"),
  PLANNOTATOR_DATA_DIR: join(root, "config"),
  PLANNOTATOR_TEST_SANDBOX: "1",
  PLANNOTATOR_INBOX_TAILSCALE: "0",
  PLANNOTATOR_INBOX_CONNECT: "0",
  PLANNOTATOR_INBOX_NOTES: "0",
  PLANNOTATOR_UPDATE_CHECK: "0",
  PLANNOTATOR_AUTO_UPDATE: "0",
  NO_BROWSER: "1",
  NO_ANON_PING: "1",
  PLANNOTATOR_FEEDBACK_HISTORY: "0",
});
delete process.env.PLANNOTATOR_ORCA_MODE;
delete process.env.PLANNOTATOR_ORCA_CONFIG;
mkdirSync(join(root, "home"), { recursive: true });
mkdirSync(join(root, "config"), { recursive: true });
// Starting agents from the Inbox, switched on in so many words: Plannotator leaves it off on Windows until it is.
writeFileSync(join(root, "config", "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));

// The inert bridge: catalog, health, status and the four lifecycle actions; every request's bearer is checked.
const key = Buffer.alloc(32, 23);
const project = join(root, "empty-project");
mkdirSync(project, { recursive: true });
let bearerOk = true;
// Set: the bridge refuses a Stop with this sentence.
let refuseStop: string | null = null;
const actions: { path: string; body: any }[] = [];
const bridge = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    bearerOk &&= request.headers.get("authorization") === "Bearer " + key.toString("hex");
    const url = new URL(request.url);
    if (url.pathname === "/api/lifecycle/catalog")
      return Response.json({ ok: true, version: 1, projects: [{ name: "Empty project", root: project }], workspaces: [{ folder: project, project: "Empty project", selector: "ws" }], providers: [{ id: "codex", name: "Codex" }, { id: "pi", name: "Pi" }], sessions: {} });
    if (url.pathname === "/api/health") return Response.json({ version: 1, level: "ready", fresh: true, connected: 1, conversations: 1, delivered: 0, waiting: 0, blocked: [] });
    if (url.pathname === "/api/lifecycle/status") {
      const session = url.searchParams.get("session");
      return Response.json({ ok: true, version: 1, session, complete: true, launches: [{ session, state: "created", launchId: "launch_proof" }] });
    }
    const action = /^\/api\/lifecycle\/(start|stop|resume|open)$/.exec(url.pathname)?.[1];
    if (action && request.method === "POST") {
      const body = await request.json();
      actions.push({ path: action, body });
      if (action === "stop" && refuseStop) return Response.json({ ok: false, text: refuseStop });
      return Response.json(action === "start" ? { ok: true, session: "orca_session_1", ref: "orca_session_1" } : { ok: true, state: "acknowledged" });
    }
    return Response.json({ error: "unexpected" }, { status: 404 });
  },
});
const allowed = new Set<number>([bridge.port!]);
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init: any) => {
  const target = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (target.hostname !== "127.0.0.1" || !allowed.has(Number(target.port))) throw Error("Orca build proof refused a non-fixture address");
  return realFetch(input, init);
}) as typeof fetch;

const { ORCA_BUILD } = await import(pathToFileURL(join(cwd, "packages/server/inbox-orca-build.ts")).href);
const features: string[] = [...ORCA_BUILD.features];
for (const required of ["launch-hosts", "update-state", "update-detail", "agents"]) check(features.includes(required), "the build lacks required feature " + required);
const marksOn = features.includes("mark-faces");
check(marksOn === !ORCA_BUILD.omitted.includes("agent-marks"), "mark-faces and the agent-marks patch disagree: " + JSON.stringify(ORCA_BUILD));
const { startInboxServer } = await import(pathToFileURL(join(cwd, "packages/server/inbox.ts")).href);
const { ORCA_UPDATER_LABEL } = await import(pathToFileURL(join(cwd, "packages/server/inbox-orca-surface.ts")).href);
const inert = async () => ({ ok: false, error: "inert proof" });
const start = async (dataDir: string) => {
  const server = await startInboxServer({ dataDir, version: "0.28.66", binaryPath: null, phones: false, port: 0, tailscale: () => ({ status: 1, stdout: "", stderr: "inert" }), updates: { fetchRelease: inert, fetchReleasePage: inert } });
  allowed.add(server.port);
  return { server, base: "http://127.0.0.1:" + server.port };
};
const same = { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" };
const getJson = async (base: string, path: string) => (await fetch(base + path, { headers: same })).json();
const markFace = async (base: string, agent: string, face: string) => {
  const response = await fetch(base + "/api/inbox/agent-faces", { method: "POST", headers: same, body: JSON.stringify({ agent, face }) });
  return response.status;
};

const result: Record<string, unknown> = {};
let stock: any, orca: any;
try {
  // ── Stock: no Orca mode, or only half of it ─────────────────────────────────────────────────────────────────
  const stockData = join(root, "stock-inbox");
  mkdirSync(stockData, { recursive: true });
  stock = await start(stockData);
  for (const env of [{}, { PLANNOTATOR_ORCA_MODE: "1" }, { PLANNOTATOR_ORCA_MODE: "1", PLANNOTATOR_ORCA_CONFIG: "relative/config.json" }, { PLANNOTATOR_ORCA_CONFIG: join(root, "orca-config.json") }]) {
    delete process.env.PLANNOTATOR_ORCA_MODE;
    delete process.env.PLANNOTATOR_ORCA_CONFIG;
    Object.assign(process.env, env);
    check((await fetch(stock.base + "/api/inbox/orca")).status === 404, "half of Orca mode answered /api/inbox/orca: " + JSON.stringify(env));
  }
  delete process.env.PLANNOTATOR_ORCA_MODE;
  delete process.env.PLANNOTATOR_ORCA_CONFIG;
  const stockUpdate = await getJson(stock.base, "/api/inbox/update");
  check(stockUpdate.command !== ORCA_UPDATER_LABEL && stockUpdate.failure === null, "stock update details changed");
  const stockSettings = await getJson(stock.base, "/api/inbox/settings?store=0");
  check(JSON.stringify(stockSettings.mcp_command.slice(-2)) === '["inbox","mcp"]', "stock MCP command changed");
  if (marksOn) {
    check((await markFace(stock.base, "stock_session", "mark:codex")) === 200, "stock refused a mark: face");
    check((await getJson(stock.base, "/api/inbox/agent-faces")).faces.stock_session?.face === "mark:codex", "stock did not keep a mark: face");
  } else {
    // Left out: refused as stock Plannotator refuses a face it does not know, and nothing kept.
    check((await markFace(stock.base, "stock_session", "mark:codex")) >= 400, "a build without mark-faces kept a mark: face");
    check((await getJson(stock.base, "/api/inbox/agent-faces")).faces.stock_session === undefined, "a build without mark-faces kept a face for the session");
  }
  check((await markFace(stock.base, "stock_session", "mark:Not A Host")) >= 400, "a malformed mark: face was kept");
  stock.server.stop();
  stock = null;
  result.stock = { orcaRoute: 404, updater: "stock", mcpTail: ["inbox", "mcp"], markFaces: marksOn ? "accepted" : "refused (left out)" };

  // ── Orca mode ────────────────────────────────────────────────────────────────────────────────────────────────
  const data = join(root, "orca-inbox"), state = join(root, "state");
  mkdirSync(data, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "link-key"), key, { mode: 0o600 });
  writeFileSync(join(state, "navigation.json"), JSON.stringify({ version: 1, port: bridge.port }), { mode: 0o600 });
  const stateFile = join(state, "update-state.json");
  const updaterArgs = join(root, "updater-args.json");
  const updater = join(root, "fake-updater.ts");
  // The fake updater records its arguments, writes its state file with a sentence, and exits 1 (failed).
  writeFileSync(
    updater,
    `import {writeFileSync} from "node:fs";\nconst v=process.argv[process.argv.indexOf("--version")+1];\nwriteFileSync(${JSON.stringify(updaterArgs)},JSON.stringify(process.argv.slice(2)));\nwriteFileSync(${JSON.stringify(stateFile)},JSON.stringify({phase:"failed",version:v,at:Date.now()/1000,detail:"No Orca build of Plannotator "+v+" has been published yet, so 0.28.66 stays in use."}),{mode:0o600});\nprocess.exit(1);\n`,
  );
  const mcpCommand = [join(root, "bin", "node"), join(root, "plugin", "mcp.js"), join(root, "plugin", "extra")];
  const config = join(root, "orca-config.json");
  writeFileSync(
    config,
    JSON.stringify({ v: 1, canonicalDataDir: data, dataDirs: [data], stateDir: state, mcpCommand, upgradeCommand: [process.execPath, updater], upgradeStateFile: stateFile, upgradeBackoffMs: 60000 }),
    { mode: 0o600 },
  );
  Object.assign(process.env, { PLANNOTATOR_ORCA_MODE: "1", PLANNOTATOR_ORCA_CONFIG: config });
  orca = await start(data);
  const base = orca.base;

  const settings = await getJson(base, "/api/inbox/settings?store=0");
  check(JSON.stringify(settings.mcp_command) === JSON.stringify(mcpCommand), "the plugin's MCP command was not used");
  const list = await until(() => getJson(base, "/api/inbox/threads"), (v: any) => (v.projects ?? []).some((p: any) => p.orca_imported), "the empty catalog project was not imported");
  const imported = list.projects.filter((p: any) => p.orca_imported);
  check(imported.length === 1 && imported[0].threads === 0 && imported[0].listed === 0, "import invented Inbox activity");
  const card = await getJson(base, "/api/inbox/orca");
  check(card.mode === "orca" && card.connected === true && card.projects.imported === 1, "connection card aggregate wrong");
  check(JSON.stringify(card.features) === JSON.stringify(features), "the card's features are not the build's: " + JSON.stringify(card.features));
  check(card.upgrade.configured === true && card.upgrade.state === null, "updater not configured or a state invented");
  check((await fetch(base + "/api/inbox/orca", { method: "POST", headers: same, body: "{}" })).status === 405, "the card route took a POST");

  // The updater's state file reaches the stock update model: the sidebar button, the update and failure dialogs.
  const now = () => Date.now() / 1000;
  const put = (value: unknown) => writeFileSync(stateFile, JSON.stringify(value), { mode: 0o600 });
  put({ phase: "building", version: "0.28.67", at: now(), detail: "Preparing the Orca build." });
  let details = await getJson(base, "/api/inbox/update");
  check(details.update?.state === "updating" && details.update.version === "0.28.67" && details.update.action === "script", "in-progress phase is not shown as updating");
  check((await getJson(base, "/api/inbox/health")).update?.state === "updating", "health does not carry updating");
  check(details.command === ORCA_UPDATER_LABEL && details.auto_update.supported === true, "update details are not the Orca build updater's");
  const sentence = "No Orca build of Plannotator 0.28.67 has been published yet, so 0.28.66 stays in use.";
  put({ phase: "failed", version: "0.28.67", at: now(), detail: sentence });
  details = await getJson(base, "/api/inbox/update");
  check(details.update?.state === "failed" && details.failure?.detail === sentence && details.failure.exit_code === 1, "failure and its sentence are not in the stock failure fields");
  check(String(details.failure.log).endsWith("update.log"), "failure does not name the updater's log");
  check((await getJson(base, "/api/inbox/orca")).upgrade.state?.detail === sentence, "card lacks the updater's sentence");
  put({ phase: "rolled-back", version: "0.28.67", at: now(), detail: "Plannotator 0.28.67 did not start, so 0.28.66 is back in use." });
  details = await getJson(base, "/api/inbox/update");
  check(details.update?.state === "failed" && details.failure?.exit_code === 2, "rolled back is not a failure");
  put({ phase: "ready", version: "0.28.67", at: now(), detail: "Plannotator 0.28.67 is in use." });
  check((await getJson(base, "/api/inbox/update")).update?.state === "ready", "a newer activated version is not ready");
  put({ phase: "ready", version: "0.28.66", at: now(), detail: "Plannotator 0.28.66 is in use." });
  check((await getJson(base, "/api/inbox/update")).update === null, "the running version is still offered");
  // A change of the updater's state is pushed to the open windows (their status event), not only read on demand.
  const stream = new AbortController();
  const events = await fetch(base + "/api/inbox/events", { headers: { Accept: "text/event-stream" }, signal: stream.signal });
  const reader = events.body!.getReader();
  let seenText = "";
  const pushed = (async () => {
    const decoder = new TextDecoder();
    for (;;) {
      const part = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (part.done) return false;
      seenText += decoder.decode(part.value, { stream: true });
      if (/event: status\ndata: [^\n]*"state":"updating"[^\n]*"version":"0\.28\.68"/.test(seenText)) return true;
    }
  })();
  await sleep(200);
  put({ phase: "activating", version: "0.28.68", at: now(), detail: "Switching to the Orca build." });
  const arrived = await Promise.race([pushed, sleep(10000).then(() => false)]);
  stream.abort();
  check(arrived, "the updater's state change was not pushed to the windows");
  put({ phase: "failed", version: "0.28.67", at: now(), detail: "An earlier attempt failed." });

  // Update now (and the failure dialog's Try Again) starts the updater with --version; its own sentence shows.
  const posted = await (await fetch(base + "/api/inbox/update", { method: "POST", headers: same, body: "{}" })).json();
  check(posted.ok === true && posted.version === "0.28.67", "Update now did not start the Orca build updater");
  const after = await until(() => getJson(base, "/api/inbox/update"), (v: any) => v.failure?.detail === sentence, "the updater's failure sentence did not reach the failure dialog");
  check(after.update.state === "failed", "the updater's failure is not shown as failed");
  check(JSON.stringify(JSON.parse(readFileSync(updaterArgs, "utf8"))) === JSON.stringify(["--version", "0.28.67"]), "the updater did not get --version");
  check(existsSync(join(state, "update-attempt.json")), "Update now kept no attempt record");

  // A mark: face set through the API is kept and returned in Orca mode too (refused, as stock, without mark-faces).
  if (marksOn) {
    check((await markFace(base, "orca_session_1", "mark:codex")) === 200, "Orca mode refused a mark: face");
    check((await getJson(base, "/api/inbox/agent-faces")).faces.orca_session_1?.face === "mark:codex", "Orca mode did not keep a mark: face");
  } else {
    check((await markFace(base, "orca_session_1", "mark:codex")) >= 400, "Orca mode without mark-faces kept a mark: face");
    check((await getJson(base, "/api/inbox/agent-faces")).faces.orca_session_1 === undefined, "Orca mode without mark-faces kept a face for the session");
  }

  // The launch hosts: every Orca chat agent, and the bridge request shapes of Start, Stop, Resume and Open.
  const { createOrcaLaunchHosts } = await import(pathToFileURL(join(cwd, "packages/server/inbox-orca-host.ts")).href);
  const hosts = createOrcaLaunchHosts({ dataDir: data, bridge: { runStateOf: () => null } });
  check(JSON.stringify(hosts.map((h: any) => h.agent).sort()) === JSON.stringify(["claude-code", "codex", "opencode", "pi"]), "launch hosts changed");
  check(hosts.every((h: any) => h.routeHost === "orca" && h.connector === "Orca plugin"), "launch hosts' route or connector text changed");
  const codex = hosts.find((h: any) => h.agent === "codex");
  check((await codex.available([project])).ok === true, "codex in Orca not available for its workspace");
  const launch = { id: "launch_proof", agent: "codex", folder: project, model: null, effort: null, session_ref: "orca_session_1" };
  const started = await codex.start(launch, { name: "Proof", login: {}, source: { messageId: "msg_1", threadId: "thr_1" } });
  check(started.ok === true && started.session === "orca_session_1", "start did not settle the Orca session");
  await codex.stop("orca_session_1");
  await codex.resume(launch);
  await codex.open(launch);
  const shape = (body: any) => Object.keys(body).sort().join(",");
  check(actions.map((a) => a.path).join(",") === "start,stop,resume,open", "lifecycle actions out of order");
  check(shape(actions[0]!.body) === "effort,folder,launchId,messageId,model,ownerAction,provider,reconcile,threadId", "start request shape changed");
  check(actions[0]!.body.provider === "codex" && actions[0]!.body.ownerAction === true && actions[0]!.body.reconcile === false, "start request values changed");
  for (const a of actions.slice(1)) check(shape(a.body) === "actionId,launchId,ownerAction,session" && a.body.launchId === "launch_proof", a.path + " request shape changed");
  check(bearerOk, "a bridge request lacked the lowercase-hex bearer");

  // The run line's own Stop: one Orca refuses is an error with Orca's sentence, never an answer that reads as
  // stopped; one Orca accepts is answered as done.
  const serverSession = (await getJson(base, "/api/inbox/health")).serverSession;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: same, body: JSON.stringify(body) });
  const sent = await (await post("/api/inbox/messages", { serverSession, idempotency_key: "orca-build-proof-start", to: { launch: { agent: "codex", project_id: imported[0].id } }, body: "Proof." })).json();
  check(typeof sent.launch?.id === "string", "the Inbox started no launch for Orca: " + JSON.stringify(sent).slice(0, 300));
  const rootOf = async () => ((await getJson(base, "/api/inbox/threads/" + sent.thread_id)).thread?.messages ?? []).find((m: any) => m.id === sent.thread_id);
  await until(rootOf, (m: any) => m?.launch?.session_ref === "orca_session_1" && m.to?.host === "orca", "the launch did not settle on the Orca chat");
  refuseStop = "Orca kept the chat running.";
  const refused = await post("/api/inbox/launch/" + sent.launch.id + "/stop", { serverSession });
  const refusal = await refused.json();
  check(refused.status >= 400 && refusal.code === "stop_unavailable" && refusal.error === refuseStop, "a Stop Orca refused read as stopped: " + JSON.stringify(refusal).slice(0, 300));
  refuseStop = null;
  const accepted = await post("/api/inbox/launch/" + sent.launch.id + "/stop", { serverSession });
  // (No connection polls for this fixture's chat, so its run line is not read here; the real Orca test reads it.)
  check(accepted.status === 200 && actions.filter((a) => a.path === "stop").length === 3, "a Stop Orca accepted was not answered as done: " + accepted.status);
  result.orca = { mcpCommand: "plugin's", imported: imported.length, features: card.features, update: ["updating", "failed+detail", "rolled-back", "ready", "update-now"], hosts: hosts.map((h: any) => h.agent), actions: actions.map((a) => a.path), refusedStop: "error" };

  // Without mark-faces, the source is stock's where that patch would change it.
  if (!marksOn) {
    const types = await import(pathToFileURL(join(cwd, "packages/core/inbox-types.ts")).href);
    check(types.INBOX_MARK_FACE === undefined && types.isInboxAgentFace("mark:codex") === false, "the source knows mark: faces without mark-faces");
    check(types.INBOX_HOST_NAMES.orca === undefined, "the source names the orca host without mark-faces");
    check(!existsSync(join(cwd, "packages/ui/components/inbox-thread/orca-marks.tsx")), "the Orca marks file is in a build without mark-faces");
    check(!readFileSync(join(cwd, "packages/ui/components/inbox-thread/icons.tsx"), "utf8").includes("orca-marks"), "the marks use the Orca marks without mark-faces");
    check(!readFileSync(join(cwd, "packages/inbox/icons.tsx"), "utf8").includes("'mark:'"), "the icons draw mark: faces without mark-faces");
    result.marks = "left out (stock)";
  }
  // A mark: face draws that host's own mark (and an Orca-only agent's mark from the Orca build's marks).
  // React resolves from the window's package (the tests folder has no dependencies of its own).
  if (marksOn) {
    const fromInbox = (name: string) => import(pathToFileURL(Bun.resolveSync(name, join(cwd, "packages/inbox"))).href);
    const { createElement } = await fromInbox("react");
    const { renderToStaticMarkup } = await fromInbox("react-dom/server");
    const { FaceOfMark } = await import(pathToFileURL(join(cwd, "packages/inbox/icons.tsx")).href);
    const draw = (host: string, face: string) => renderToStaticMarkup(createElement(FaceOfMark, { host, face }));
    check(draw("orca", "mark:codex") === draw("codex", "agent"), "mark:codex is not Codex's own mark");
    check(draw("orca", "mark:copilot") !== draw("orca", "agent"), "mark:copilot drew the neutral mark");
    for (const host of ["claude-code", "codex", "pi", "opencode", "cursor", "grok", "antigravity", "copilot", "kimi", "omp"])
      check(draw("orca", "mark:" + host) !== draw("orca", "agent"), "mark:" + host + " drew the neutral mark");
    result.marks = "drawn";
  }
} finally {
  globalThis.fetch = realFetch;
  stock?.server.stop();
  orca?.server.stop();
  bridge.stop(true);
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: true, checks, ...result }));
process.exit(0);
