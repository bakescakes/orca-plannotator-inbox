# The Orca build of Plannotator

The Orca plugin can run Plannotator's Inbox as an Orca build: stock Plannotator from its official release tag,
plus small edits to Plannotator's own files, kept in eight groups (one per feature), and eight added files. This
folder holds them, the gates that admit a build, and the build and release scripts CI uses
(`.github/workflows/orca-build.yml`, and the daily look at upstream's `main` in `orca-build-main.yml`).

## What the Orca build changes

Orca mode is on only when both `PLANNOTATOR_ORCA_MODE=1` and `PLANNOTATOR_ORCA_CONFIG=<absolute path>` are set.
With either missing, the binary behaves exactly as stock Plannotator. The one exception is `mark:<host>` faces
(below), which work in both modes because they only change how an icon is drawn.

In Orca mode (each item names its group of edits; see [Groups](#groups)):

- **Projects** (`projects`). Projects from the Orca plugin's catalog show in the Inbox before their first message.
- **Connection card** (`about-card`; the route is `orca-mode`'s). Settings → About shows the Orca connection, from `GET /api/inbox/orca`. That route is a
  summary only: no tokens, session ids or native commands. Its `features` field lists what this build supports.
- **MCP** (`orca-mode`). Every MCP connect path writes the plugin's `mcpCommand`.
- **Agents route** (`agents`). `/api/inbox/control/orca-agents` lets the plugin connect and disconnect the agents on this
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
- **Launch hosts** (`launch-hosts`). Claude Code, Codex, OpenCode and Pi start, stop, resume and open as Orca chats through the
  plugin's bridge. Their run line says "Open in Orca". A Stop or Open that Orca refuses shows Orca's reason on
  the run line, and the chat does not read as stopped. A chat whose catalog row says `"waiting": "permission"`
  (it holds a permission prompt in Orca) reads "waiting on a permission prompt"; any other value is ignored.
- **Updates** (`update-state`, and `update-detail` for the failure sentence).
  - Update now, the sidebar button and Settings → About run the Orca build updater (`upgradeCommand` with
    `--version x.y.z`).
  - The updater's state file drives the stock update display: "Updating…" while queued, resolving, building,
    staged or activating. When ready, it shows the version as installed.
  - When the update fails or rolls back, the stock "didn't install" dialog shows the updater's `detail` sentence.
  - The stock installer is never run.
- **Agent marks** (`mark-faces`).
  - Rows for the host `orca` read "Orca".
  - A face `mark:<host>`, saved through the existing `POST /api/inbox/agent-faces`, draws that host's own mark and
    animated rig. The plugin uses this to show each Orca chat as the agent it runs.
  - Copilot, OMP, Antigravity and Kimi get marks too (`orca-marks.tsx`).
  - Settings → Rows → Agent icons "From the project name" never turns a `mark:<host>` face into the project's tile.
  - A build without this group lacks the `mark-faces` feature, so the plugin sets no `mark:<host>` faces. Up to
    0.29.3 it also refuses them, as stock Plannotator does.
  - Plannotator after 0.29.3 (from backnotprop/plannotator#3568) names the host `orca` "Orca", accepts `mark:<host>`
    faces, draws them and keeps them from the project tile itself, in both modes. On it the build leaves those lines
    as Plannotator has them and adds only the extra marks. The marks look and behave the same either way.

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

## Groups

Each group is one file of edits, `edits/<group>.json`, with the added files and gates that belong to it. A group
applies whole or not at all. Every group but the first is optional: a build without it is correct, and only that
group's feature is missing. Each optional group was left out on its own (`--without`) and the build still type-checked,
passed upstream's tests and the remaining gates, and served the shorter `features` list.

| Group | Required | Feature | A build without it |
|---|---|---|---|
| `orca-mode` | yes | none | Is not an Orca build. This group creates the Orca surface the other groups hook into (the config, `orcaMode()`), wakes the plugin's bridge (Plannotator after 0.29.3 wakes a polling Orca chat itself, in either mode), writes `mcpCommand` on every MCP connect path, and serves `GET /api/inbox/orca`, where the plugin reads `features`. Without it, agents would run Plannotator directly and replies could not come back into Orca chats, and the plugin could not tell the binary from stock. So it cannot be left out: when it no longer fits, nothing is published. |
| `launch-hosts` | no | `launch-hosts` | Starts agents as stock Plannotator does, not as Orca chats. The panel says the build lacks starting and stopping chats from the Inbox. |
| `update-state` | no | `update-state` | Shows the stock update display. The Orca build is not at the install script's path, so stock Plannotator calls it a copy that cannot update itself and never runs its installer. The plugin's worker still updates the build. |
| `update-detail` | no, needs `update-state` | `update-detail` | Shows the stock sentence when an update fails. Left out with `update-state`, since the sentence comes from the state that group reads. |
| `agents` | no | `agents` | Has no agents route. The plugin treats it as an older Orca build: Connect still writes the launcher through `orca-mode`, but cannot list, move or take back entries, and the panel says so. |
| `mark-faces` | no | `mark-faces` | The plugin sets no `mark:<host>` faces. Up to 0.29.3 the build refuses them, as stock does; a later Plannotator accepts them itself. |
| `projects` | no | none | Shows an Orca project once its first message arrives, as stock does. |
| `about-card` | no | none | Shows the stock About section. |

`projects` and `about-card` carry no feature because the plugin never acts on them; `manifest.json` still names them in
`omitted` when they are left out.

## Files

| Path | What it is |
|---|---|
| `edits/<group>.json` | One group's edits to Plannotator's own files (format below). |
| `edits.mjs` | Applies edits by content and fails closed (Node built-ins only). `build.mjs` and the plugin's tests use it. |
| `modules/…` | Added files, at their paths in the Plannotator tree. Most of the logic lives here, so the edits stay a line or two each. A file whose recipe entry names a `group` goes with that group. |
| `modules/packages/server/inbox-orca-build.ts` | What a build carries: its `features` and the groups it left out. `build.mjs` writes it for each build. The copy here is a full build's. |
| `tests/orca-*.ts` | Gates: MCP identity (the shim's tool sets must be one it knows: 0.29's, or the later one where `resolve_message` takes the session for `moved_to` only), the real routes in Orca mode (owner-only tailnet), the full proof (stock mode, each group's change or, for a group left out, stock source where it would change it), the agents route against fake agents in a temporary home (on Windows its guards and list only: upstream's fake agent CLIs are `sh` scripts; group `agents`), and the marks drawn in a DOM (group `mark-faces`). |
| `recipe.json` | Tag and commit, Bun pin, the groups in order (each `required` or not, with the `features` it carries and the groups it `needs`), module paths, the sha256 of every file, and the build steps. |
| `build.mjs` | The build (Node built-ins only). |
| `release.mjs` | Used by the workflow: composes `manifest.json` and the release notes, and decides what a run's issue says. |
| `../.github/workflows/orca-build.yml` | The GitHub Actions workflow that builds, checks and publishes it. |
| `../.github/workflows/orca-build-main.yml` | The daily check of the edits against upstream's `main`. |

## Build

```sh
node build.mjs --version 0.29.3 --target darwin-arm64 --out dist/plannotator-orca-darwin-arm64
```

Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`.

`build.mjs` does the following:

1. Clones the tag and checks it against the commit in `recipe.json`. For another version, pass `--commit`.
2. Checks every file in this folder against `recipe.json`, and every edit file against the format. It also checks that
   `inbox-orca-build.ts` lists every feature in `recipe.json`, so the two never drift apart.
3. Applies each group of edits, in the recipe's order.
4. Copies the added files and the gates, and writes what this build carries into `inbox-orca-build.ts`.
5. Runs the build steps, with the type checks and upstream's tests, and compiles the binary.
6. Runs the gates, then `--version` when the binary can run on this machine.
7. Prints a one-line report: the binary's sha256, the groups applied, the groups left out (each with the edit and
   what it found), the final `features`, and the edits Plannotator makes itself (`satisfied`). It writes the same report to `<out>.build.json` (or `--report <file>`). A
   failed build writes it too, with `ok: false` and its error line.

It downloads the pinned Bun from the npm registry and checks its sha512 against `recipe.json`.

Other ways to run it:

- `--fit <checkout>` tries every edit on a Plannotator checkout and changes nothing. It prints which edits fit and,
  for each one that does not, what it found. An edit Plannotator makes itself has `"satisfied": true` and the line
  found (`proof`). Exit 0 every edit fits, 3 the required group does not, 6 only optional
  groups do not.
- `--check-only` applies the edits and runs the type checks, upstream's tests and the gates, without compiling.
  `--gates-only` skips the type checks and tests.
- `node build.mjs --recipe-hash` prints the sha256 of `recipe.json`, `build.mjs` and `edits.mjs`. Each published
  build records it, so a refitted edit gets a new build of the same version.

### Edits

An edit finds its line by the text on it, not by its line number. Each edit in `edits/<group>.json`:

```json
{"id": "settle-route-host",
 "file": "packages/server/inbox-launch.ts",
 "anchor": "to: { host: launch.agent, session: result.session }",
 "replace": [["host: launch.agent", "host: host.routeHost ?? launch.agent"]]}
```

- `anchor`: text the line contains. Indentation and anything else on the line do not matter. An array of texts finds
  the first, then each next one on a following line (within 40 lines); the edit works on the last line found.
- `count`: on how many lines the first text must be (default 1). Any other number refuses the edit, so an edit never
  picks one of two look-alike lines.
- `has`: text the line must also contain. It guards a change in meaning: if upstream changes what the line does, the
  edit is refused instead of applied to code it no longer suits.
- `replace`: pairs of `[from, to]`; `from` must be on the line exactly once.
- `before` / `after`: whole lines put in before or after it, at that line's indentation. Keep them thin: a call into
  an added file, an import, a guard.
- `upstream`: Plannotator's own version of the change, for an edit Plannotator now makes itself (below). A text, or
  an array of texts found like `anchor`; each at least 8 characters, on one line.

Only Plannotator's own lines count as anchors, never a line another edit put in. Edits that put lines at the same
place keep the order they are applied in.

An edit is refused, with what was found, when its anchor is missing or on the wrong number of lines, a `has` text or
a `from` is missing, or the change is already there (an edit is never applied twice). The build also tries each edit a
second time on its own result, and stops if it would apply again.

### When Plannotator makes the change itself

When Plannotator takes in a change an edit makes, the edit names Plannotator's version in `upstream`. The edit then
counts as satisfied, and the build leaves those lines as Plannotator has them, only on positive proof:

- The `upstream` text is on exactly one of Plannotator's own lines. On two or more lines, the edit is refused.
- The edit itself is refused there (its anchor is gone, or its change is already there), or it would still apply
  within 40 lines of that line, so both are about the same place.

Otherwise it fails closed. With no `upstream` line, the edit applies or is refused as before, so neither found is a
refusal. With both found far apart (the edit would apply somewhere else), it is refused: refit it.

A satisfied edit still belongs to its group. The group's features stay, and its gates check the behaviour, whether
Plannotator's own code or the build's provides it. The build report, `--fit`, `manifest.json` (`satisfied`), the
release notes and the daily check name the satisfied edits by `group/id`. Once every Plannotator version the recipe
builds makes the change itself, the edit can be removed.

### Optional groups and reduced builds

A group with `"required": false` may be left out. Its added files and gates go with it (their `"group"` field), and
so does any group that `"needs"` it.

- If any edit of an optional group does not fit, the whole group is left out and the build goes on. The report names
  the edit and what it found.
- If a type check fails only on lines an optional group's edits changed or put in, or in its added files, that group
  is left out and the build starts again from a clean tree. An error anywhere else stops the build.
- `--without <group>` leaves one out on purpose. It can be given more than once. The required group cannot be left
  out.
- A build without a group never lists that group's features. `GET /api/inbox/orca` serves the list the build wrote.
- The gates read that list. For a group that is left out, they prove the source is stock where the group would
  change it.

A build with a group left out is a reduced build. It is published like a full one, and lacks only that group's
feature. The plugin reads `features`, says in its panel what the build lacks, and moves to the full build of that
version once it is published.

Exit codes: 0 built, also when an optional group was left out; 2 usage; 3 the required group no longer fits; 4 a
gate or check failed; 5 the source or a file here does not match the recipe; 1 anything else.

After changing a file here, update its sha256 in `recipe.json`. After changing a group's `features`, update
`inbox-orca-build.ts` to match.

### Refitting an edit

When an edit no longer fits a new Plannotator (the build report, the release issue or the daily check's issue names
it):

1. Check out that Plannotator and run `node build.mjs --fit <checkout>`. It lists each edit that does not fit and
   what it found: the anchor on no line, on two lines, a missing `has` text, or the change already there.
2. Read the upstream change at that place. If only the line's text moved or changed, give the edit a new `anchor`
   (or the new `from` token). If the code now does something else, refused by `has`, change what the edit puts in,
   or the added file it calls, to suit the new code. Do not just loosen the anchor.
3. Update the edit file's sha256 in `recipe.json` and run `--fit` again until every edit fits.
4. Build for one target, or run `--check-only`, so the type checks, upstream's tests and the gates pass.

A refitted edit changes the recipe hash, so CI publishes a new full build (`orca.<n+1>`) of a version whose
build was reduced.

### The daily check against `main`

`.github/workflows/orca-build-main.yml` runs once a day (and by hand). It clones the head of Plannotator's `main`,
runs `--fit` and `--check-only` for `linux-x64`, and compiles, publishes and tags nothing. It keeps one issue:

- opened when an edit no longer fits or a check fails. It names each edit that does not fit, what it found, and the
  upstream commits since `main` last took every edit (from the head it saved when it last fitted, else from this
  recipe's tag);
- rewritten on every run, with a comment only when what no longer fits changes;
- closed when `main` takes every edit again.

An edit `main` makes itself (above) counts as taken. The run's summary and the issue name those edits, by `group/id`
only.

A run that could not check (a download or install failed) changes no issue and fails, so it shows in Actions.

## Publishing

`.github/workflows/orca-build.yml` builds the newest stable Plannotator release for every target. It publishes
`plannotator-<version>-orca.<n>` and points the `plannotator-orca-index` release at it.

- It looks four times an hour (GitHub may start those runs hours late), on each push to `main` that changes this
  folder, and when run by hand.
- It builds a version unless one of that version's builds was made from the same recipe. So a new release gets its
  first build, and a refitted edit gets a new `orca.<n+1>`. The same version and recipe is never published twice.
- A run with nothing to do stops after its first job.
- A failed build is tried again once a day, or at once on a push or by hand.
- Every target must build and pass its gates with the same groups left out. Otherwise nothing is published.
- `manifest.json` lists `features`, `omitted` (the groups left out), `satisfied` (the edits Plannotator makes
  itself) and `recipe`, besides the assets and `pluginMin`. The release notes say which features a reduced build
  lacks, and why, and which edits Plannotator makes itself. Every target must find the same `satisfied`.
- A reduced or failed build opens one issue. It names the version, the group or gate, and the first error line. The
  same version and cause gets no second issue, and at most one comment a day. A later full build of that version or a
  newer one closes it.
