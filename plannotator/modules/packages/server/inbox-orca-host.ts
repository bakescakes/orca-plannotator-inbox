/**
 * The Orca build of Plannotator: launch hosts that start, stop, resume and open agents as native Orca chats through
 * the plugin's bridge. Server-only: no token, native command or bridge address reaches page JavaScript.
 *
 * Bridge (from the plugin's private stateDir): `navigation.json` = {"version":1,"port"}, `link-key` = 32 raw bytes,
 * sent as a lowercase-hex bearer. Routes: GET /api/lifecycle/catalog, GET /api/lifecycle/status?session=,
 * POST /api/lifecycle/start|stop|resume|open.
 */
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { LaunchHost, LaunchHostContext, LaunchHostResult, LaunchDelivery, LaunchStartFailure } from "./inbox-launch-host";
import type { LaunchEnv } from "./inbox-launch-env";
import type { InboxLaunchAgent, InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { orcaConfig, orcaMode, orcaPrivateRead } from "./inbox-orca-surface";

export { orcaMode };

// The seams orca-host.patch reads (type-only module augmentation, so the patch never edits upstream's interfaces):
// a client route host, the source-backed start input, a native Open, and the run line's Open destination.
declare module "./inbox-launch-host" {
  interface LaunchHost {
    /** Optional client-host route (`to.host`, the Agents row); the provider launch key (`agent`) is unchanged. */
    readonly routeHost?: string;
    /** The launch's source message and whether this is a reconcile (Try again), for an owner-bound native start. */
    start(
      launch: InboxLaunchRecord,
      input: { name: string; login: LaunchEnv; source?: { messageId: string; threadId: string }; reconcile?: boolean },
    ): Promise<{ ok: true; session: string; ref: string } | ({ ok: false } & LaunchStartFailure)>;
    /** Native host Open; never starts a Terminal process. */
    open?(launch: InboxLaunchRecord): Promise<LaunchHostResult>;
  }
}
declare module "@plannotator/core/inbox-types" {
  interface InboxRun {
    /** Optional native host Open destination (the host's `routeHost`); absent means Terminal. */
    open_in?: string;
  }
}

/**
 * Every agent of Plannotator's launch list that Orca runs as a native chat (Orca's structured sessions: Claude,
 * Codex and Pi through their own runtimes, OpenCode through ACP).
 */
export const ORCA_LAUNCH_AGENTS: readonly (readonly [InboxLaunchAgent, string])[] = [
  ["claude-code", "Claude in Orca"],
  ["codex", "Codex in Orca"],
  ["opencode", "OpenCode in Orca"],
  ["pi", "Pi in Orca"],
];

interface NativeRow {
  busy: boolean | null;
  state: string;
  workspaceId: string;
  stopped?: boolean;
}
interface Catalog {
  ok: boolean;
  workspaces: { folder: string; project: string; selector: string }[];
  providers: { id: string; name: string }[];
  sessions: Record<string, NativeRow>;
}
interface Source {
  messageId: string;
  threadId: string;
}
const ID = /^[A-Za-z0-9_-]{1,160}$/;

export function createOrcaLaunchHosts(context: LaunchHostContext): LaunchHost[] {
  if (!orcaMode()) return [];
  const bridge = () => {
    const config = orcaConfig(context.dataDir);
    const navigation = JSON.parse(orcaPrivateRead(join(config.stateDir, "navigation.json")).toString("utf8"));
    const key = orcaPrivateRead(join(config.stateDir, "link-key"), 32);
    if (!Number.isInteger(navigation.port) || navigation.port < 1 || navigation.port > 65535 || navigation.version !== 1 || key.length !== 32) throw Error("The Orca plugin's bridge is unavailable");
    return { port: navigation.port as number, key: key.toString("hex") };
  };
  const request = async (action: string, body?: unknown): Promise<any> => {
    const { port, key } = bridge();
    const response = await fetch(`http://127.0.0.1:${port}/api/lifecycle/${action}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(body === undefined ? 5000 : 45000),
    });
    const reader = response.body?.getReader();
    if (!reader) throw Error("The Orca plugin's bridge did not answer");
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw Error("The Orca plugin's bridge answer exceeded its bound");
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (!response.ok || !result || typeof result !== "object") throw Error("The Orca plugin's bridge refused the action");
    return result;
  };
  const stopped = new Set<string>();
  let last: Catalog | null = null;
  let reading: Promise<Catalog> | null = null;
  let readAt = 0;
  const catalog = async () => {
    if (last && Date.now() - readAt < 2000) return last;
    return (reading ??= request("catalog")
      .then((wire: Catalog) => {
        if (!wire.ok || !Array.isArray(wire.workspaces) || !Array.isArray(wire.providers) || !wire.sessions || typeof wire.sessions !== "object") throw Error("Orca catalog contract changed");
        last = wire;
        readAt = Date.now();
        return wire;
      })
      .finally(() => {
        reading = null;
      }));
  };
  const owned = async (session: string, expectedLaunch?: string) => {
    if (typeof session !== "string" || !ID.test(session)) throw Error("An exact Orca session is required");
    const status = await request("status?session=" + encodeURIComponent(session));
    const entries = status.ok === true && status.version === 1 && status.session === session && status.complete === true && Array.isArray(status.launches) ? status.launches : [];
    if (
      entries.length !== 1 ||
      entries[0]?.session !== session ||
      entries[0]?.state !== "created" ||
      typeof entries[0]?.launchId !== "string" ||
      !ID.test(entries[0].launchId) ||
      (expectedLaunch !== undefined && entries[0].launchId !== expectedLaunch)
    )
      throw Error("No exact, unique Orca launch owns this session");
    return { launchId: entries[0].launchId as string, session, ownerAction: true, actionId: randomUUID() };
  };
  const ownedLaunch = async (launch: InboxLaunchRecord) => {
    if (typeof launch.id !== "string" || !ID.test(launch.id)) throw Error("An exact source launch is required");
    return owned(launch.session_ref!, launch.id);
  };
  const resultOf = (result: any): LaunchHostResult => ({
    exitCode: result.ok === true ? 0 : 1,
    text: result.ok === true ? "Orca accepted the action for this exact chat." : String(result.text || "Orca did not confirm the action."),
  });
  return ORCA_LAUNCH_AGENTS.map(([agent, name]): LaunchHost => {
    let sessionSnapshot: Catalog["sessions"] | null = null;
    return {
      agent,
      name,
      routeHost: "orca",
      connector: "Orca plugin",
      shellNames: [],
      async available(folders) {
        try {
          const data = await catalog();
          return data.providers.some((p) => p.id === agent) && (!folders || folders.some((f) => data.workspaces.some((w) => resolve(w.folder) === resolve(f))))
            ? { ok: true, version: "Orca bridge v1" }
            : { ok: false, missing: false, reason: "Choose a project Orca already has open as a workspace." };
        } catch {
          return { ok: false, missing: false, reason: "Orca or the Orca plugin is not running." };
        }
      },
      // Orca keeps the person's own permissions; the Inbox never writes native trust or bypass settings.
      startOf: () => ({ full: false, ownMode: true, bypass: false }),
      trusts(folder) {
        return !!last?.workspaces.some((w) => resolve(w.folder) === resolve(folder));
      },
      choices: async () => null,
      async start(launch: InboxLaunchRecord, input: { name: string; login: LaunchEnv; source?: Source; reconcile?: boolean }): Promise<{ ok: true; session: string; ref: string } | ({ ok: false } & LaunchStartFailure)> {
        const source = input.source;
        if (!source) return { ok: false, code: "failed", text: "Orca starts a chat only from the message that asked for it." };
        const result = await request("start", {
          launchId: launch.id,
          ...source,
          provider: agent,
          folder: launch.folder,
          model: launch.model,
          effort: launch.effort,
          ownerAction: true,
          reconcile: input.reconcile === true,
        });
        if (result.ok !== true || typeof result.session !== "string" || result.ref !== result.session)
          return { ok: false, code: "failed", text: String(result.text || "Orca did not confirm the chat; no other chat was started.") };
        return { ok: true, session: result.session, ref: result.ref };
      },
      async sessions() {
        try {
          const data = await catalog();
          sessionSnapshot = data.sessions;
          for (const [sid, row] of Object.entries(data.sessions)) {
            if (row.stopped) stopped.add(sid);
            else if (row.busy) stopped.delete(sid);
          }
          return (ref) => {
            const row = data.sessions[ref];
            return row ? { status: row.busy === true ? "running" : row.busy === false ? "idle" : null, state: row.state, waitingFor: null } : "absent";
          };
        } catch {
          sessionSnapshot = null;
          return null;
        }
      },
      live(session) {
        if (stopped.has(session)) return null;
        const live = context.bridge.runStateOf(session);
        // Upstream caches sessions for ten seconds and ignores busy:null polls. Keep "unknown" for the consumed
        // snapshot's lifetime; a refresh or failure replaces it. Presence still comes only from the live bridge.
        return live && sessionSnapshot?.[session]?.busy === null ? { ...live, busy: null, busySince: null } : live;
      },
      async resume(launch) {
        const result = await request("resume", await ownedLaunch(launch));
        if (result.ok === true) {
          stopped.delete(launch.session_ref!);
          last = null;
          sessionSnapshot = null;
        }
        return { ...resultOf(result), failure: result.ok === true ? null : { code: "failed", text: String(result.text || "Orca kept the chat; the reply waits in the Inbox.") } };
      },
      async stop(ref) {
        const result = await request("stop", await owned(ref));
        if (result.ok === true) {
          stopped.add(ref);
          last = null;
        }
        return resultOf(result);
      },
      async open(launch) {
        return resultOf(await request("open", await ownedLaunch(launch)));
      },
      async remove(ref) {
        return resultOf(await request("resume", { ...(await owned(ref)), removeAssociation: true }));
      },
      async purge() {
        return { exitCode: 0, text: "Orca keeps the workspace and the chat's history." };
      },
      attach: () => null,
      terminal: () => {
        throw Error("Open this chat in Orca; the Orca build starts no separate agent process.");
      },
      permissions: () => ({ sweep() {}, withdrawAll() {} }),
      stoppedNote: () => "Orca keeps this chat. A new reply continues it.",
      async deliver(launch, _text, _signal): Promise<LaunchDelivery> {
        const result = await request("resume", { ...(await ownedLaunch(launch)), deliver: true });
        return result.state === "acknowledged" ? "delivered" : result.state === "queued" ? "hold" : { uncertain: String(result.text || "Orca has not confirmed the delivery yet.") };
      },
    };
  });
}
