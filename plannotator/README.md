# The Orca build of Plannotator

The Orca plugin can run Plannotator's Inbox as an Orca build: stock Plannotator from its official release tag,
plus three small patches and four added files. This folder holds them, the gates that admit a build, and the build
script CI uses (`.github/workflows/orca-build.yml`).

## What the Orca build changes

Orca mode is on only when both `PLANNOTATOR_ORCA_MODE=1` and `PLANNOTATOR_ORCA_CONFIG=<absolute path>` are set.
With either missing, the binary behaves exactly as stock Plannotator. The one exception is `mark:<host>` faces
(below), which work in both modes because they only change how an icon is drawn.

In Orca mode:

- **Projects.** Projects from the Orca plugin's catalog show in the Inbox before their first message.
- **Connection card.** Settings → About shows the Orca connection, from `GET /api/inbox/orca`. That route is a
  summary only: no tokens, session ids or native commands. Its `features` field lists what this build supports.
- **MCP.** Every MCP connect path writes the plugin's `mcpCommand`.
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
- **Agent marks.**
  - Rows for the host `orca` read "Orca".
  - A face `mark:<host>`, saved through the existing `POST /api/inbox/agent-faces`, draws that host's own mark and
    animated rig. The plugin uses this to show each Orca chat as the agent it runs.
  - Copilot, OMP, Antigravity and Kimi get marks too (`orca-marks.tsx`).

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
| `patches/orca-host.patch` | `inbox-launch.ts`: a launch host may route as `orca`, start with its source message, open natively, and refuse a Stop. |
| `patches/interop-surface.patch` | Connects the Orca surface to the Inbox server: the route, MCP command, projects, updater, About card and Open in Orca. |
| `patches/agent-marks.patch` | `mark:<host>` faces, the host name "Orca", and the hook for the extra marks. |
| `modules/…` | Added files, at their paths in the Plannotator tree. |
| `tests/orca-*.ts` | Gates: MCP identity, the real routes in Orca mode (owner-only tailnet), and the full proof: stock mode, updates, marks and launch requests. |
| `recipe.json` | Tag and commit, Bun pin, patch order, module paths, the sha256 of every file, and the build steps. |
| `build.mjs` | The build (Node built-ins only). |
| `../.github/workflows/orca-build.yml` | The GitHub Actions workflow that builds, checks and publishes it. |

## Build

```sh
node build.mjs --version 0.28.66 --target darwin-arm64 --out dist/plannotator-orca-darwin-arm64
```

Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`.

`build.mjs` does the following:

1. Clones the tag and checks it against the commit in `recipe.json`. For another version, pass `--commit`.
2. Checks every file in this folder against `recipe.json`.
3. Runs `git apply --check` on each patch, then applies it.
4. Runs the build steps and compiles the binary.
5. Runs the gates, then `--version` when the binary can run on this machine.
6. Prints the binary's sha256.

It downloads the pinned Bun from the npm registry and checks its sha512 against `recipe.json`. If a patch no longer
applies, it exits 3 with one line naming the patch.

After changing a file here, update its sha256 in `recipe.json`.
