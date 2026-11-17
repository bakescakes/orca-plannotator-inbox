/**
 * The Orca build of Plannotator: the agents route (added by the Orca plugin's build; see that build's README).
 *
 * `/api/inbox/control/orca-agents`, Orca mode only (else 404). inbox.ts's control block has already checked the
 * loopback Host, that there is no Origin header, and the Inbox token.
 *
 *  GET  -> { v: 1, agents: Row[] }
 *  POST { action: "connect" | "disconnect", except?: string[] }
 *       -> { v: 1, agents: Row[], changed: string[], problems: { agent, reason }[], skipped?: "env" | "sandbox" }
 *
 * connect: (a) upstream's own connect run (in Orca mode it writes the plugin's `mcpCommand`); (b) the agents this
 * route turned off in a disconnect are turned on again; (c) an agent whose `plannotator-inbox` entry runs Plannotator
 * directly is moved to `mcpCommand`, when the entry is plainly Plannotator's (a record says Plannotator added exactly
 * it, or it holds nothing but command, args and type "stdio"). Its original argv is remembered.
 *
 * disconnect: every entry that runs `mcpCommand` is taken out. A moved agent gets its original entry back; any other
 * is left off, and remembered, so the next connect turns it on again. An agent the person turned off in Settings
 * stays off; agents reached through Plannotator's own plugin ("tool") are left alone.
 *
 * `except`: agents the plugin handles itself; nothing here moves, restores, turns on or takes out their entries
 * (upstream's connect run in (a) still reaches them, as it reaches every agent without a record).
 *
 * Every agent file is read and written through inbox-agents.ts (its refusals stand). What this route remembers is in
 * `<dataDir>/inbox/orca-agents.json`: { v: 1, moved: { [id]: { argv, record: "added" | "found" } }, off: [id] }.
 * Requests run one at a time per data folder.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { INBOX_AGENT_IDS, INBOX_AGENT_LABELS, type InboxAgentId, type InboxConnectReport } from "@plannotator/core/inbox-types";
import { samePlace, writeAgentFileAtomic } from "./agent-files";
import {
  AGENT_SPECS,
  INBOX_CONNECT_AGENT_TIMEOUT_MS,
  agentHomeAllowed,
  claudeCodeMcpEntry,
  claudeCodeMcpPath,
  displayPath,
  entryArgv,
  inboxAgentReach,
  inboxAgentsPath,
  isPlannotatorInboxCommand,
  readInboxAgents,
  setInboxAgentReach,
  writeInboxAgents,
  writeJsonEntry,
  type AgentEnvironment,
  type ConnectOptions,
} from "./inbox-agents";
import { orcaConfig, orcaMode } from "./inbox-orca-surface";

type Spec = (typeof AGENT_SPECS)[number];
type Way = Awaited<ReturnType<Spec["way"]>>;

export type OrcaAgentState = "orca" | "plannotator" | "tool" | "off" | "other" | "manual" | "absent" | "unreadable";

export interface OrcaAgentRow {
  id: InboxAgentId;
  label: string;
  detected: boolean;
  state: OrcaAgentState;
  reason: string | null;
  /** Where the entry is, `~` for the home folder. */
  path: string | null;
}

export interface OrcaAgentsContext {
  json: (body: unknown, status?: number) => Response;
  dataDir: string;
  /** The stdio entry's argv without `inbox mcp` (inbox.ts `selfCommand`). */
  selfCommand: readonly string[];
  environment: AgentEnvironment;
  /** inbox.ts's single-flight connect run. */
  connectAgents: () => Promise<InboxConnectReport>;
}

interface Problem {
  agent: InboxAgentId;
  reason: string;
}

/** What this route remembers. */
interface Memory {
  v: 1;
  moved: Partial<Record<InboxAgentId, { argv: string[]; record: "added" | "found" }>>;
  off: InboxAgentId[];
}

/** The connect options with this marker write `<program> inbox mcp`, not `mcpCommand` (inbox-orca-surface.ts). */
type PlainOptions = ConnectOptions & { orcaPlain: true };

const MEMORY_FILE = "orca-agents.json";
const REASON_MAX = 300;
const EXCEPT_MAX = 64;
const LEFT_OWN_SETTINGS = "It has settings of its own, so it was left as it is.";

/** One chain per data folder (requests never interleave), and why the last connect left an entry as it was. */
const lanes = new Map<string, { chain: Promise<unknown>; left: Map<InboxAgentId, string> }>();

function laneOf(dataDir: string) {
  const key = resolve(dataDir);
  let lane = lanes.get(key);
  if (!lane) {
    lane = { chain: Promise.resolve(), left: new Map() };
    lanes.set(key, lane);
  }
  return lane;
}

function serialized<T>(dataDir: string, work: () => Promise<T>): Promise<T> {
  const lane = laneOf(dataDir);
  const next = lane.chain.then(work, work);
  lane.chain = next.catch(() => undefined);
  return next;
}

const sameArgv = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined) =>
  !!a && !!b && a.length === b.length && a.every((word, i) => word === b[i]);

const isAgentId = (value: unknown): value is InboxAgentId => typeof value === "string" && (INBOX_AGENT_IDS as readonly string[]).includes(value);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function attempt(work: () => Promise<string | null>): Promise<string | null> {
  try {
    return await work();
  } catch (error) {
    return message(error);
  }
}

// ---------------------------------------------------------------------------
// What this route remembers

function memoryPath(dataDir: string): string {
  return join(dirname(inboxAgentsPath(dataDir)), MEMORY_FILE);
}

/** The remembered state; missing or damaged reads as empty. Only Plannotator's own commands are ever kept. */
function readMemory(dataDir: string): Memory {
  const memory: Memory = { v: 1, moved: {}, off: [] };
  try {
    const parsed = JSON.parse(readFileSync(memoryPath(dataDir), "utf8")) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return memory;
    const moved = parsed.moved;
    if (moved && typeof moved === "object" && !Array.isArray(moved)) {
      for (const [id, value] of Object.entries(moved as Record<string, unknown>)) {
        if (!isAgentId(id) || !value || typeof value !== "object") continue;
        const { argv, record } = value as { argv?: unknown; record?: unknown };
        if (!Array.isArray(argv) || !argv.every((word) => typeof word === "string") || !isPlannotatorInboxCommand(argv as string[])) continue;
        if (record !== "added" && record !== "found") continue;
        memory.moved[id] = { argv: [...(argv as string[])], record };
      }
    }
    if (Array.isArray(parsed.off)) for (const id of parsed.off) if (isAgentId(id) && !memory.off.includes(id)) memory.off.push(id);
  } catch {
    // Missing or damaged: start empty.
  }
  return memory;
}

function writeMemory(dataDir: string, memory: Memory): void {
  writeAgentFileAtomic(memoryPath(dataDir), `${JSON.stringify(memory, null, 2)}\n`, 0o600, true, true);
}

// ---------------------------------------------------------------------------
// Reading an agent

/** A reason as one plain, bounded sentence part, the home folder shown as `~`. */
function tidy(reason: string, e: AgentEnvironment): string {
  const home = e.homeDir.replace(/[\\/]+$/, "");
  const text = (home ? reason.split(home).join("~") : reason).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
}

type Entry = { kind: "absent" } | { kind: "unreadable"; reason: string } | { kind: "value"; value: unknown; argv: string[] | null };

/** The agent's `plannotator-inbox` entry in the file its settings name now. Null: no file is known for it. */
function readEntry(spec: Spec, e: AgentEnvironment, mcp: readonly string[]): Entry | null {
  if (spec.id === "claude-code") {
    // Read only: Claude Code's own MCP settings, which Plannotator never writes.
    const read = claudeCodeMcpEntry(e, [mcp]);
    return read.kind === "ours" || read.kind === "other" ? { kind: "value", value: undefined, argv: read.argv } : null;
  }
  const raw = spec.raw(e);
  if (raw === null) return null;
  if (raw.kind === "value") return { kind: "value", value: raw.value, argv: entryArgv(raw.value) };
  if (raw.kind === "unreadable") return { kind: "unreadable", reason: raw.reason };
  return { kind: "absent" };
}

function currentArgv(spec: Spec, e: AgentEnvironment, mcp: readonly string[]): string[] | null {
  const entry = readEntry(spec, e, mcp);
  return entry?.kind === "value" ? entry.argv : null;
}

function detectedOn(spec: Spec, e: AgentEnvironment): boolean {
  try {
    return spec.detect(e);
  } catch {
    return false;
  }
}

async function rowOf(spec: Spec, options: ConnectOptions, mcp: readonly string[], memory: Memory, left: Map<InboxAgentId, string>): Promise<OrcaAgentRow> {
  const e = options.environment;
  const id = spec.id;
  const base = { id, label: INBOX_AGENT_LABELS[id], detected: detectedOn(spec, e) };
  const filePath = id === "claude-code" ? null : displayPath(spec.file(e), e);
  let entry: Entry | null;
  try {
    entry = readEntry(spec, e, mcp);
  } catch (error) {
    entry = { kind: "unreadable", reason: message(error) };
  }
  if (entry?.kind === "unreadable") return { ...base, state: "unreadable", reason: tidy(entry.reason, e), path: filePath };
  if (entry?.kind === "value") {
    const path = id === "claude-code" ? displayPath(claudeCodeMcpPath(e), e) : filePath;
    if (sameArgv(entry.argv, mcp)) return { ...base, state: "orca", reason: null, path };
    if (entry.argv && isPlannotatorInboxCommand(entry.argv)) return { ...base, state: "plannotator", reason: left.get(id) ?? null, path };
    return { ...base, state: "other", reason: null, path };
  }
  const reach = await inboxAgentReach(id, options);
  const path = reach.path;
  if (reach.kind === "tool") return { ...base, state: reach.on ? "tool" : "off", reason: reach.on ? null : reach.reason, path: null };
  if (reach.kind === "manual") return { ...base, state: "manual", reason: reach.reason, path };
  if (reach.kind === "none") return { ...base, state: "manual", reason: null, path };
  const record = readInboxAgents(options.dataDir).agents[id];
  switch (reach.state) {
    case "connected": {
      // A record and no file to read it in.
      const argv = record?.command ?? null;
      const state: OrcaAgentState = sameArgv(argv, mcp) ? "orca" : argv && isPlannotatorInboxCommand(argv) ? "plannotator" : "other";
      return { ...base, state, reason: null, path };
    }
    case "off":
      // Turned off by this route: the next connect turns it on again.
      return memory.off.includes(id) ? { ...base, state: "absent", reason: null, path } : { ...base, state: "off", reason: null, path };
    case "removed":
      return { ...base, state: "off", reason: "Its entry was removed outside Plannotator, so a connect leaves it as it is.", path };
    case "elsewhere":
      return { ...base, state: "off", reason: "It is connected in another settings file, so a connect leaves it as it is.", path };
    case "foreign":
      return { ...base, state: "other", reason: null, path };
    case "unreadable":
      return { ...base, state: "unreadable", reason: reach.reason ? tidy(reach.reason, e) : null, path };
    default:
      // Not connected: a connect reaches it only when Plannotator has no record of it.
      return record ? { ...base, state: "off", reason: "Plannotator already has a record of it, so a connect leaves it as it is.", path } : { ...base, state: "absent", reason: null, path };
  }
}

async function rowsOf(options: ConnectOptions, mcp: readonly string[], memory: Memory, left: Map<InboxAgentId, string>): Promise<OrcaAgentRow[]> {
  const rows: OrcaAgentRow[] = [];
  for (const spec of AGENT_SPECS) {
    try {
      rows.push(await rowOf(spec, options, mcp, memory, left));
    } catch (error) {
      const e = options.environment;
      rows.push({ id: spec.id, label: INBOX_AGENT_LABELS[spec.id], detected: detectedOn(spec, e), state: "unreadable", reason: tidy(message(error), e), path: null });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Changing an agent's entry

/** Only command, args (words) and type "stdio": nothing a plain entry written back would lose but the type. */
function plainShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.command !== "string") return false;
  if (entry.args !== undefined && !(Array.isArray(entry.args) && entry.args.every((word) => typeof word === "string"))) return false;
  if (entry.type !== undefined && entry.type !== "stdio") return false;
  return Object.keys(entry).every((key) => key === "command" || key === "args" || key === "type");
}

/** A record of an entry Plannotator connected in another file than the one the agent's settings name now. */
function recordedElsewhere(spec: Spec, options: ConnectOptions): boolean {
  const record = readInboxAgents(options.dataDir).agents[spec.id];
  const file = spec.file(options.environment);
  return !!record && record.reach === "mcp" && (record.state === "added" || record.state === "found") && !!record.path && !!file && !samePlace(record.path, file);
}

/** Whether upstream's own switch removes this entry byte for byte: a record says Plannotator added exactly it. */
function addedExactly(spec: Spec, options: ConnectOptions, argv: readonly string[]): boolean {
  const record = readInboxAgents(options.dataDir).agents[spec.id];
  return record?.reach === "mcp" && record.state === "added" && sameArgv(record.command, argv) && !recordedElsewhere(spec, options);
}

function wayLeftReason(way: Way): string | null {
  if (way.kind === "json" || way.kind === "cli") return null;
  if (way.kind === "tool") return "Plannotator's own plugin connects it, so its entry was left as it is.";
  if (way.kind === "manual") return `It is connected by hand here (${way.why}), so its entry was left as it is.`;
  return "Plannotator does not edit its MCP settings, so its entry was left as it is.";
}

/**
 * Take the entry running `argv` out of the agent's settings, then check it is gone. `viaSwitch`: upstream's own
 * switch (it records `off`); else one JSON key, or the agent's own `mcp remove`. Returns why not, or null.
 */
async function takeOut(spec: Spec, way: Way | null, argv: readonly string[], viaSwitch: boolean, options: ConnectOptions, problems: Problem[]): Promise<string | null> {
  const e = options.environment;
  const file = spec.file(e);
  let said: string | null = null;
  if (viaSwitch) {
    said = await attempt(() => setInboxAgentReach(spec.id, false, options));
  } else if (way?.kind === "json" && file) {
    const result = writeJsonEntry(file, way.keys, undefined, [[...argv]], undefined, way.json);
    if (!result.ok) return result.reason;
  } else if (way?.kind === "cli" && spec.remove) {
    const remove = spec.remove;
    const bin = e.which(remove.bin);
    if (!bin) return `${remove.bin} is not on PATH`;
    const ran = await e.run([bin, ...remove.args], { timeoutMs: INBOX_CONNECT_AGENT_TIMEOUT_MS });
    if (ran.timedOut) return `${remove.bin} ${remove.args.join(" ")} did not finish in time`;
    if (ran.exitCode !== 0) return `${remove.bin} ${remove.args.join(" ")} exited with code ${ran.exitCode}`;
  } else {
    return "Plannotator does not edit its MCP settings here";
  }
  const after = readEntry(spec, e, argv);
  if (after?.kind === "value" && sameArgv(after.argv, argv)) return said ?? `its entry is still in ${displayPath(file, e) ?? "its settings"}`;
  if (after?.kind === "unreadable") return `${displayPath(file, e)} can't be read after the change (${after.reason})`;
  if (after?.kind === "value") return `${displayPath(file, e)} has another plannotator-inbox entry now`;
  // Gone. Something said beside the switch (Qwen Code's trusted sender) is still worth saying.
  if (said) problems.push({ agent: spec.id, reason: tidy(said, e) });
  return null;
}

/** Turn the agent on with the plugin's `mcpCommand`; returns why it is not on it, or null. */
async function addLauncher(spec: Spec, options: ConnectOptions, mcp: readonly string[], problems: Problem[]): Promise<string | null> {
  const said = await attempt(() => setInboxAgentReach(spec.id, true, options));
  if (!sameArgv(currentArgv(spec, options.environment, mcp), mcp)) return said ?? "its entry is not there afterwards";
  if (said) problems.push({ agent: spec.id, reason: tidy(said, options.environment) });
  return null;
}

/**
 * Write the agent's own plain entry back (`<program> inbox mcp`, through upstream's switch with the plain marker),
 * and its record as it was: `added` keeps the fresh record (its undo fits the file now); `found` or none becomes a
 * `found` record. Returns why not, or null.
 */
async function putBack(spec: Spec, argv: readonly string[], record: "added" | "found", options: ConnectOptions, mcp: readonly string[]): Promise<string | null> {
  const plain: PlainOptions = { ...options, selfCommand: argv.slice(0, -2), orcaPlain: true };
  const said = await attempt(() => setInboxAgentReach(spec.id, true, plain));
  if (!sameArgv(currentArgv(spec, options.environment, mcp), argv)) return said ?? "the entry is not there afterwards";
  if (record === "found") {
    const file = readInboxAgents(options.dataDir);
    file.agents[spec.id] = { state: "found", reach: "mcp", path: spec.file(options.environment), at: (options.now ?? (() => new Date()))().toISOString() };
    writeInboxAgents(options.dataDir, file);
  }
  return null;
}

type MoveOutcome = { kind: "moved" } | { kind: "left"; reason: string } | { kind: "problem"; reason: string } | { kind: "skip" };

/** Step (c): one agent's plain Plannotator entry to the plugin's `mcpCommand`. */
async function moveToLauncher(spec: Spec, options: ConnectOptions, mcp: readonly string[], memory: Memory, problems: Problem[]): Promise<MoveOutcome> {
  const e = options.environment;
  const entry = readEntry(spec, e, mcp);
  if (entry?.kind !== "value" || !entry.argv || !isPlannotatorInboxCommand(entry.argv)) return { kind: "skip" };
  const argv = entry.argv;
  const way = await spec.way(e, true);
  const notHere = wayLeftReason(way);
  if (notHere) return { kind: "left", reason: notHere };
  if (recordedElsewhere(spec, options)) return { kind: "left", reason: "It is also connected in another settings file, so it was left as it is." };
  const viaSwitch = addedExactly(spec, options, argv);
  if (!viaSwitch && !plainShape(entry.value)) return { kind: "left", reason: LEFT_OWN_SETTINGS };
  const kept: "added" | "found" = viaSwitch ? "added" : "found";
  // Remembered first: a stop part way never loses the original.
  memory.moved[spec.id] = { argv: [...argv], record: kept };
  writeMemory(options.dataDir, memory);
  const out = await takeOut(spec, way, argv, viaSwitch, options, problems);
  if (out) {
    delete memory.moved[spec.id];
    writeMemory(options.dataDir, memory);
    return { kind: "problem", reason: `Its Plannotator entry could not be taken out (${out}), so it was left as it is` };
  }
  const added = await addLauncher(spec, options, mcp, problems);
  if (added) {
    // Best effort: its own entry goes back.
    const back = await attempt(() => putBack(spec, argv, kept, options, mcp));
    if (!back) {
      delete memory.moved[spec.id];
      writeMemory(options.dataDir, memory);
    }
    return { kind: "problem", reason: `The Orca entry could not be added (${added})${back ? `, and its own entry could not be put back (${back})` : "; its own entry was put back"}` };
  }
  return { kind: "moved" };
}

// ---------------------------------------------------------------------------
// The two actions

interface Answer {
  v: 1;
  agents: OrcaAgentRow[];
  changed: InboxAgentId[];
  problems: Problem[];
  skipped?: "env" | "sandbox";
}

async function connect(ctx: OrcaAgentsContext, options: ConnectOptions, mcp: readonly string[], except: ReadonlySet<string>): Promise<Answer> {
  const e = options.environment;
  const lane = laneOf(ctx.dataDir);
  const changed = new Set<InboxAgentId>();
  const problems: Problem[] = [];
  // (a) Upstream's run: every agent found that has no record.
  const report = await ctx.connectAgents();
  if (report.skipped) return { v: 1, agents: await rowsOf(options, mcp, readMemory(ctx.dataDir), lane.left), changed: [], problems: [], skipped: report.skipped };
  for (const id of report.added) changed.add(id);
  for (const failure of report.failed) problems.push({ agent: failure.agent, reason: tidy(failure.reason, e) });
  const memory = readMemory(ctx.dataDir);

  // (b) What this route turned off: on again (an agent the person turned on or off since is theirs now).
  for (const id of [...memory.off]) {
    if (except.has(id)) continue;
    if (readInboxAgents(ctx.dataDir).agents[id]?.state !== "off") {
      memory.off = memory.off.filter((other) => other !== id);
      writeMemory(ctx.dataDir, memory);
      continue;
    }
    const spec = AGENT_SPECS.find((candidate) => candidate.id === id)!;
    const said = await attempt(() => setInboxAgentReach(id, true, options));
    if (readInboxAgents(ctx.dataDir).agents[id]?.state === "off") {
      problems.push({ agent: id, reason: tidy(said ?? "it stayed off", e) });
      continue;
    }
    memory.off = memory.off.filter((other) => other !== id);
    writeMemory(ctx.dataDir, memory);
    if (said) problems.push({ agent: id, reason: tidy(said, e) });
    if (sameArgv(currentArgv(spec, e, mcp), mcp)) changed.add(id);
  }

  // (c) A plain Plannotator entry, moved to the plugin's command.
  for (const spec of AGENT_SPECS) {
    if (except.has(spec.id)) continue;
    lane.left.delete(spec.id);
    if (!detectedOn(spec, e)) continue;
    let outcome: MoveOutcome;
    try {
      outcome = await moveToLauncher(spec, options, mcp, memory, problems);
    } catch (error) {
      outcome = { kind: "problem", reason: message(error) };
    }
    if (outcome.kind === "moved") changed.add(spec.id);
    else if (outcome.kind === "left") lane.left.set(spec.id, outcome.reason);
    else if (outcome.kind === "problem") {
      lane.left.set(spec.id, tidy(`${outcome.reason}.`, e));
      problems.push({ agent: spec.id, reason: tidy(outcome.reason, e) });
    }
  }
  return { v: 1, agents: await rowsOf(options, mcp, memory, lane.left), changed: [...changed], problems };
}

async function disconnect(ctx: OrcaAgentsContext, options: ConnectOptions, mcp: readonly string[], except: ReadonlySet<string>): Promise<Answer> {
  const e = options.environment;
  const lane = laneOf(ctx.dataDir);
  const memory = readMemory(ctx.dataDir);
  if (!agentHomeAllowed(e)) return { v: 1, agents: await rowsOf(options, mcp, memory, lane.left), changed: [], problems: [], skipped: "sandbox" };
  const changed: InboxAgentId[] = [];
  const problems: Problem[] = [];
  for (const spec of AGENT_SPECS) {
    const id = spec.id;
    if (except.has(id)) continue;
    try {
      if (!sameArgv(currentArgv(spec, e, mcp), mcp)) continue;
      // The way first, even for an entry upstream's switch would remove: with Plannotator's own plugin there now, its
      // switch would turn the plugin's tool off and leave the entry.
      const way = await spec.way(e, true);
      if (way.kind !== "json" && way.kind !== "cli") {
        const why = way.kind === "manual" ? way.why : way.kind === "tool" ? "Plannotator's own plugin connects it" : "Plannotator does not edit its MCP settings";
        problems.push({ agent: id, reason: tidy(`Its Orca entry was left as it is (${why})`, e) });
        continue;
      }
      const viaSwitch = addedExactly(spec, options, mcp);
      const out = await takeOut(spec, way, mcp, viaSwitch, options, problems);
      if (out) {
        problems.push({ agent: id, reason: tidy(`Its Orca entry could not be taken out (${out})`, e) });
        continue;
      }
      const remembered = memory.moved[id];
      if (remembered) {
        const back = await attempt(() => putBack(spec, remembered.argv, remembered.record, options, mcp));
        if (back) {
          // Never left with neither: the Orca entry goes back in, and the original stays remembered.
          const again = await addLauncher(spec, options, mcp, problems);
          problems.push({ agent: id, reason: tidy(`Its own entry could not be put back (${back})${again ? `, and the Orca entry could not be added again (${again})` : ", so the Orca entry stays"}`, e) });
          continue;
        }
        delete memory.moved[id];
        writeMemory(ctx.dataDir, memory);
      } else {
        if (!viaSwitch) {
          const file = readInboxAgents(ctx.dataDir);
          file.agents[id] = { state: "off", reach: "mcp", path: spec.file(e), at: new Date().toISOString() };
          writeInboxAgents(ctx.dataDir, file);
        }
        if (!memory.off.includes(id)) memory.off.push(id);
        writeMemory(ctx.dataDir, memory);
      }
      lane.left.delete(id);
      changed.push(id);
    } catch (error) {
      problems.push({ agent: id, reason: tidy(message(error), e) });
    }
  }
  return { v: 1, agents: await rowsOf(options, mcp, memory, lane.left), changed, problems };
}

/** The route. Answers every method; 404 outside Orca mode. */
export async function orcaAgentsRoute(req: Request, ctx: OrcaAgentsContext): Promise<Response> {
  const { json } = ctx;
  if (!orcaMode()) return json({ error: "Orca mode is off." }, 404);
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
  let action: "connect" | "disconnect" | null = null;
  const except = new Set<string>();
  if (req.method === "POST") {
    const body = (await req.json().catch(() => undefined)) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "body: expected a JSON object." }, 400);
    const { action: asked, except: skip } = body as { action?: unknown; except?: unknown };
    if (asked !== "connect" && asked !== "disconnect") return json({ error: 'action: "connect" or "disconnect".' }, 400);
    if (skip !== undefined) {
      if (!Array.isArray(skip) || skip.length > EXCEPT_MAX || !skip.every((id) => typeof id === "string" && id.length > 0 && id.length <= 64)) {
        return json({ error: "except: a list of agent ids." }, 400);
      }
      for (const id of skip) except.add(id);
    }
    action = asked;
  }
  let mcp: string[];
  try {
    mcp = orcaConfig(ctx.dataDir).mcpCommand;
  } catch (error) {
    return json({ error: `The Orca config can't be used: ${message(error)}.` }, 503);
  }
  const options: ConnectOptions = { dataDir: ctx.dataDir, selfCommand: ctx.selfCommand, environment: ctx.environment };
  try {
    const answer = await serialized(ctx.dataDir, async () => {
      if (action === "connect") return connect(ctx, options, mcp, except);
      if (action === "disconnect") return disconnect(ctx, options, mcp, except);
      return { v: 1, agents: await rowsOf(options, mcp, readMemory(ctx.dataDir), laneOf(ctx.dataDir).left) };
    });
    return json(answer);
  } catch (error) {
    return json({ error: tidy(message(error), ctx.environment) }, 500);
  }
}
