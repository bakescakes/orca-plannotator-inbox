# Plannotator Inbox for Orca

An [Orca](https://github.com/stablyai/orca) plugin that brings your
[Plannotator Inbox](https://plannotator.ai) replies back into the Orca chat that asked.

An agent in a native Orca chat sends you a question through the Plannotator Inbox. You answer in
the Inbox window when you get to it. The answer arrives in that same Orca chat by itself, as its
next turn. Nothing in Plannotator or Orca is patched: the plugin talks to the stock Plannotator
Inbox and to Orca's own CLI.

## Install

You need Orca 1.4.248 or later and Plannotator (`plannotator inbox` run once).

```sh
orca plugin install bakescakes/orca-plannotator-inbox
```

Then, in Orca:

1. Approve the plugin when Orca asks. It runs a worker with your user account's access, stores
   its delivery record in its own plugin storage, and may show a notification.
2. Open the **Plannotator Inbox** panel in the right sidebar and press **Connect agents**. This
   adds one `plannotator-inbox` MCP server to Claude Code and Codex at user level. It is the only
   time the plugin writes outside its own folders, it happens only when you press it, and
   **Disconnect** puts back what was there. An entry that ran Plannotator directly keeps its
   environment settings (such as `PLANNOTATOR_DATA_DIR`) and its binary, so the same Plannotator
   and the same Inbox are used.
3. Start a new chat. Connections apply to chats started afterwards.

The status bar shows an **Inbox** item; pressing it opens the Inbox window.

## What it does

| Piece | Where | Job |
| --- | --- | --- |
| Worker | `src/worker.ts`, `src/engine.ts` | Finds the Orca chats that use the Inbox, holds one reply poll per open chat, hands each reply to the courier. |
| Courier | `src/courier.ts`, `src/ledger.ts` | Delivers one reply to one chat through `orca orchestration send`, exactly once as far as both sides can prove. |
| Launcher | `~/.orca-plannotator-inbox/inbox-mcp` | What agents run as their `plannotator-inbox` MCP server: Plannotator's own `plannotator inbox mcp`, with the Orca chat filled in as the author. |
| Panel | `src/panel.tsx` | Status, the chats that are listening, agent connections, and replies that need you. |

A reply moves through `prepared → sending → accepted → acknowledged`. Each step is saved before
the next program is asked to do anything, with the request id Orca will see, so a crash or a lost
answer resumes the same request instead of sending twice. A lost answer is settled by reading
(Orca's request receipt, then the chat's mailbox, without consuming anything). When reading cannot
settle it, the reply is **blocked** and shown in the panel for you to send again; it also stays in
the Inbox. The Inbox is told a reply was delivered only after Orca's mailbox shows the chat
received it.

Only native Orca chats on this computer are served. Terminal agents keep Plannotator's own
integrations, and chats on SSH, WSL or paired hosts are left alone.

## How agents are told

Plannotator already teaches agents the Inbox: its MCP server sends instructions, `plannotator
inbox --help` is the full guide, and the Inbox sidebar has **Copy connect prompt**. The plugin
adds nothing of its own to an agent's context except four sentences, and is built so those
materials keep working as written:

- **The reply looks like Plannotator's own.** It starts `Plannotator Inbox: <title> (<reply id>)`,
  says how to answer (`send_message` with `reply_to` set to that id), names the thread, carries
  the person's words unchanged and ends with Plannotator's closing line. That is the shape the
  guide tells agents to expect. Anything else the Inbox says about a reply (a hand-off, a tag,
  open questions, fields a later version adds) is passed along as a `Context:` line.
- **`send_message` says the reply arrives by itself**, because the launcher tells Plannotator this
  connection wakes the chat. The agent ends its turn, as the guide says.
- **The connect prompt cannot take a chat off this path.** The guide and the connect prompt tell
  an agent on a plain stdio server to pass its own `agent_host`, and to register `plannotator
  inbox mcp` unless a server "that runs this command" is already set up. In an Orca chat the
  launcher makes the chat the author whatever host the agent names (its `agent_name` is kept),
  and adds a short note to the server's instructions saying the chat is already connected and to
  change nothing. The entry in each agent's settings carries the same note as a comment.
- **When the plugin is off or cannot deliver, the launcher changes nothing.** The agent then
  talks to plain Plannotator, with Plannotator's own identity and wake rules.

If you use Plannotator's own Claude Code plugin, Claude Code is already connected for Orca chats
and **Connect agents** leaves it alone.

## Staying working through updates

Orca and Plannotator both update themselves. The plugin depends on a small surface of each and
checks all of it at run time:

- **Plannotator**: the registry file (`<data>/inbox/inbox.json`, read again on every call because
  the token and port change on restart), `GET /api/inbox/health`, `POST /api/inbox/bridge/poll`
  and `bridge/event`, and the stdio MCP server. Which identity fields a tool takes is read from
  the server's own `tools/list`, so new or renamed tools need no change here. Unknown fields are
  ignored or passed along.
- **Orca**: plugin Host API 1 (frozen and additive), and four CLI calls with `--json`:
  `status`, `worktree ps`, `orchestration send|request-show|inbox`. The worker runs the CLI that
  ships inside the same Orca, so the two are always the same version.
- **The launcher** lives in `~/.orca-plannotator-inbox`, not in the plugin's folder, because Orca
  replaces that folder on every plugin update. It is rewritten each time Orca starts, so agent
  settings never point at a stale path.
- **Profiles**: an installed plugin asks the Orca whose profile it is installed in, so a second
  profile (a dev build, `orca serve` with its own data folder) delivers to its own chats. Only
  Orca's exact installed layout counts, in a folder that belongs to you and that nobody else can
  write to; the worker's log says which profile it uses.

When a shape changes in a way the plugin does not understand, it stops polling instead of
guessing: replies stay saved in the Inbox, the panel says what is wrong, and agents are no longer
told that replies arrive by themselves.

CI runs every day against the newest released Orca and Plannotator (`.github/workflows/ci.yml`),
so a breaking update shows up as a failed run rather than as a missing reply. It has three jobs:

- an end-to-end run with the real, unmodified `plannotator` binary, through the launcher as an
  agent's settings run it,
- the same tests and end-to-end run on Windows, and
- the plugin **inside a real Orca, across an update**: the previous Orca and Plannotator releases
  start in a throwaway profile, the plugin is installed and delivers a reply to a real native
  chat; then the newest releases take over the same profile and the same Inbox data, nothing is
  installed or connected again, and a second reply has to arrive.

That update test passed locally from Orca 1.4.258 and Plannotator 0.28.63 to Orca 1.4.261 and
Plannotator 0.28.66.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Deliver replies to Orca chats | on | Off: replies wait in the Inbox. |
| Notify when a reply needs you | on | A desktop notification when a reply is blocked. |
| Plannotator data folder | empty | Empty follows Plannotator: `PLANNOTATOR_DATA_DIR`, then `~/.plannotator`. |
| Orca CLI path | empty | Empty uses the CLI inside this Orca. |

Commands: **Open Inbox**, **Show Status**, **Connect Agents**, **Disconnect Agents**.

## Limits

- An agent that sends through the `plannotator` command line instead of the MCP tools is not seen
  as an Orca chat. The note in the server's instructions tells agents to use the tools.
- A chat is listened for after its first Inbox message through the launcher (or when the Inbox
  already holds a thread it wrote). A reply that arrives while the chat is closed waits in the
  Inbox and is delivered when the chat is open again.
- At most 64 chats are listened for at once.
- On Windows a reply longer than about 12,000 bytes is not included in the mail; the chat is told
  to read it from the thread. Elsewhere that happens from about 62,000 bytes.
- Two Orca profiles under one user account share the launcher folder. A profile whose plugin is
  switched off does not stop the other from delivering, but the launcher cannot tell which
  profile a chat belongs to, so use the plugin in one profile at a time.
- Uninstalling the plugin leaves the launcher folder and the agent entries. Press **Disconnect**
  first, then delete `~/.orca-plannotator-inbox`.
- On Windows, CI runs the tests and the end-to-end run with the real Plannotator through the
  launcher. The plugin has not been run inside Orca on Windows, nor with a real agent there.

## Development

No build step and no runtime dependencies: Orca loads the TypeScript directly. `package.json`
holds only the type-checker.

```sh
npm ci                      # typescript and @types/node (installed without bin links, on purpose)
orca plugin types .         # writes .orca/types for this Orca
npm run typecheck
orca plugin validate . --json
orca plugin test .          # unit tests, with a stand-in Orca CLI and Inbox
orca plugin check . --json  # renders the panel in each scenario of src/panel.check.ts
```

Against the real programs:

```sh
# A real, unmodified Plannotator in a throwaway HOME. Never touches your Inbox or agent settings.
PLANNOTATOR_E2E_BIN="$(command -v plannotator)" orca plugin test .

# Read-only checks against the running Orca; add a chat's session id to read its mailbox,
# and ORCA_LIVE_SEND=1 to send that chat one marked test mail.
ORCA_LIVE_CLI="$(command -v orca)" orca plugin test .
```

Inside a real Orca, without touching yours:

```sh
# Starts a second, windowless Orca from the app you name, with a throwaway profile and home;
# installs the plugin there, opens a native chat and delivers a real reply to it.
# Add ORCA_INAPP_CLI_BEFORE and PLANNOTATOR_E2E_BIN_BEFORE (older releases) to make it an
# update test on one profile. Needs `claude` installed; it is never signed in there.
ORCA_INAPP_CLI=/path/to/Orca.app/Contents/Resources/bin/orca \
PLANNOTATOR_E2E_BIN="$(command -v plannotator)" orca plugin test .
```

With a real, signed-in agent, in your own Orca:

```sh
# Opens one new Claude chat in the workspace you name and spends a few model turns. The chat
# asks through the launcher into a throwaway Inbox, is answered, is woken by the reply and
# answers it. Writes .mcp.json and .claude/settings.local.json there for the length of the test.
ORCA_LIVE_CLI="$(command -v orca)" ORCA_LIVE_AGENT_WORKTREE=/path/to/an/open/workspace \
PLANNOTATOR_E2E_BIN="$(command -v plannotator)" orca plugin test .
```

Under `orca plugin test` and `orca plugin check` the worker runs in preview mode and never reads
or writes the machine: no Inbox, no Orca CLI, no agent settings.

To try it in your own Orca: `orca plugin dev load . --approve <fingerprint>`.

## License and credits

MIT; see [LICENSE](LICENSE). This is an independent plugin, not part of Plannotator or Orca.
[Plannotator](https://github.com/backnotprop/plannotator) (MIT or Apache-2.0) is by backnotprop;
the text a chat receives with a reply follows Plannotator's own wording, so that its guide stays
true. [Orca](https://github.com/stablyai/orca) (MIT) is by Stably.
