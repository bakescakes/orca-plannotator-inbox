/**
 * Orca build gate: the agents route (`/api/inbox/control/orca-agents`) against the real Inbox server in Orca mode, its
 * real token, and fake agent CLIs in a scratch home under the system temp folder. Run with Bun in the patched source
 * tree. PLANNOTATOR_TEST_SANDBOX stays set, so upstream refuses any agent home outside the temp folder.
 *
 * Proves: the route's guards (Origin, token, methods, body) and its 404 outside Orca mode; GET lists every agent; a
 * connect adds the plugin's command where nothing was, moves a recorded plain entry, a hand-written plain one (JSON
 * and CLI agents) and leaves one with settings of its own (with a reason) and a foreign one; `except` is honoured; a
 * disconnect puts every moved entry back (byte for byte where upstream's undo allows, else equal as JSON) and takes
 * out the fresh ones, a second connect connects those again, and an agent turned off in Settings stays off.
 *
 * On Windows it proves the guards and the list only: upstream's stand-in agent CLIs (tests/helpers/fake-agents.ts) are
 * sh scripts on a POSIX PATH, so no agent's CLI can be found or run there. The moves are proven on the other runners.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const cwd = process.cwd();
const load = (path: string) => import(pathToFileURL(join(cwd, path)).href);
const root = realpathSync(mkdtempSync(join(tmpdir(), "orca-agents-proof-")));
let checks = 0;
const check = (condition: unknown, message: string, detail?: unknown) => {
  checks++;
  if (!condition) throw Error("Orca agents proof: " + message + (detail === undefined ? "" : " " + JSON.stringify(detail)));
};

const data = join(root, "inbox");
const state = join(root, "state");
for (const dir of [data, state]) mkdirSync(dir, { recursive: true });
const launcher = [join(root, "orca", "bin", "orca-mcp")];
const plainProgram = join(root, "opt", "bin", "plannotator");
const plain = [plainProgram, "inbox", "mcp"];

Object.assign(process.env, {
  PLANNOTATOR_DATA_DIR: data,
  PLANNOTATOR_TEST_SANDBOX: "1",
  PLANNOTATOR_INBOX_TAILSCALE: "0",
  PLANNOTATOR_INBOX_NOTES: "0",
  PLANNOTATOR_UPDATE_CHECK: "0",
  PLANNOTATOR_AUTO_UPDATE: "0",
  NO_BROWSER: "1",
  NO_ANON_PING: "1",
  PLANNOTATOR_FEEDBACK_HISTORY: "0",
});
delete process.env.PLANNOTATOR_ORCA_MODE;
delete process.env.PLANNOTATOR_ORCA_CONFIG;
delete process.env.PLANNOTATOR_INBOX_CONNECT;

// An inert bridge, so the Orca surface's own reads stay on loopback.
const key = Buffer.alloc(32, 29);
const bridge = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/lifecycle/catalog") return Response.json({ ok: true, version: 1, projects: [], workspaces: [], providers: [], sessions: {} });
    if (path === "/api/health") return Response.json({ version: 1, level: "ready", fresh: true, connected: 0, conversations: 0, delivered: 0, waiting: 0, blocked: [] });
    return Response.json({ error: "unexpected" }, { status: 404 });
  },
});
writeFileSync(join(state, "link-key"), key, { mode: 0o600 });
writeFileSync(join(state, "navigation.json"), JSON.stringify({ version: 1, port: bridge.port }), { mode: 0o600 });
const config = join(root, "orca-config.json");
writeFileSync(config, JSON.stringify({ v: 1, canonicalDataDir: data, dataDirs: [data], stateDir: state, mcpCommand: launcher, upgradeCommand: null, upgradeStateFile: null, upgradeBackoffMs: null }), { mode: 0o600 });
const allowed = new Set<number>([bridge.port!]);
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: any, init: any) => {
  const target = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (target.hostname !== "127.0.0.1" || !allowed.has(Number(target.port))) throw Error("Orca agents proof refused a non-fixture address");
  return realFetch(input, init);
}) as typeof fetch;

const { createFakeAgents } = await load("tests/helpers/fake-agents.ts");
const agentsModule = await load("packages/server/inbox-agents.ts");
const { AGENT_SPECS, claudeAppDir, connectInboxAgents, createAgentEnvironmentFor, readInboxAgents } = agentsModule;
const fake = createFakeAgents("orca-agents-proof-home-");
const home: string = fake.home;
const env = { ...fake.env, PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_INBOX_NOTES: "0" };
const environment = createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env });
const read = (path: string) => readFileSync(path, "utf8");
const readIf = (path: string) => (existsSync(path) ? read(path) : null);
const parse = (path: string) => JSON.parse(read(path));
const writeText = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const pretty = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const entryOf = (path: string, keys: string[] = ["mcpServers"]) => {
  if (!existsSync(path)) return undefined;
  let value: any = parse(path);
  for (const k of [...keys, "plannotator-inbox"]) value = value?.[k];
  return value;
};

const files = {
  kiro: join(home, ".kiro", "settings", "mcp.json"),
  cursor: join(home, ".cursor", "mcp.json"),
  antigravity: join(home, ".gemini", "config", "mcp_config.json"),
  gemini: join(home, ".gemini", "settings.json"),
  claudeApp: join(claudeAppDir(environment), "claude_desktop_config.json"),
  windsurf: join(home, ".config", "devin", "config.json"),
  codex: join(home, ".codex", "config.toml"),
  amp: join(home, ".config", "amp", "settings.json"),
  pi: join(home, ".pi", "agent", "mcp.json"),
};

let orca: any, stock: any;
const result: Record<string, unknown> = {};
proof: try {
  // ── Kiro: a plain entry stock Plannotator added and recorded (a stock-mode connect, Kiro the only agent found) ──
  const kiroOriginal = pretty({ mcpServers: { docs: { command: "/usr/local/bin/docs-mcp", args: ["--stdio"] } } });
  writeText(files.kiro, kiroOriginal);
  const stockRun = await connectInboxAgents({ dataDir: data, selfCommand: [plainProgram], environment });
  check(stockRun.added.length === 1 && stockRun.added[0] === "kiro", "the stock-mode connect did not add Kiro alone", stockRun);
  const kiroStock = read(files.kiro);
  const kiroRecord = readInboxAgents(data).agents.kiro;
  check(kiroRecord?.state === "added" && JSON.stringify(kiroRecord.command) === JSON.stringify(plain) && !!kiroRecord.undo, "Kiro's stock record is not an added plain entry", kiroRecord);

  // ── The other agents ─────────────────────────────────────────────────────────────────────────────────────────
  mkdirSync(join(home, ".cursor"), { recursive: true }); // Cursor: found, nothing in it.
  mkdirSync(join(home, ".gemini", "antigravity"), { recursive: true }); // Antigravity: a hand-written plain entry beside two others.
  const antigravityOriginal = pretty({ mcpServers: { search: { command: "/usr/local/bin/search-mcp", args: [] }, notes: { url: "http://127.0.0.1:9/mcp" }, "plannotator-inbox": { command: plainProgram, args: ["inbox", "mcp"] } } });
  writeText(files.antigravity, antigravityOriginal);
  const geminiOriginal = pretty({ mcpServers: { "plannotator-inbox": { command: plainProgram, args: ["inbox", "mcp"] } } }); // Gemini CLI: hand-written, through its CLI.
  writeText(files.gemini, geminiOriginal);
  const claudeAppOriginal = pretty({ mcpServers: { "plannotator-inbox": { command: plainProgram, args: ["inbox", "mcp"], env: { PLANNOTATOR_PORT: "19432" } } } });
  writeText(files.claudeApp, claudeAppOriginal); // The Claude app: plain, with settings of its own.
  const windsurfOriginal = pretty({ mcpServers: { "plannotator-inbox": { command: "/usr/local/bin/someone-elses-inbox", args: ["serve"] } } });
  writeText(files.windsurf, windsurfOriginal); // Windsurf: a foreign entry.
  const codexOriginal = `model = "gpt-5"\n\n[mcp_servers.plannotator-inbox]\ncommand = ${JSON.stringify(plainProgram)}\nargs = ["inbox", "mcp"]\n`;
  writeText(files.codex, codexOriginal); // Codex: plain, and excepted.
  fake.install("gemini", "amp", "pi", "devin", "codex");

  // ── The server, in Orca mode ─────────────────────────────────────────────────────────────────────────────────
  Object.assign(process.env, { PLANNOTATOR_ORCA_MODE: "1", PLANNOTATOR_ORCA_CONFIG: config });
  const { startInboxServer } = await load("packages/server/inbox.ts");
  const inert = async () => ({ ok: false, error: "inert proof" });
  const start = (dataDir: string, extra: Record<string, unknown>) =>
    startInboxServer({ dataDir, version: "0.28.66", binaryPath: null, phones: false, port: 0, tailscale: () => ({ status: 1, stdout: "", stderr: "inert" }), updates: { fetchRelease: inert, fetchReleasePage: inert }, ...extra });
  orca = await start(data, { agentEnvironment: environment, selfCommand: [plainProgram] });
  allowed.add(orca.port);
  const base = "http://127.0.0.1:" + orca.port;
  const route = base + "/api/inbox/control/orca-agents";
  const auth = { Authorization: "Bearer " + orca.token, "Content-Type": "application/json" };
  const call = async (body?: unknown) => {
    const response = await fetch(route, body === undefined ? { headers: auth } : { method: "POST", headers: auth, body: JSON.stringify(body) });
    const answer: any = await response.json();
    check(response.status === 200, "the route answered " + response.status, answer);
    return answer;
  };
  const rowOf = (answer: any, id: string) => answer.agents.find((row: any) => row.id === id);
  const states = (answer: any) => Object.fromEntries(answer.agents.map((row: any) => [row.id, row.state]));

  // Guards: a browser, no token, a wrong token, other methods, bad bodies.
  check((await fetch(route, { headers: { ...auth, Origin: base } })).status === 403, "a request with an Origin header was not refused");
  check((await fetch(route)).status === 401, "a request without the token was not refused");
  check((await fetch(route, { headers: { Authorization: "Bearer wrong" } })).status === 401, "a wrong token was not refused");
  check((await fetch(route, { method: "PUT", headers: auth, body: "{}" })).status === 405, "PUT was not refused");
  check((await fetch(route, { method: "POST", headers: auth, body: "[1]" })).status === 400, "a non-object body was not refused");
  check((await fetch(route, { method: "POST", headers: auth, body: JSON.stringify({ action: "wipe" }) })).status === 400, "an unknown action was not refused");
  check((await fetch(route, { method: "POST", headers: auth, body: JSON.stringify({ action: "connect", except: "codex" }) })).status === 400, "a bad except was not refused");

  // ── GET ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const listed = await call();
  check(listed.v === 1 && listed.agents.length === AGENT_SPECS.length, "GET did not list every agent", listed.agents.length);
  check(AGENT_SPECS.every((spec: any) => rowOf(listed, spec.id)?.label), "GET lacks an agent or a label");
  for (const row of listed.agents) check(["orca", "plannotator", "tool", "off", "other", "manual", "absent", "unreadable"].includes(row.state) && "reason" in row && "path" in row && typeof row.detected === "boolean", "a row has the wrong shape", row);
  check(rowOf(listed, "muse").detected === false && rowOf(listed, "hermes").detected === false, "an agent with no settings folder reads as detected");
  check(rowOf(listed, "cursor").detected === true && rowOf(listed, "cursor").state === "absent", "Cursor is not found and absent", rowOf(listed, "cursor"));
  check(rowOf(listed, "kiro").state === "plannotator" && rowOf(listed, "kiro").path === join("~", ".kiro", "settings", "mcp.json"), "Kiro's row", rowOf(listed, "kiro"));
  check(!existsSync(join(data, "inbox", "orca-agents.json")), "a GET wrote the route's memory");
  if (process.platform === "win32") {
    // No stand-in agent CLI runs here (see the top of this file): the rest is proven on the other runners.
    Object.assign(result, { ok: true, checks, agents: listed.agents.length, windows: "guards and list only" });
    console.log(JSON.stringify(result));
    break proof;
  }
  check(rowOf(listed, "windsurf").state === "other", "Windsurf's foreign entry is not other", rowOf(listed, "windsurf"));

  // ── connect ──────────────────────────────────────────────────────────────────────────────────────────────────
  const except = ["claude-code", "codex", "opencode"];
  const first = await call({ action: "connect", except });
  check(first.problems.length === 0, "the first connect had problems", first.problems);
  check(first.skipped === undefined, "the first connect was skipped", first.skipped);
  const want = { cursor: "orca", kiro: "orca", antigravity: "orca", gemini: "orca", amp: "orca", pi: "orca", "claude-app": "plannotator", windsurf: "other", codex: "plannotator" };
  for (const [id, wanted] of Object.entries(want)) check(rowOf(first, id).state === wanted, `${id} is ${rowOf(first, id).state} after the connect, not ${wanted}`, rowOf(first, id));
  for (const id of ["cursor", "kiro", "antigravity", "gemini", "amp", "pi"]) check(first.changed.includes(id), `${id} is not in changed`, first.changed);
  for (const id of ["claude-app", "windsurf", "codex"]) check(!first.changed.includes(id), `${id} is in changed`, first.changed);
  check(JSON.stringify(entryOf(files.cursor)) === JSON.stringify({ command: launcher[0], args: [] }), "Cursor did not get the launcher", entryOf(files.cursor));
  check(entryOf(files.kiro)?.command === launcher[0] && Bun.deepEquals(parse(files.kiro).mcpServers.docs, JSON.parse(kiroOriginal).mcpServers.docs), "Kiro was not moved, or its other server changed", parse(files.kiro));
  const antigravityNow = parse(files.antigravity);
  check(antigravityNow.mcpServers["plannotator-inbox"]?.command === launcher[0], "Antigravity was not moved", antigravityNow);
  check(Bun.deepEquals(antigravityNow.mcpServers.search, JSON.parse(antigravityOriginal).mcpServers.search) && Bun.deepEquals(antigravityNow.mcpServers.notes, JSON.parse(antigravityOriginal).mcpServers.notes), "Antigravity's other servers changed");
  check(entryOf(files.gemini)?.command === launcher[0], "Gemini CLI was not moved", entryOf(files.gemini));
  check(entryOf(files.amp, ["amp.mcpServers"])?.command === launcher[0], "Amp was not connected", readIf(files.amp));
  check(entryOf(files.pi)?.command === launcher[0], "Pi was not connected", readIf(files.pi));
  const geminiCalls = fake.calls().filter((c: any) => c.name === "gemini").map((c: any) => c.args.slice(0, 2).join(" "));
  check(JSON.stringify(geminiCalls) === JSON.stringify(["mcp remove", "mcp add"]), "Gemini CLI was not moved through its own CLI", geminiCalls);
  check(rowOf(first, "claude-app").reason === "It has settings of its own, so it was left as it is.", "the Claude app's reason", rowOf(first, "claude-app"));
  check(read(files.claudeApp) === claudeAppOriginal, "the Claude app's own entry was touched");
  check(read(files.windsurf) === windsurfOriginal, "the foreign entry was touched");
  check(read(files.codex) === codexOriginal && rowOf(first, "codex").reason === null, "the excepted Codex entry was touched", read(files.codex));
  check(!fake.calls().some((c: any) => c.name === "codex" && c.args[0] === "mcp"), "Codex's CLI changed its MCP settings");
  const memoryFile = join(data, "inbox", "orca-agents.json");
  check((statSync(memoryFile).mode & 0o777) === 0o600, "the route's memory is not owner-only");
  const memory = parse(memoryFile);
  check(memory.v === 1 && memory.moved.kiro?.record === "added" && memory.moved.antigravity?.record === "found" && memory.moved.gemini?.record === "found" && !memory.moved["claude-app"], "the remembered moves", memory);
  check(JSON.stringify(memory.moved.kiro.argv) === JSON.stringify(plain), "Kiro's remembered argv", memory.moved.kiro);
  const records = readInboxAgents(data).agents;
  check(records.kiro?.state === "added" && JSON.stringify(records.kiro.command) === JSON.stringify(launcher), "Kiro's record after the move", records.kiro);

  // ── Amp turned off in Settings (upstream's own switch) ──────────────────────────────────────────────────────
  const settings = await fetch(base + "/api/inbox/agents", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify({ agent: "amp", reach: false }) });
  check(settings.status === 200, "Settings could not turn Amp off", await settings.text());
  check(entryOf(files.amp, ["amp.mcpServers"]) === undefined && readInboxAgents(data).agents.amp?.state === "off", "Settings did not turn Amp off");
  const again = await call({ action: "connect", except });
  check(again.problems.length === 0 && again.changed.length === 0, "a second connect changed something", again);
  check(rowOf(again, "amp").state === "off" && entryOf(files.amp, ["amp.mcpServers"]) === undefined, "Amp, turned off in Settings, was turned on", rowOf(again, "amp"));

  // ── disconnect ───────────────────────────────────────────────────────────────────────────────────────────────
  const off = await call({ action: "disconnect", except });
  check(off.problems.length === 0, "the disconnect had problems", off.problems);
  for (const id of ["cursor", "kiro", "antigravity", "gemini", "pi"]) check(off.changed.includes(id), `${id} is not in the disconnect's changed`, off.changed);
  check(!off.changed.includes("amp") && !off.changed.includes("codex"), "the disconnect changed Amp or Codex", off.changed);
  check(read(files.kiro) === kiroStock, "Kiro's file is not byte for byte what stock Plannotator wrote", read(files.kiro));
  const kiroBack = readInboxAgents(data).agents.kiro;
  check(kiroBack?.state === "added" && JSON.stringify(kiroBack.command) === JSON.stringify(plain) && !!kiroBack.undo, "Kiro's record is not added again", kiroBack);
  check(Bun.deepEquals(parse(files.antigravity), JSON.parse(antigravityOriginal)), "Antigravity's file is not its original", read(files.antigravity));
  result.antigravityBytesEqual = read(files.antigravity) === antigravityOriginal;
  check(readInboxAgents(data).agents.antigravity?.state === "found", "Antigravity's record is not found", readInboxAgents(data).agents.antigravity);
  check(read(files.gemini) === geminiOriginal, "Gemini CLI's file is not its original", read(files.gemini));
  check(readInboxAgents(data).agents.gemini?.state === "found", "Gemini CLI's record is not found");
  // Upstream's undo also removes the file it created for Cursor.
  check(!existsSync(files.cursor) && readInboxAgents(data).agents.cursor?.state === "off", "Cursor kept the launcher, or its file", readIf(files.cursor));
  check(entryOf(files.pi) === undefined && readInboxAgents(data).agents.pi?.state === "off", "Pi kept the launcher", readIf(files.pi));
  check(read(files.codex) === codexOriginal && read(files.claudeApp) === claudeAppOriginal && read(files.windsurf) === windsurfOriginal, "the disconnect touched an entry it does not own");
  const offStates = states(off);
  check(offStates.kiro === "plannotator" && offStates.antigravity === "plannotator" && offStates.gemini === "plannotator", "the moved agents do not read plannotator", offStates);
  check(offStates.cursor === "absent" && offStates.pi === "absent" && offStates.amp === "off", "the off agents read wrong", offStates);
  const memoryAfter = parse(memoryFile);
  check(Object.keys(memoryAfter.moved).length === 0 && memoryAfter.off.includes("cursor") && memoryAfter.off.includes("pi") && !memoryAfter.off.includes("amp"), "the memory after the disconnect", memoryAfter);

  // ── connect again ────────────────────────────────────────────────────────────────────────────────────────────
  const back = await call({ action: "connect", except });
  check(back.problems.length === 0, "the third connect had problems", back.problems);
  for (const id of ["cursor", "pi", "kiro", "antigravity", "gemini"]) check(rowOf(back, id).state === "orca" && back.changed.includes(id), `${id} was not connected again`, rowOf(back, id));
  check(rowOf(back, "amp").state === "off" && !back.changed.includes("amp"), "Amp, off in Settings, came back on");
  check(read(files.codex) === codexOriginal, "the excepted Codex entry was touched");
  check(parse(memoryFile).off.length === 0, "the memory kept agents it turned on again", parse(memoryFile));

  // ── Pi gets Plannotator's own extension: a disconnect leaves its tool switch and its entry alone, and says why ──
  writeText(join(home, ".pi", "agent", "settings.json"), pretty({ packages: ["npm:@plannotator/pi-extension"] }));
  const piConfig = () => (existsSync(join(data, "config.json")) ? parse(join(data, "config.json")).inboxTool?.pi : undefined);
  const piToolBefore = piConfig();
  const piEntryBefore = read(files.pi);
  const withTool = await call({ action: "disconnect", except });
  const piProblem = withTool.problems.find((problem: any) => problem.agent === "pi");
  check(piProblem && /own plugin/.test(piProblem.reason) && !withTool.changed.includes("pi"), "Pi with its extension was not left alone with a reason", withTool.problems);
  check(read(files.pi) === piEntryBefore && piConfig() === piToolBefore, "the disconnect changed Pi's entry or its tool switch", { tool: piConfig() });
  check(withTool.problems.length === 1 && withTool.changed.includes("cursor") && withTool.changed.includes("kiro"), "the others did not disconnect beside Pi", withTool);
  check(read(files.kiro) === kiroStock, "Kiro's file is not what stock Plannotator wrote, the second time");

  // ── Stock mode: the route does not exist ─────────────────────────────────────────────────────────────────────
  delete process.env.PLANNOTATOR_ORCA_MODE;
  delete process.env.PLANNOTATOR_ORCA_CONFIG;
  const stockData = join(root, "stock-inbox");
  mkdirSync(stockData, { recursive: true });
  stock = await start(stockData, {});
  allowed.add(stock.port);
  const stockAnswer = await fetch("http://127.0.0.1:" + stock.port + "/api/inbox/control/orca-agents", { headers: { Authorization: "Bearer " + stock.token } });
  const stockBody: any = await stockAnswer.json();
  check(stockAnswer.status === 404 && stockBody.error === "Orca mode is off.", "the route answered outside Orca mode", { status: stockAnswer.status, stockBody });

  Object.assign(result, { ok: true, checks, agents: listed.agents.length, firstConnect: first.changed, disconnect: off.changed, reconnect: back.changed, stockMode: 404 });
  console.log(JSON.stringify(result));
} finally {
  globalThis.fetch = realFetch;
  await orca?.stop?.();
  await stock?.stop?.();
  bridge.stop(true);
  try {
    fake.remove();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
