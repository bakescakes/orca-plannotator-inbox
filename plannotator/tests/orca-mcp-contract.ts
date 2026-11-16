/** Orca build gate: native MCP identity. Run with the pinned Bun in the patched source tree.
 * Registers real tool schemas and calls the pure upstream argument shim only:
 * no transport connection, handler invocation, Inbox store, host or provider call.
 * Unknown identity-filled tools or identity fields require a review of the Orca plugin's MCP command.
 */
import {mkdtempSync, readFileSync, rmSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";

const PREFIX = "Native MCP contract: ";
function requireContract(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(PREFIX + detail);
}
function same(actual: unknown, expected: unknown): boolean {
  const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)]))
      : value;
  return JSON.stringify(ordered(actual)) === JSON.stringify(ordered(expected));
}
const expectedSets: Record<string, string[]> = {
  FILLED_TOOLS: ["send_message", "read_thread", "submit_guide", "card", "steps", "thread_pulls", "routine"],
  NO_PROJECT_TOOLS: ["steps"],
  PROJECT_ONLY_TOOLS: ["search"],
  AUTHOR_TOOLS: ["send_message", "submit_guide", "card", "steps", "thread_pulls", "routine"],
};
const identityFields = ["agent_host", "agent_session", "agent_name", "project_path"];
const author = ["agent_host", "agent_session", "agent_name"];
const allowed: Record<string, string[]> = {
  send_message: [...author, "project_path"], submit_guide: [...author, "project_path"],
  read_thread: ["agent_session", "project_path"], card: [...author, "project_path"],
  steps: author, thread_pulls: [...author, "project_path"], search: ["project_path"],
  routine: [...author, "project_path"],
};
const inputs: Record<string, Record<string, unknown>> = {
  send_message: {body: "Inert contract fixture.", idempotency_key: "contract-message"},
  submit_guide: {guide: {intent: "Review inert fixture"}, patch: "literal patch", idempotency_key: "contract-guide"},
  read_thread: {asked_by: "me"}, card: {op: "create", title: "Inert fixture", idempotency_key: "contract-card"},
  steps: {thread_id: "msg_contract", steps: []}, thread_pulls: {thread_id: "msg_contract", add: ["owner/repo#7"]},
  search: {query: "inert fixture"}, routine: {op: "list"},
};
const native = {agent_host: "orca", agent_session: "codex_native_contract", agent_name: "Native fixture", project_path: "/inert/native-project"};
const providerThread = "48bd638a-1f29-4667-8a0d-41e4fe6d0026";
const upstream = process.cwd();
const shimPath = join(upstream, "apps/hook/server/inbox-mcp-shim.ts");
requireContract(statSync(shimPath).size <= 512 * 1024, "shim source exceeds bounded inspection; review its identity contract");
const source = readFileSync(shimPath, "utf8");
for (const [name, expected] of Object.entries(expectedSets)) {
  // Deliberately narrow extraction: changed representation is a review gate,
  // never a guess that an unrecognized declaration has the old meaning.
  const pattern = new RegExp("^const " + name + "\\s*=\\s*new Set\\(\\s*(\\[[^\\]]*\\])\\s*\\)\\s*;", "gm");
  const matches = [...source.matchAll(pattern)];
  requireContract(matches.length === 1, name + " declaration changed; review shim source before admission");
  let actual: unknown;
  try { actual = JSON.parse(matches[0][1]); }
  catch { throw new Error(PREFIX + name + " is no longer a literal JSON string list; review before admission"); }
  requireContract(Array.isArray(actual) && actual.every(item => typeof item === "string") && new Set(actual).size === actual.length,
    name + " is not an unambiguous literal tool set");
  requireContract(same([...actual].sort(), [...expected].sort()), name + " changed; packaged native identity coverage must be reviewed");
}

const home = mkdtempSync(join(tmpdir(), "orca-mcp-contract-"));
Object.assign(process.env, {
  HOME: home, PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_INBOX_CONNECT: "0", PLANNOTATOR_INBOX_NOTES: "0",
  PLANNOTATOR_UPDATE_CHECK: "0", PLANNOTATOR_AUTO_UPDATE: "0", NO_ANON_PING: "1", NO_BROWSER: "1",
});
// Imports/registration must remain inert. A future side effect fails this gate.
const deny = () => { throw new Error(PREFIX + "unexpected network/server/process effect in inert proof"); };
globalThis.fetch = deny as typeof fetch;
Bun.serve = deny as typeof Bun.serve;
Bun.spawn = deny as typeof Bun.spawn;
Bun.spawnSync = deny as typeof Bun.spawnSync;
let checks = 4;
try {
  const {createInboxMcpServer} = await import(pathToFileURL(join(upstream, "packages/server/inbox-mcp.ts")).href);
  const {fillInboxToolArguments} = await import(pathToFileURL(shimPath).href);
  const store = new Proxy({}, {get() { throw new Error(PREFIX + "unexpected store access during schema registration"); }});
  const server = createInboxMcpServer({store, baseUrl: "http://127.0.0.1:1", boardOn: () => true, stepsOn: () => true, scheduledOn: () => true});
  const schemaFor = (tool: string) => {
    const schema = server._registeredTools?.[tool]?.inputSchema;
    requireContract(typeof schema?.safeParse === "function", tool + " schema unavailable; review MCP registration");
    return schema;
  };
  const call = (tool: string, args: unknown, meta: Record<string, unknown> = {}) => ({
    jsonrpc: "2.0", id: 1, method: "tools/call", params: {name: tool, arguments: args, _meta: meta},
  });
  for (const [tool, input] of Object.entries(inputs)) {
    const schema = schemaFor(tool);
    const shape = schema.shape;
    requireContract(shape && typeof shape === "object", tool + " object shape unavailable; review identity fields");
    const declared = Object.keys(shape).filter(key => key === "project_path" || key.startsWith("agent_")).sort();
    requireContract(same(declared, [...allowed[tool]].sort()), tool + " identity field schema changed"); checks++;
    requireContract(schema.safeParse(input).success, tool + " baseline arguments no longer match upstream schema"); checks++;
    for (const field of identityFields) {
      const parsed = schema.safeParse({...input, [field]: native[field as keyof typeof native]});
      if (allowed[tool].includes(field)) {
        requireContract(parsed.success && parsed.data[field] === native[field as keyof typeof native], tool + " rejects/rewrites native " + field);
        requireContract(!schema.safeParse({...input, [field]: 42}).success, tool + " accepts nonstring " + field);
      } else requireContract(!parsed.success, tool + " unexpectedly accepts forbidden identity field " + field);
      checks++;
    }
    requireContract(!schema.safeParse({...input, unknown_native_identity_probe: "not-supported"}).success,
      tool + " schema no longer refuses unknown fields"); checks++;
    const fields = Object.fromEntries(allowed[tool].map(field => [field, native[field as keyof typeof native]]));
    const args = {...input, ...fields};
    const filled = fillInboxToolArguments(call(tool, args, {threadId: providerThread}), "/wrong-cwd", "ses_wrong", null, "codex-mcp-client");
    requireContract(same(filled.params.arguments, args) && schema.safeParse(filled.params.arguments).success,
      tool + " shim changes explicit native identity or adds unknown fields"); checks++;
    const defaults = fillInboxToolArguments(call(tool, input), native.project_path, "ses_wrong",
      {host: "orca", session: native.agent_session, name: native.agent_name}, null);
    requireContract(same(defaults.params.arguments, {...input, ...fields}), tool + " default filling contract changed"); checks++;
  }
  // Query scope is not author provenance; retain an explicit cross-project read.
  for (const tool of ["read_thread", "search"]) {
    const args = {...inputs[tool], project_path: "/inert/another-project", ...(tool === "read_thread" ? {agent_session: native.agent_session} : {})};
    requireContract(same(fillInboxToolArguments(call(tool, args, {threadId: providerThread}), "/wrong-cwd", "ses_wrong", null, "codex-mcp-client").params.arguments, args),
      tool + " changed explicit query scope"); checks++;
  }
  const all = {query: "inert fixture", all_projects: true};
  requireContract(same(fillInboxToolArguments(call("search", all), "/wrong-cwd", "ses_wrong").params.arguments, all),
    "search all_projects no longer suppresses the project default"); checks++;
  // Confirm the actual null/array normalization risk that the wrapper guards.
  // This deliberately inspects only the pure shim and schema, never a handler.
  for (const value of [undefined, null, []]) {
    const result = fillInboxToolArguments(call("read_thread", value, {threadId: providerThread}), "/wrong-cwd", "ses_wrong", null, "codex-mcp-client");
    requireContract(result.params.arguments && !Array.isArray(result.params.arguments)
      && result.params.arguments.agent_session === providerThread && schemaFor("read_thread").safeParse(result.params.arguments).success,
      "read_thread absent/null/array normalization changed; recheck wrapper argument-shape guard"); checks++;
  }
  console.log(JSON.stringify({ok: true, contract: "native-mcp-identity-v1", checks, tools: Object.keys(inputs), sourceSets: Object.keys(expectedSets), effects: "schema-registration-and-pure-shim-only"}));
} catch (error) {
  throw new Error(PREFIX + (error instanceof Error ? error.message : "unknown upstream contract failure"));
} finally {
  rmSync(home, {recursive: true, force: true});
}
