/**
 * The Orca build of Plannotator: its server surface (added by the Orca plugin's build; see that build's README).
 *
 * Orca mode is on only when PLANNOTATOR_ORCA_MODE=1 AND PLANNOTATOR_ORCA_CONFIG names an absolute path. With either
 * missing every export here is inert and the Inbox behaves exactly as stock Plannotator.
 *
 * In Orca mode this module:
 * - imports the projects of the plugin's bridge (`GET /api/lifecycle/catalog`) so they show before their first message;
 * - answers `GET /api/inbox/orca`, the connection card's aggregate (never a token, session id or native command);
 * - gives every MCP connect path the plugin's MCP command (`mcpCommand`);
 * - routes Update now, the update button and Settings → About through the plugin's updater (`upgradeCommand`), and
 *   reflects its state file (`upgradeStateFile`) in the stock update model, so progress and failure show where a
 *   stock update's would.
 *
 * Config (owner-only JSON): {"v":1,"canonicalDataDir","dataDirs","stateDir","mcpCommand":[1-3 absolute strings],
 * "upgradeCommand":[absolute program, then plain arguments],"upgradeStateFile","upgradeBackoffMs"}.
 */
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { InboxUpdate } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxUpdateDetails } from "./inbox-updates";
import { releaseUrlFor } from "@plannotator/shared/update-check";

const WINDOWS = process.platform === "win32";
const STABLE = /^\d+\.\d+\.\d+$/;
const PHASES = ["queued", "resolving", "building", "staged", "activating", "ready", "failed", "rolled-back"] as const;
type Phase = (typeof PHASES)[number];
const IN_PROGRESS: readonly Phase[] = ["queued", "resolving", "building", "staged", "activating"];
/** The features this Orca build offers the plugin (`GET /api/inbox/orca`). */
export const ORCA_BUILD_FEATURES = ["mark-faces", "update-state", "update-detail", "launch-hosts"] as const;
export const ORCA_UPDATER_LABEL = "Orca build updater (keeps the Orca integration)";
const DETAIL_MAX = 300;

/** Orca mode: both variables set, the config path absolute. No default path exists. */
export function orcaMode(): boolean {
  const path = process.env.PLANNOTATOR_ORCA_CONFIG;
  return process.env.PLANNOTATOR_ORCA_MODE === "1" && typeof path === "string" && path.length > 0 && isAbsolute(path);
}

/**
 * An owner-only private file, bounded. On POSIX: a regular file of this user, no group/other bits, never followed
 * through a symlink. On Windows the owner and mode checks do not exist (no uid, no POSIX modes, no O_NOFOLLOW): the
 * file must still be a regular, non-symlink file within its bound, and the checks are skipped without throwing.
 */
export function orcaPrivateRead(path: string, max = 65536): Buffer {
  if (!isAbsolute(path)) throw Error("Orca private files are named by absolute paths");
  if (lstatSync(path).isSymbolicLink()) throw Error("Orca private file is a symbolic link");
  const flags = WINDOWS ? constants.O_RDONLY : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const fd = openSync(path, flags);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > max) throw Error("Orca private file unavailable");
    if (!WINDOWS && (info.uid !== process.getuid?.() || info.mode & 0o077)) throw Error("Orca private file is not owner-only");
    const raw = readFileSync(fd);
    if (raw.byteLength > max) throw Error("Orca private file exceeds its bound");
    return raw;
  } finally {
    closeSync(fd);
  }
}

const absolute = (value: unknown): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0") && isAbsolute(value);
const plain = (value: unknown): value is string => typeof value === "string" && !value.includes("\0");

export interface OrcaConfig {
  v: 1;
  canonicalDataDir: string;
  dataDirs: string[];
  stateDir: string;
  mcpCommand: string[];
  upgradeCommand: string[] | null;
  upgradeStateFile: string | null;
  upgradeBackoffMs: number | null;
}

/** The config, checked against the contract and against this Inbox's data folder. Throws when it does not hold. */
export function orcaConfig(dataDir: string): OrcaConfig {
  if (!orcaMode()) throw Error("Orca mode is off");
  const c = JSON.parse(orcaPrivateRead(process.env.PLANNOTATOR_ORCA_CONFIG!).toString("utf8"));
  if (!c || typeof c !== "object" || c.v !== 1) throw Error("Orca config version unsupported");
  if (!absolute(c.canonicalDataDir) || resolve(c.canonicalDataDir) !== resolve(dataDir)) throw Error("This Inbox is not the Orca plugin's canonical Inbox");
  if (!absolute(c.stateDir)) throw Error("Orca config needs an absolute stateDir");
  if (!Array.isArray(c.mcpCommand) || c.mcpCommand.length < 1 || c.mcpCommand.length > 3 || !c.mcpCommand.every(absolute)) throw Error("Orca config needs an mcpCommand of 1 to 3 absolute paths");
  const upgrade = Array.isArray(c.upgradeCommand) && c.upgradeCommand.length > 0 && absolute(c.upgradeCommand[0]) && c.upgradeCommand.every(plain) ? [...c.upgradeCommand] : null;
  return {
    v: 1,
    canonicalDataDir: c.canonicalDataDir,
    dataDirs: Array.isArray(c.dataDirs) ? c.dataDirs.filter(absolute) : [],
    stateDir: c.stateDir,
    mcpCommand: [...c.mcpCommand],
    upgradeCommand: upgrade,
    upgradeStateFile: absolute(c.upgradeStateFile) ? c.upgradeStateFile : null,
    upgradeBackoffMs: typeof c.upgradeBackoffMs === "number" && Number.isFinite(c.upgradeBackoffMs) ? c.upgradeBackoffMs : null,
  };
}

/**
 * The MCP argv every connect path writes and recognizes (inbox-agents.ts) and the settings' `mcp_command`: the
 * plugin's `mcpCommand` in Orca mode, else upstream's `<cli> inbox mcp`. A missing or malformed one refuses rather
 * than writing an entry that would bypass the Orca plugin.
 */
export function orcaMcpCommand(dataDir: string, fallback: readonly string[]): string[] {
  if (!orcaMode()) return [...fallback];
  return orcaConfig(dataDir).mcpCommand;
}

/** One plain sentence: no control characters, bounded. */
function plainDetail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > DETAIL_MAX ? text.slice(0, DETAIL_MAX - 1) + "…" : text;
}

const newer = (a: string, b: string) => {
  if (!STABLE.test(a) || !STABLE.test(b)) return false;
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
};

export interface OrcaUpgradeState {
  phase: Phase;
  version: string | null;
  /** Seconds. */
  at: number;
  detail: string | null;
}

interface RouteContext {
  json: (body: unknown, status?: number) => Response;
  /** Upstream's same-origin read guard (inbox.ts `crossSiteCardRead`). */
  crossSite: (req: Request) => Response | null;
}

/** The parts of upstream's update control (inbox-updates.ts `createInboxUpdates`) the Orca build takes over. */
export interface OrcaUpdatesControl {
  current(): InboxUpdate | null;
  details(): InboxUpdateDetails;
  knownLatest(): string | null;
  updateNow(): Promise<{ outcome: string; version?: string }>;
  machineStart(): Promise<{ outcome: string }>;
  selfUpdates(): boolean;
}

export interface OrcaSurfaceHooks {
  /** The imported projects changed: the windows redraw their project lists. */
  onChange?: () => void;
  /** The update model changed: the windows' status streams carry it. */
  onUpdateChange?: () => void;
  /** Upstream's update control, taken over in Orca mode (its methods replaced in place; inert otherwise). */
  updates?: OrcaUpdatesControl;
  /** Upstream's update-check and auto-update preferences, both required for an automatic update. */
  autoOn?: () => boolean;
  now?: () => number;
  /** Tests: run the updater argv instead of spawning it. */
  launch?: (argv: string[], log: number) => Promise<void>;
  /** Tests: the automatic-update tick (default 60 s) and the update-state poll (default 3 s). */
  tickMs?: number;
  pollMs?: number;
}

export function createOrcaSurface(dataDir: string, store: Pick<InboxStore, "ensureProject">, version: string, hooks: OrcaSurfaceHooks = {}) {
  const now = () => (hooks.now ? hooks.now() : Date.now());
  const enabled = orcaMode;
  const config = () => orcaConfig(dataDir);
  let launching: Promise<{ ok: true; queued: boolean; version?: string | null; joined?: true; backoff?: true }> | null = null;
  const imported = new Set<string>();
  let syncing: Promise<void> | null = null;
  let lastSync = 0;

  const read = async (path: "/api/health" | "/api/lifecycle/catalog") => {
    const c = config();
    const nav = JSON.parse(orcaPrivateRead(join(c.stateDir, "navigation.json")).toString("utf8"));
    const key = orcaPrivateRead(join(c.stateDir, "link-key"), 32);
    if (nav.version !== 1 || !Number.isInteger(nav.port) || nav.port < 1 || nav.port > 65535 || key.length !== 32) throw Error("Orca bridge unavailable");
    const response = await fetch(`http://127.0.0.1:${nav.port}${path}`, {
      headers: { Authorization: `Bearer ${key.toString("hex")}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.body) throw Error("Orca bridge unavailable");
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw Error("Orca bridge response too large");
      }
      chunks.push(part.value);
    }
    const raw = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      raw.set(chunk, at);
      at += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(raw));
  };

  const sync = async () => {
    if (syncing) return syncing;
    if (!enabled() || now() - lastSync < 30000) return;
    return (syncing ??= (async () => {
      lastSync = now();
      const directory = await read("/api/lifecycle/catalog");
      if (directory.ok !== true || !Array.isArray(directory.projects) || directory.projects.length > 1000) throw Error("Orca project catalog unavailable");
      const next = new Set<string>();
      for (const p of directory.projects) {
        if (!p || !absolute(p.root) || p.root.length > 4096 || typeof p.name !== "string" || !p.name.trim() || p.name.length > 200) throw Error("Orca project catalog changed");
        next.add(resolve(p.root));
      }
      const changed = next.size !== imported.size || [...next].some((root) => !imported.has(root));
      imported.clear();
      for (const root of next) imported.add(root);
      for (const p of directory.projects) store.ensureProject({ name: p.name, root: resolve(p.root) });
      // A notification before the windows' listeners exist is moot: nothing is open yet.
      if (changed) {
        try {
          hooks.onChange?.();
        } catch {}
      }
    })().finally(() => {
      syncing = null;
    }));
  };

  // ── The plugin's updater ───────────────────────────────────────────────────────────────────────────────────────
  const attemptPath = (c: OrcaConfig) => join(c.stateDir, "update-attempt.json");
  const attemptOf = (c: OrcaConfig) => {
    try {
      return JSON.parse(orcaPrivateRead(attemptPath(c)).toString("utf8"));
    } catch {
      return null;
    }
  };
  const writeAttempt = (c: OrcaConfig, value: unknown) => {
    const path = attemptPath(c), temp = path + "-" + randomUUID();
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (WINDOWS ? 0 : constants.O_NOFOLLOW ?? 0);
    const fd = openSync(temp, flags, 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  };
  const upgradeConfigured = () => {
    try {
      return config().upgradeCommand !== null;
    } catch {
      return false;
    }
  };
  const stateOf = (value: any): OrcaUpgradeState | null => {
    if (!value || typeof value !== "object" || !(PHASES as readonly unknown[]).includes(value.phase)) return null;
    return {
      phase: value.phase,
      version: typeof value.version === "string" && STABLE.test(value.version) ? value.version : null,
      at: Number.isFinite(value.at) ? value.at : 0,
      detail: plainDetail(value.detail),
    };
  };
  /** The newer of the updater's state file and this Inbox's own attempt record. */
  const upgradeState = (): OrcaUpgradeState | null => {
    let c: OrcaConfig;
    try {
      c = config();
    } catch {
      return null;
    }
    let state: OrcaUpgradeState | null = null;
    try {
      if (c.upgradeStateFile) state = stateOf(JSON.parse(orcaPrivateRead(c.upgradeStateFile).toString("utf8")));
    } catch {}
    const attempt = stateOf(attemptOf(c));
    if (attempt && (!state || attempt.at > state.at)) state = attempt;
    return state;
  };

  const queueUpgrade = async (target: string | null, automatic = false) => {
    const c = config();
    if (!target || !STABLE.test(target)) throw Error(`No newer stable release is known, so ${version} stays in use.`);
    const prior = attemptOf(c), state = upgradeState(), at = now() / 1000;
    const backoff = c.upgradeBackoffMs !== null ? Math.max(60000, Math.min(86400000, c.upgradeBackoffMs)) : 21600000;
    if (state && IN_PROGRESS.includes(state.phase) && at - state.at < 7200) return { ok: true as const, queued: true, joined: true as const, version: state.version };
    if (automatic && prior?.version === target && Number.isFinite(prior.at) && at - prior.at < backoff / 1000) return { ok: true as const, queued: false, backoff: true as const, version: target };
    const argv = c.upgradeCommand;
    if (!argv) throw Error(`The Orca build updater is not configured, so ${version} stays in use.`);
    // The updater owns its own state file (with `detail`), staging, activation and rollback; this Inbox only starts it.
    writeAttempt(c, { phase: "queued", version: target, at, automatic });
    const failed = (detail: string) => writeAttempt(c, { phase: "failed", version: target, at: now() / 1000, automatic, detail });
    let log: number;
    try {
      log = openSync(join(c.stateDir, "update.log"), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | (WINDOWS ? 0 : constants.O_NOFOLLOW ?? 0), 0o600);
    } catch (error) {
      failed(`The Orca build updater could not open its log, so ${version} stays in use.`);
      throw error;
    }
    try {
      if (!WINDOWS) {
        const info = fstatSync(log);
        if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077) throw Error("Unsafe Orca update log");
      }
      const command = [...argv, "--version", target];
      if (hooks.launch) await hooks.launch(command, log);
      else
        await new Promise<void>((yes, no) => {
          // argv[0] is an executable, never a shell line. On Windows the plugin names cmd.exe itself
          // (["…\\cmd.exe", "/d", "/c", "…\\plannotator-update.cmd"]), since a .cmd cannot be spawned without a shell.
          const child = spawn(command[0]!, command.slice(1), {
            cwd: WINDOWS ? process.env.SystemRoot || "C:\\" : "/",
            detached: true,
            windowsHide: true,
            stdio: ["ignore", log, log],
            env: { ...process.env, NODE_OPTIONS: undefined, BUN_OPTIONS: undefined },
          });
          child.once("error", () => no(Error(`The Orca build updater could not start, so ${version} stays in use.`)));
          child.once("exit", (code) => {
            // The updater writes its state file with `detail` (exit 0 ok or busy, 1 failed, 2 rolled back). Only a
            // failure it did not record is recorded here, so its own sentence is never hidden.
            try {
              if (code === 0) return;
              const current = attemptOf(c), latest = upgradeState();
              if (current?.version === target && current.at === at && (!latest || latest.at <= at))
                failed(`The Orca build updater stopped before it said why (exit ${code ?? "signal"}), so ${version} stays in use.`);
            } catch {
              /* A diagnostic write must never end the Inbox. */
            }
          });
          child.once("spawn", () => {
            child.unref();
            yes();
          });
        });
    } catch (error) {
      failed(error instanceof Error && /stays in use/.test(error.message) ? error.message : `The Orca build updater could not start, so ${version} stays in use.`);
      throw error;
    } finally {
      closeSync(log);
    }
    return { ok: true as const, queued: true, version: target };
  };
  const upgrade = (target: string | null, automatic = false) =>
    (launching ??= queueUpgrade(target, automatic).finally(() => {
      launching = null;
    }));
  const autoUpgrade = (target: string | null, on: boolean) => {
    if (!enabled() || !on || !target || !newer(target, version)) return Promise.resolve({ ok: true as const, queued: false });
    return upgrade(target, true);
  };

  /**
   * The stock update model with the Orca updater's state on it: `updating` while it works, `ready` when another
   * version was activated, `failed` (with its `detail` in the failure dialog) when it failed or rolled back, and the
   * stock `available` otherwise, as a script update (Update now runs the Orca build updater).
   */
  const orcaCurrent = (stock: InboxUpdate | null): InboxUpdate | null => {
    const state = upgradeState();
    const base = (target: string, phase: InboxUpdate["state"]): InboxUpdate => ({
      ...(stock && stock.version === target ? stock : {}),
      available: true,
      state: phase,
      version: target,
      current: version,
      action: "script",
      releaseUrl: stock?.version === target ? stock.releaseUrl : releaseUrlFor(target),
    });
    if (state?.version && state.version !== version) {
      if (IN_PROGRESS.includes(state.phase) && now() / 1000 - state.at < 7200) return base(state.version, "updating");
      if (state.phase === "ready" && newer(state.version, version)) return base(state.version, "ready");
      if ((state.phase === "failed" || state.phase === "rolled-back") && newer(state.version, version)) {
        // A failure older than a newer known release gives way to that release.
        if (!stock || stock.version === state.version || !newer(stock.version, state.version)) return base(state.version, "failed");
      }
    }
    if (!stock) return null;
    return upgradeConfigured() ? { ...stock, action: "script" } : stock;
  };

  const takeOver = (updates: OrcaUpdatesControl) => {
    const stock = { current: updates.current.bind(updates), details: updates.details.bind(updates) };
    updates.current = () => orcaCurrent(stock.current());
    updates.details = () => {
      const details = stock.details();
      const update = updates.current();
      const state = upgradeState();
      let log = details.log;
      try {
        log = join(config().stateDir, "update.log");
      } catch {}
      const failed = update?.state === "failed" && state && state.version === update.version;
      return {
        ...details,
        update,
        command: ORCA_UPDATER_LABEL,
        auto_update: { ...details.auto_update, supported: upgradeConfigured() },
        log,
        failure: failed
          ? { exit_code: state.phase === "rolled-back" ? 2 : 1, log, ...(state.detail ? { detail: state.detail } : {}) }
          : null,
      } as InboxUpdateDetails;
    };
    const run = async () => {
      const target = updates.knownLatest() ?? upgradeState()?.version ?? null;
      try {
        const result = await upgrade(target);
        pollNow();
        return result.queued ? { outcome: "launched", version: result.version ?? target ?? version } : { outcome: "up-to-date" };
      } catch {
        pollNow();
        return { outcome: "launch-failed", version: target ?? version };
      }
    };
    updates.updateNow = run;
    updates.machineStart = async () => {
      const result = await run();
      return { outcome: result.outcome === "launched" ? "joined" : result.outcome };
    };
    updates.selfUpdates = () => upgradeConfigured();
  };

  // The update model is pushed to the windows when the updater's state changes.
  let seen = "";
  const pollNow = () => {
    if (!enabled() || !hooks.updates) return;
    const model = JSON.stringify([hooks.updates.current(), upgradeState()]);
    if (model === seen) return;
    seen = model;
    try {
      hooks.onUpdateChange?.();
    } catch {}
  };

  const health = async () => {
    if (!enabled()) return null;
    let h: any = null;
    try {
      h = await read("/api/health");
    } catch {}
    const number = (v: unknown) => (Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : 0);
    const valid = h?.version === 1 && ["ready", "waiting", "error"].includes(h?.level) && typeof h?.fresh === "boolean";
    const level = valid && h.level === "ready" && h.fresh === true ? "ready" : valid && h.level === "error" ? "error" : "waiting";
    return {
      version: 1,
      mode: "orca",
      upstreamVersion: version,
      features: [...ORCA_BUILD_FEATURES],
      connected: level === "ready",
      health: {
        level,
        title: level === "ready" ? "Connected" : level === "error" ? "Needs attention" : valid && h.fresh === true && number(h.connected) === 0 ? "No conversations connected" : "Reconnecting",
        detail:
          level === "ready"
            ? "The Orca plugin delivers replies to the exact Orca chats they belong to."
            : level === "error"
              ? "A reply needs attention. It remains saved in the Inbox."
              : "Replies remain saved while the Orca plugin reconnects.",
        connected: number(h?.connected),
        conversations: number(h?.conversations),
        delivered: number(h?.delivered),
        waiting: number(h?.waiting),
        blocked: Array.isArray(h?.blocked) ? h.blocked.length : number(h?.blocked),
        fresh: valid && h.fresh === true,
      },
      projects: { imported: imported.size },
      upgrade: { managed: true, configured: upgradeConfigured(), state: upgradeState() },
    };
  };

  const isImported = (root: string) => enabled() && imported.has(resolve(root));
  /** Projects of the plugin's catalog stay visible before their first message; counts stay upstream's. */
  const markImported = <T extends { root: string }>(projects: T[]): (T & { orca_imported?: true })[] =>
    enabled() ? projects.map((project) => (isImported(project.root) ? { ...project, orca_imported: true as const } : project)) : projects;

  /**
   * The request seam, asked before upstream's own routes (every request that reaches it is the owner's: upstream
   * refuses any other tailnet identity). Null: upstream answers. Never a provider action.
   */
  const route = async (req: Request, path: string, ctx: RouteContext): Promise<Response | null> => {
    if (!enabled()) return path === "/api/inbox/orca" ? ctx.json({ error: "Orca mode is off." }, 404) : null;
    // A same-origin list read refreshes the plugin's projects (debounced); another site's read never does.
    if (path === "/api/inbox/threads" && req.method === "GET") {
      if (!ctx.crossSite(req)) void sync().catch(() => {});
      return null;
    }
    if (path === "/api/inbox/orca") {
      if (req.method !== "GET") return ctx.json({ error: "Use GET." }, 405);
      const refused = ctx.crossSite(req);
      if (refused) return refused;
      return ctx.json(await health());
    }
    return null;
  };

  if (enabled()) {
    void sync().catch(() => {});
    const updates = hooks.updates;
    if (updates) {
      takeOver(updates);
      seen = JSON.stringify([updates.current(), upgradeState()]);
      const poll = setInterval(pollNow, hooks.pollMs ?? 3000);
      (poll as { unref?: () => void }).unref?.();
      // Automatic updates follow upstream's own preferences, coalesce and back off (autoUpgrade).
      const autoOn = hooks.autoOn ?? (() => false);
      const timer = setInterval(() => {
        try {
          void autoUpgrade(updates.knownLatest(), autoOn()).catch(() => {});
        } catch {}
      }, hooks.tickMs ?? 60000);
      (timer as { unref?: () => void }).unref?.();
    }
  }
  return { enabled, health, sync, upgrade, autoUpgrade, upgradeConfigured, upgradeState, imported: isImported, markImported, route, pollNow };
}
