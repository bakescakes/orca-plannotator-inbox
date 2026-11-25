# Staying working through updates

This page covers what the plugin relies on in Orca and Plannotator, how it checks that at run
time, and how CI tests it against new releases.

Orca and Plannotator both update themselves. The plugin depends on a small surface of each and
checks all of it at run time.

## Plannotator

The plugin uses the registry file (`<data>/inbox/inbox.json`, read again on every call because the
token and port change on restart), `GET /api/inbox/health`, `POST /api/inbox/bridge/poll` and
`bridge/event`, and the stdio MCP server.

**Connect agents** also uses `/api/inbox/control/orca-agents` (the Orca build), or
`GET /api/inbox/agents` and `POST /api/inbox/control/connect` (standard Plannotator); an answer it
cannot read is reported, and Claude Code, Codex and OpenCode are connected all the same. Agent
icons and bot pictures use `GET`/`POST /api/inbox/agent-faces` and `POST /api/inbox/agent-icons`.

Which identity fields a tool takes is read from the server's own `tools/list`, so new or renamed
tools need no change here. The one rule kept by name follows Plannotator's own shim:
`resolve_message` gets the chat's session only when it moves the thread's questions (`moved_to`);
a plain archive goes as written. Unknown fields are ignored or passed along.

## Orca

The plugin uses plugin Host API 1 (frozen and additive), and these CLI calls with `--json`:
`status`, `worktree ps`, `repo list`, `worktree activate`, `orchestration
send|request-show|inbox`, and `agent-context` (Orca's own command list, read once to learn
whether `orchestration send` takes `--body-file`; an Orca whose argument check refuses that flag
is remembered as one without it, and the same request goes again with `--body`), and `agent read`
(once per wait, to learn whether a waiting chat holds a permission or a question; without it
nothing is shown).

A bot's picture is read from `bot.json` and `avatar.png` in its home and from the mascots in the
app's own files; when one of them changes shape, the bot's chat shows its agent's mark.

Bringing one exact chat tab forward uses a call Orca does not publish; when an Orca update changes
it, the link opens the chat's workspace instead.

The worker runs the CLI that ships inside the same Orca, so the two are always the same version.

## The Orca build

The Orca build follows Plannotator's releases by itself (see
[The Orca build of Plannotator](orca-build.md)). Its changes are kept as small edits, each found
by the text of the line it changes rather than by line number, plus whole added files, and CI
applies them to each new Plannotator release. An edit whose line has moved or been reindented
still fits; one whose line is gone or now means something else is refused, never guessed.

A refused edit leaves out only its own group and feature (a
[reduced build](orca-build.md#reduced-builds)). Only the core group, which turns on Orca mode and
the MCP command, stops the build: then no build is published and the plugin keeps the one it has.
A daily CI check tries the edits on Plannotator's unreleased `main` and opens an issue when one no
longer fits, so it can be refitted before the release
([`plannotator/README.md`](../plannotator/README.md)).

## The launcher

The launcher lives in `~/.orca-plannotator-inbox`, not in the plugin's folder, because Orca
replaces that folder on every plugin update. It is rewritten each time Orca starts, so agent
settings never point at a stale path.

## Profiles

An installed plugin asks the Orca whose profile it is installed in, so a second profile (a dev
build, `orca serve` with its own data folder) delivers to its own chats. Only Orca's exact
installed layout counts, in a folder that belongs to you and that nobody else can write to; the
worker's log says which profile it uses.

## When something changes shape

When a shape changes in a way the plugin does not understand, it stops polling instead of
guessing: replies stay saved in the Inbox, the panel says what is wrong, and agents are no longer
told that replies arrive by themselves.

## Daily CI

CI runs every day against the newest released Orca and Plannotator (`.github/workflows/ci.yml`),
so a breaking update shows up as a failed run rather than as a missing reply. It has six jobs:

- an end-to-end run with the real, unmodified `plannotator` binary, through the launcher as an
  agent's settings run it, on macOS,
- the same tests and end-to-end run on Linux, and on Windows,
- the plugin inside a real Orca, across an update, on macOS and on Linux: the previous Orca and
  Plannotator releases start in a throwaway profile, the plugin is installed and delivers a reply
  to a real native chat; then the newest releases take over the same profile and the same Inbox
  data, nothing is installed or connected again, and a second reply has to arrive, and
- the plugin inside a real Orca on Windows with the newest releases: installed, and a reply
  delivered to a real native chat. There is no update half there, because the Windows installer
  keeps one Orca.

That update test passed locally from Orca 1.4.258 and Plannotator 0.28.63 to Orca 1.4.261 and
Plannotator 0.28.66.
