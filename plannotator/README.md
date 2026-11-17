# The Orca build of Plannotator

The Orca plugin can run Plannotator's Inbox as an Orca build: stock Plannotator from its official release tag,
plus three small patches and six added files. This folder holds them, the gates that admit a build, and the build
and release scripts CI uses (`.github/workflows/orca-build.yml`).

## What the Orca build changes

Orca mode is on only when both `PLANNOTATOR_ORCA_MODE=1` and `PLANNOTATOR_ORCA_CONFIG=<absolute path>` are set.
With either missing, the binary behaves exactly as stock Plannotator. The one exception is `mark:<host>` faces
(below), which work in both modes because they only change how an icon is drawn.

In Orca mode:

- **Projects.** Projects from the Orca plugin's catalog show in the Inbox before their first message.
- **Connection card.** Settings → About shows the Orca connection, from `GET /api/inbox/orca`. That route is a
  summary only: no tokens, session ids or native commands. Its `features` field lists what this build supports.
- **MCP.** Every MCP connect path writes the plugin's `mcpCommand`.
- **Agents route.** `/api/inbox/control/orca-agents` lets the plugin connect and disconnect the agents on this
  computer. It answers only on this computer, with the Inbox token and no `Origin` header, like the other control
  routes. Outside Orca mode it answers 404. A build that has it lists `agents` in `features`.
  - `GET` returns `{"v":1,"agents":[…]}`: one row per agent, with `id`, `label`, `detected`, `state`, `reason`
    and `path`. `state` is one of `orca`, `plannotator`, `tool`, `off`, `other`, `manual`, `absent` and
    `unreadable`.
  - `POST {"action":"connect","except":[…]}` runs Plannotator's own connect first. Then it turns on again the agents
    an earlier disconnect turned off. Last, it moves each `plannotator-inbox` entry that runs Plannotator directly
    to `mcpCommand` and remembers the original. It moves an entry only when a record says Plannotator added exactly
    that entry, or when the entry holds only `command`, `args` and `type: "stdio"`. Any other entry stays as it is,
    and its row says why.
  - `POST {"action":"disconnect","except":[…]}` takes out every entry that runs `mcpCommand`. A moved entry gets
    its original back. Any other agent is left off, and the next connect turns it on again. An agent turned off in
    Settings stays off.
  - `except` names agents the plugin handles itself. This route never moves, restores, turns on or takes out
    their entries.
  - Both answer `{"v":1,"agents":[…],"changed":[…],"problems":[{"agent","reason"}]}`, plus `skipped` when
    `PLANNOTATOR_INBOX_CONNECT` is off (`env`) or a test runs outside a temporary home (`sandbox`).
  - What the route remembers is in `<data dir>/inbox/orca-agents.json`. It writes agent files only through
    Plannotator's own helpers, so their safety checks still apply.
- **Launch hosts.** Claude Code, Codex, OpenCode and Pi start, stop, resume and open as Orca chats through the
  plugin's bridge. Their run line says "Open in Orca". A Stop or Open that Orca refuses shows Orca's reason on
  the run line, and the chat does not read as stopped.
- **Updates.**
  - Update now, the sidebar button and Settings → About run the Orca build updater (`upgradeCommand` with
    `--version x.y.z`).
  - The updater's state file drives the stock update display: "Updating…" while queued, resolving, building,
    staged or activating. When ready, it shows the version as installed.
  - When the update fails or rolls back, the stock "didn't install" dialog shows the updater's `detail` sentence.
  - The stock installer is never run.
- **Agent marks** (optional: the `agent-marks` patch, feature `mark-faces`).
  - Rows for the host `orca` read "Orca".
  - A face `mark:<host>`, saved through the existing `POST /api/inbox/agent-faces`, draws that host's own mark and
    animated rig. The plugin uses this to show each Orca chat as the agent it runs.
  - Copilot, OMP, Antigravity and Kimi get marks too (`orca-marks.tsx`).
  - Settings → Rows → Agent icons "From the project name" never turns a `mark:<host>` face into the project's tile.
  - A build without this patch refuses `mark:<host>` faces, as stock Plannotator does. The plugin then sets none.

| Orca agent | Face |
|---|---|
| claude | `mark:claude-code` |
| codex | `mark:codex` |
| pi | `mark:pi` |
| opencode, opencode2 | `mark:opencode` |
| cursor | `mark:cursor` |
| grok | `mark:grok` |
| antigravity | `mark:antigravity` |
| copilot | `mark:copilot` |
| kimi | `mark:kimi` |
| omp | `mark:omp` |

The config file must be owner-only JSON:

```json
{"v":1,"canonicalDataDir":"/abs","dataDirs":["/abs"],"stateDir":"/abs",
 "mcpCommand":["/abs", "..."],
 "upgradeCommand":["/abs/program", "plain", "arguments"],
 "upgradeStateFile":"/abs","upgradeBackoffMs":21600000}
```

- `mcpCommand` has 1 to 3 parts, all absolute.
- In `upgradeCommand`, only the first part must be absolute. On Windows it is `cmd.exe /d /c <file>.cmd`, because a
  `.cmd` file cannot be spawned without a shell.
- The state file is `{"phase","version","at","detail"}`.
- On Windows the owner and permission checks on private files are skipped. Symbolic links are still refused.

## Files

| Path | What it is |
|---|---|
| `patches/orca-host.patch` | Required. `inbox-launch.ts`: a launch host may route as `orca`, start with its source message, open natively, and refuse a Stop. Feature `launch-hosts`. |
| `patches/interop-surface.patch` | Required. Connects the Orca surface to the Inbox server: the routes, MCP command, projects, updater, About card and Open in Orca. Features `update-state`, `update-detail` and `agents`. |
| `patches/agent-marks.patch` | Optional. `mark:<host>` faces, the host name "Orca", and the hook for the extra marks. Feature `mark-faces`. |
| `modules/…` | Added files, at their paths in the Plannotator tree. `orca-marks.tsx` belongs to `agent-marks`. |
| `modules/packages/server/inbox-orca-build.ts` | What a build carries: its `features` and the patches it left out. `build.mjs` writes it for each build. The copy here is a full build's. |
| `tests/orca-*.ts` | Gates: MCP identity, the real routes in Orca mode (owner-only tailnet), the full proof (stock mode, updates, marks or their absence, and launch requests), the agents route against fake agents in a temporary home (on Windows its guards and list only: upstream's fake agent CLIs are `sh` scripts), and the marks drawn in a DOM (`orca-marks-proof.ts`, part of `agent-marks`). |
| `recipe.json` | Tag and commit, Bun pin, the patches in order (each `required` or not, with the `features` it carries), module paths, the sha256 of every file, and the build steps. |
| `build.mjs` | The build (Node built-ins only). |
| `release.mjs` | Used by the workflow: composes `manifest.json` and the release notes, and decides what a run's issue says. |
| `../.github/workflows/orca-build.yml` | The GitHub Actions workflow that builds, checks and publishes it. |

## Build

```sh
node build.mjs --version 0.28.67 --target darwin-arm64 --out dist/plannotator-orca-darwin-arm64
```

Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`.

`build.mjs` does the following:

1. Clones the tag and checks it against the commit in `recipe.json`. For another version, pass `--commit`.
2. Checks every file in this folder against `recipe.json`. It also checks that `inbox-orca-build.ts` lists every
   feature in `recipe.json`, so the two never drift apart.
3. Runs `git apply --check` on each patch, then applies it.
4. Copies the added files and the gates, and writes what this build carries into `inbox-orca-build.ts`.
5. Runs the build steps and compiles the binary.
6. Runs the gates, then `--version` when the binary can run on this machine.
7. Prints a one-line report: the binary's sha256, the patches applied, the patches left out (with why), and the
   final `features`. It writes the same report to `<out>.build.json`. A failed build writes that file too, with
   `ok: false` and its error line.

It downloads the pinned Bun from the npm registry and checks its sha512 against `recipe.json`.

### Optional patches

A patch with `"required": false` may be left out. Its added files and gates go with it (their `"patch"` field).

- If an optional patch no longer applies, the build leaves it out and goes on. The report gives the first line of
  git's error.
- `--without <patch>` leaves one out on purpose. It can be given more than once. A required patch cannot be left out.
- A build without a patch never lists that patch's features. `GET /api/inbox/orca` serves the list the build wrote.
- The gates read that list. For a feature that is left out, they prove the source is stock where the patch would
  change it.

Exit codes: 0 built, also when an optional patch was left out; 2 usage; 3 a required patch no longer applies; 4 a
gate or check failed; 5 the source or a file here does not match the recipe; 1 anything else.

After changing a file here, update its sha256 in `recipe.json`. After changing a patch's `features`, update
`inbox-orca-build.ts` to match.

`node build.mjs --recipe-hash` prints the sha256 of `recipe.json` and `build.mjs`. Each published build records it.

## Publishing

`.github/workflows/orca-build.yml` builds the newest stable Plannotator release for every target. It publishes
`plannotator-<version>-orca.<n>` and points the `plannotator-orca-index` release at it.

- It looks every 15 minutes, on each push to `main` that changes this folder, and when run by hand.
- It builds a version unless one of that version's builds was made from the same recipe. So a new release gets its
  first build, and a fixed patch gets a new `orca.<n+1>`. The same version and recipe is never published twice.
- A run with nothing to do stops after its first job.
- A failed build is tried again once a day, or at once on a push or by hand.
- Every target must build and pass its gates with the same patches left out. Otherwise nothing is published.
- `manifest.json` lists `features`, `omitted` (the patches left out) and `recipe`, besides the assets and
  `pluginMin`. The release notes say which features a reduced build lacks, and why.
- A reduced or failed build opens one issue. It names the version, the patch or gate, and the first error line. The
  same version and cause gets no second issue, and at most one comment a day. A later full build of that version or a
  newer one closes it.
