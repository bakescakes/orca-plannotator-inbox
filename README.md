# Plannotator Inbox for Orca

An [Orca](https://github.com/stablyai/orca) plugin that brings your
[Plannotator Inbox](https://plannotator.ai) replies back into the Orca chat that asked.

An agent in a native Orca chat sends you a question through the Plannotator Inbox. You answer in
the Inbox window when you get to it. The answer arrives in that same Orca chat by itself, as its
next turn.

From the Inbox you can also start a new Orca chat on a thread, stop one, resume it and bring it
forward, and each Orca chat shows the icon of the agent it runs (a bot's chat, the bot's own
picture). For that the plugin downloads
the **Orca build of Plannotator** (the same Plannotator release with a small set of Orca changes,
built in public from this repository) and keeps it up to date. Switch that off in Settings and
the plugin works with the Plannotator installed on your computer exactly as it is; replies still
come back to the chat that asked.

## Install

You need Orca 1.4.248 or later and Plannotator.

```sh
orca plugin install bakescakes/orca-plannotator-inbox
```

Then, in Orca:

1. Approve the plugin when Orca asks. It runs a worker with your user account's access, stores
   its delivery record in its own plugin storage, and may show a notification.
2. Open the **Plannotator Inbox** panel in the right sidebar and press **Connect agents**. This
   adds one `plannotator-inbox` MCP server, which runs the launcher, to every agent Plannotator
   supports that is on your computer, at user level. It is the only time the plugin writes outside
   its own folders, it happens only when you press it, and **Disconnect** puts back what was
   there. An entry that ran Plannotator directly keeps its environment settings (such as
   `PLANNOTATOR_DATA_DIR`) and its binary, so the same Plannotator and the same Inbox are used.
   See [Which agents are connected](#which-agents-are-connected).
   From Plannotator 0.29.1 the Inbox is off on a computer where it never ran, and chats see none of
   its tools until a person starts it. Pressing **Connect agents** is that choice: where the Inbox
   is off, Connect first has Plannotator turn it on with its own setup step, `plannotator inbox
   --open`, which starts the Inbox and opens its window. Nothing else in the plugin turns it on.
3. Start a new chat. Connections apply to chats started afterwards.

The status bar shows an **Inbox** item; pressing it opens the Inbox window.

## What it does

| Piece | Where | Job |
| --- | --- | --- |
| Worker | `src/worker.ts`, `src/engine.ts` | Finds the Orca chats that use the Inbox, holds one reply poll per open chat, hands each reply to the courier. |
| Courier | `src/courier.ts`, `src/ledger.ts` | Delivers one reply to one chat through `orca orchestration send`, exactly once as far as both sides can prove. |
| Launcher | `~/.orca-plannotator-inbox/inbox-mcp` | What agents run as their `plannotator-inbox` MCP server: Plannotator's own `plannotator inbox mcp`, with the Orca chat filled in as the author. |
| Panel | `src/panel.tsx` | Status, the chats that are listening, agent connections, and replies that need you. |
| Connect | `src/connect.ts` | **Connect agents**: its own writer for Claude Code, Codex and OpenCode, and Plannotator's connector for every other agent. |
| Links | `src/navigation.ts`, `bin/reveal.cjs` | Ends each message an Orca chat sends with an **Open in Orca** link that brings that chat forward. |
| Pictures | `src/presentation.ts` | Gives an Inbox project the icon of its Orca repository. |
| Agent icons | `src/faces.ts`, `src/bot-avatars.ts`, `src/png.ts` | Gives each Orca chat the icon of the agent it runs, and a bot's chat the bot's own picture. |
| Orca build | `src/build-store.ts`, `~/.orca-plannotator-inbox/plannotator-update` | Downloads, checks, installs and updates the Orca build of Plannotator, and keeps the Inbox on it. |
| Bridge | `src/bridge.ts`, `src/lifecycle.ts`, `bin/session.cjs` | What the Orca build calls to start, stop, resume and open Orca chats. |

A reply moves through `prepared → sending → accepted → acknowledged`. Each step is saved before
the next program is asked to do anything, with the request id Orca will see, so a crash or a lost
answer resumes the same request instead of sending twice. A lost answer is settled by reading
(Orca's request receipt, then the chat's mailbox, without consuming anything). When reading cannot
settle it, the reply is **blocked** and shown in the panel for you to send again; it also stays in
the Inbox. The Inbox is told a reply was delivered only after Orca's mailbox shows the chat
received it.

### Checks before anything is sent or delivered

A reply wakes an agent, so both directions are checked rather than trusted.

- **Sending.** The launcher does not take the chat's identity from its environment. Orca's own
  CLI must say that this exact chat is live, and Orca's workspace list says which repository and
  worktree it works in. Until that is proven, the launcher is plain Plannotator and rewrites
  nothing. With it, the chat is filled in as the author and its own project as the project. A
  call that names another chat, or a project folder that is not the chat's, is refused with a
  message that starts `Not sent:` and says what to change. The launcher keeps a small record of
  each send under `~/.orca-plannotator-inbox/receipts` so a retried call is not posted twice.
- **Delivering.** Before a reply is sent to a chat, its thread is read from the Inbox. The reply
  must be written by a person, be newer than the moment this plugin first served that Inbox
  (older replies are skipped, so installing the plugin never wakes chats for old mail), belong to
  a project that is one of the chat's own folders, and follow a `reply_to` chain that leads to a
  message this same chat wrote or that was addressed to it. A reply that fails is never sent and
  never marked delivered: it stays in the Inbox and the panel lists it under **Not delivered**
  with the reason.
- **Only these projects.** When the setting lists folders, only chats whose worktree or
  repository is in one of them send as Orca chats and get replies. Others use plain Plannotator.
  A bot's chats are in the bot's home folder, so they count only when that folder (or one above
  it) is listed.

### Open in Orca links

Each message a proven Orca chat sends ends with an **Open in Orca** link. It points at a listener
on `127.0.0.1` that the worker runs, and is signed with a key kept in
`~/.orca-plannotator-inbox/link-key`. A click brings that exact chat tab forward where this Orca
allows it, and otherwise opens the chat's workspace through Orca's CLI. A chat in a folder
workspace, a bot's home among them, opens only by bringing the chat itself forward, because Orca
does not open a folder workspace by its id; when Orca cannot, the page says nothing was opened, and
for a bot's chat it names the bot and the chat. The link names a chat,
never a path; it is checked against Orca's current chats on every click; a link preview or a
script gets a page with one button instead of opening anything. Links work only on this computer
and only while Orca runs. Switch them off in Settings.

### Project pictures

Once a minute the worker gives each Inbox project the icon of the Orca repository at the same
folder (an emoji or an image Orca holds itself; remote images are never fetched). It only fills
an empty picture or replaces one it set itself, so a picture you choose in the Inbox stays.

### Agent icons

In the Inbox every Orca chat has the same host, Orca. With the Orca build, the worker gives each
chat the mark of the agent it runs (Claude Code, Codex, OpenCode, Pi, Cursor, Grok, Antigravity,
Copilot and the others Orca can run), through the Inbox's own face picker route. A face you chose
yourself is never replaced, and standard Plannotator is never sent one.

### Bot pictures

With the Orca build, a bot's chat shows the bot's picture from Orca in place of its agent's mark,
wherever the Inbox draws that chat's agent icon: the sidebar's Agents list, the author of its
messages, its threads' rows. Two bots that run the same agent look as different as they do in Orca.
Only a chat in the bot's own home gets it (see [Orca bots](#orca-bots)); a chat in a workspace nested under a
bot, and every other chat, keeps its agent's mark.

| The bot's picture in Orca | In the Inbox |
| --- | --- |
| A mascot | The same mascot, read from the installed Orca's own files, on its default sky blue |
| A picture you uploaded | That picture, made 128 px square |
| An emoji (bots from before mascots) | The emoji |
| None | The bot's initial on a grey tile, as Orca shows a bot without a picture |

The worker reads the picture again once a minute, with the agent icons, so a new picture in Orca
shows within about a minute and a renamed bot keeps its own. A chat that stops being a bot's (the
bot was removed while the chat stayed open) goes back to its agent's mark. Orca's CLI does not name
a bot's picture, so the worker reads `bot.json` in the bot's home (Orca rewrites it on every change,
and it must name the bot Orca lists there), and for an uploaded picture `avatar.png` beside it. It
opens no other file of the home, and none through a link. It gives the picture to the Inbox the way
"Your own…" in the face picker does (`POST /api/inbox/agent-icons`) and sets the chat's face to it
(`own:<sha256>`). As with agent marks, a face you chose for the chat yourself is never replaced, and
standard Plannotator is sent nothing. Choosing **Agent** in the picker counts as your choice too: a
later picture from Orca does not undo it.

Nothing of Orca's artwork is in this plugin: a mascot is read at run time from the Orca installed on
this computer (`app.asar.unpacked/out/renderer/assets`, found from the CLI the worker runs) and kept
only in this computer's Inbox. Orca, mascots included, is MIT-licensed.

Limits:

- A mascot's tile colour is kept only in Orca's own store, which the plugin does not read, so a
  mascot you put on another colour shows on its default sky blue.
- The chat shows its agent's mark instead when the picture cannot be read or shown: the app's files
  moved in an Orca update, a mascot or `bot.json` is not in the shape the plugin checks for, an
  uploaded picture is a PNG it does not read (only 8-bit, not interlaced) and larger than the Inbox's
  512 KB, or the Inbox keeps no pictures for agents. A mascot Orca does not know shows the initial,
  as in Orca.
- Each picture the plugin gives the Inbox stays among the Inbox's own pictures for agents ("Your
  own…" in the picker) until the Inbox lets go of old ones that no agent shows; it keeps 60.
- A bot's chat on a paired computer is not served by this plugin, so it gets no picture either.

### Orca bots

A bot's chats (every chat in its home) take replies like any other chat, the same way: one mail
to that chat's own address, never to another chat of the bot. Orca's `worktree ps` marks a bot's
home (`bot`, `botHome`), and the plugin names its chats from that alone: `Name (Claude bot)` as the
author in the Inbox, and the same in the panel's list of chats, on a reply that needs you, and in
the plugin's log. A chat in a workspace only nested under a bot is an ordinary chat. With the Orca
build, a bot's chat shows the bot's own picture as its icon (see [Bot pictures](#bot-pictures)).

Orca takes mail to a bot's chat as a request to that bot: it keeps the sender, the address and the
text, and puts its own record of the request in place of the plugin's payload. The plugin accepts
Orca's receipt for that mail only with the exact text it sent, so a reply is still sent once and
settled by reading. A chat that is holding its mail (its last turn failed) keeps the reply on the
way until it takes it; the Inbox is told only then. Starting a chat from the Inbox never offers a
bot's home.

### Chats waiting on you

With Plannotator 0.29.1 or later and **Show agent status** turned on in the Inbox's settings, an Orca
chat the plugin listens for (see [Limits](#limits)) that waits on you gets a waiting mark on its
icon in the Inbox sidebar's Agents list, as a terminal agent does. It shows while the chat holds a
permission prompt or a question in Orca, and while a chat's own turn has asked you something it goes
on without (a Codex question). The plugin looks at Orca's chats every ten seconds, so the mark comes
and goes about that long after Orca shows the change.

Orca's list of chats says that a chat waits, not on what. The plugin learns which with one read of
the chat's newest entries (`orca agent read`) per wait, and keeps only whether a permission or a
question is pending: never the words. The Inbox is told on every reply poll, and at once when it
changes; with standard Plannotator older than 0.29.1 nothing is shown and nothing else changes.

A reply to a chat at a prompt is still sent to Orca at once. Orca keeps it until you answer the
prompt, and the chat then takes it as its next turn; until then the reply is on its way, and the
Inbox is told it arrived only once the chat has it.

Limits:

- When the plugin cannot tell what the chat waits on (an Orca without `agent read`, a read that
  fails, or nothing pending in what it reads), it shows nothing rather than guess.
- A wait held by a child agent the chat started, not by the chat itself, shows nothing.
- The Inbox draws no Agents-list mark for a chat it started itself (Start in a thread); it shows
  such a chat's state on the thread's run line instead. With the Orca build, a chat started from
  the Inbox that holds a permission prompt reads "waiting on a permission prompt" there, with
  **Open in Orca**, and its thread moves to the ones stopped on you. An Orca build from before this
  shows no line for it. A question in such a chat shows nothing on the run line: Plannotator's
  words there are for a permission prompt only.

### The Orca build of Plannotator

Standard Plannotator can take messages from an Orca chat, but it cannot start, stop or resume one,
or show which agent each chat runs. The Orca build adds that. It is the Plannotator
release of the same number with the changes under [`plannotator/`](plannotator/) applied, built by
this repository's public CI for macOS, Linux and Windows, and published on its Releases page with
a checksum for each file.

- **Plannotator owns its updates.** The plugin never decides which Plannotator release you run.
  It follows the `plannotator` installed on your computer: the Orca build in use is always the one
  of that release. When no Plannotator is installed, it uses the newest Orca build.
- **Install.** On start, at most every six hours after, and within seconds of your Plannotator
  changing, the worker reads the list of Orca builds, downloads the one of your Plannotator's
  release for your computer, checks its size and SHA-256, runs it once to see that it answers, and
  only then records it under `~/.orca-plannotator-inbox/plannotator/`. Nothing is installed over
  your own `plannotator`.
- **Use.** The launcher and **Open Inbox** start the Orca build when one is installed and the
  worker is delivering; otherwise they start your own Plannotator. A `PLANNOTATOR_BIN` you set
  always wins. If the Inbox is already running on standard Plannotator, the panel offers
  **Restart Inbox**; nothing saved is lost.
- **After a login.** The Inbox may start as standard Plannotator: Plannotator's own login item
  starts it, and on macOS the Orca build is sometimes stopped there, or a plain `plannotator`
  command starts the Inbox first. When that Inbox is of the same release as the Orca build in use,
  the worker moves it to the Orca build by itself, within about half a minute of Orca starting (or
  of seeing it), the same way **Restart Inbox** does: nothing saved is lost, and if the build does
  not answer within 30 seconds the Inbox runs standard Plannotator again. The plugin's log says
  "The Inbox started on standard Plannotator 0.29.1 (pid 812); restarted it on the Orca build
  0.29.1 (orca.1)." and the panel says "moving it to the Orca build" while it does. It does this
  once for each start of the Inbox, at most three times a day, and after a failure not again for
  six hours (sooner when the build or your Plannotator changes); the panel then says why and keeps
  **Restart Inbox**. **Check for a new build** and **Restart Inbox** move it at once, whatever these
  limits say, and count toward them.
- **Update.** Press **Update** in the Inbox, leave Plannotator's automatic updates on, or run
  `plannotator update` in a terminal: each one is Plannotator updating itself, with its own
  installer. From the Inbox, the Orca build hands the request to Plannotator's own
  `plannotator update` and the plugin then follows; from a terminal, the worker notices the new
  release within seconds. If Plannotator's own update fails, nothing changes and the Inbox's
  update card says why, in Plannotator's words.
- **After an update.** If the Orca build of the new release is published, the Inbox restarts on it.
  It must start and answer within 30 seconds, or the one before it is put back. If it is not
  published yet, the Inbox restarts on the Plannotator you just updated to, without the Orca
  additions: no Start, Stop or Open in Orca from the Inbox, and no per-agent icons. Replies still
  reach your chats. The panel says "Plannotator 0.28.67 is in use. Its Orca build is not published
  yet, so the Orca additions (Start, Stop and Open in Orca from the Inbox, and per-agent icons) are
  missing until it is; the Inbox moves to it by itself.", the worker looks every 15 minutes, and
  when the build arrives the Inbox restarts on it. CI looks for a new Plannotator release
  four times an hour, but GitHub starts scheduled runs when it has room: on this repository they
  have come hours apart, so the build of a new release can take that long. An Orca build that cannot be downloaded or fails its checks is
  treated the same way, with the reason shown. A failed download is tried again every 15 minutes; a
  build that fails its checks is left alone for six hours (then longer) unless you press **Check
  for a new build** in the panel, and a newer build of the release is taken at once.
- **Never back.** The plugin does not move you to an older release. If the Plannotator installed
  here is older than the Orca build in use, the build stays.
- **Reduced builds.** When a Plannotator release breaks some of the Orca changes, CI may publish a
  build that leaves those out. Its `manifest.json` lists what it serves (`features`) and what it
  leaves out (`omitted`); manifests without these lists are full builds. The panel says in one line
  what a reduced build lacks, such as per-agent icons, or starting and stopping chats from the
  Inbox. While one is in use, the worker looks every 15 minutes, and installs the full build of the
  same version (`orca.2` after `orca.1`) as soon as it is published.
- **Start, Stop, Resume, Open.** The Orca build calls a listener the worker runs on `127.0.0.1`,
  with a key kept in `~/.orca-plannotator-inbox/bridge/`. A launch is recorded before Orca is
  asked, so a retry never starts a second chat. A chat you stopped takes no reply until you write
  to it again or resume it. Workspaces offered are limited to **Only these projects** when set.

Only native Orca chats on this computer are served. Terminal agents keep Plannotator's own
integrations, and chats on SSH, WSL or paired hosts are left alone.

## Which agents are connected

One method serves every agent: Plannotator's own connector, the one `plannotator inbox` runs
when you start it in a terminal. The Orca build runs it when you press **Connect agents** and
has it write the launcher instead of `plannotator inbox mcp`. That covers Gemini CLI, Qwen Code,
Cursor, Windsurf / Devin, Amp, Cline, Kiro, Pi, DeepSeek Harness, Muse Code, OpenClaw, Hermes
Agent, Antigravity, the Claude app and any agent Plannotator adds later. What Plannotator cannot
do for an agent (an agent you connect by hand, one turned off in Plannotator's Settings) shows in
the panel with Plannotator's reason.

Three agents get the plugin's own writer instead, because the launcher needs something
Plannotator's connector does not do for them:

- **Claude Code.** Plannotator writes no entry for it and relies on its own Claude Code plugin.
- **Codex.** It passes an MCP server no environment unless each variable is listed, and the
  launcher needs the chat's variables. The plugin lists them by name, never by value.
- **OpenCode.** Its settings are JSON with comments, which Plannotator does not edit; it connects
  OpenCode only through its OpenCode plugin. The plugin edits the one entry and keeps every
  comment.

The panel lists these three, then every other agent Plannotator found on this computer. It reads
that list from the running Inbox when you press **Refresh** and after a connect, never on a
timer. While the Inbox is not running, Connect does the three and says the others are connected
once the Inbox runs (where the Inbox is off, Connect turns it on first, so it is running).

**With standard Plannotator** (the Orca build switched off), Connect still does the three, then
asks Plannotator to connect the others its own way. Those entries run Plannotator directly:
messages arrive, but replies do not come back into Orca chats. With the Orca build running the
Inbox, press **Connect agents** again to move them to the launcher. **Disconnect** then takes
back only the three; turn the others off in Plannotator's Settings. An Orca build from before
this route connects the others through the launcher, but cannot move or disconnect them until it
has updated itself.

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
  launcher makes the chat the author whatever host the agent names (its `agent_name` is kept,
  except in a bot's chat, which is named as the bot's),
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
  and `bridge/event`, and the stdio MCP server. **Connect agents** also uses
  `/api/inbox/control/orca-agents` (the Orca build), or `GET /api/inbox/agents` and
  `POST /api/inbox/control/connect` (standard Plannotator); an answer it cannot read is reported,
  and Claude Code, Codex and OpenCode are connected all the same. Agent icons and bot pictures use
  `GET`/`POST /api/inbox/agent-faces` and `POST /api/inbox/agent-icons`. Which identity fields a tool takes is read from
  the server's own `tools/list`, so new or renamed tools need no change here. Unknown fields are
  ignored or passed along.
- **Orca**: plugin Host API 1 (frozen and additive), and these CLI calls with `--json`:
  `status`, `worktree ps`, `repo list`, `worktree activate`, `orchestration
  send|request-show|inbox`, and `agent-context` (Orca's own command list, read once to learn
  whether `orchestration send` takes `--body-file`; an Orca whose argument check refuses that flag
  is remembered as one without it, and the same request goes again with `--body`), and `agent read`
(once per wait, to learn whether a waiting chat holds a permission or a question; without it nothing
is shown). A bot's picture is read from `bot.json` and `avatar.png` in its home and from the
mascots in the app's own files; when one of them changes shape, the bot's chat shows its agent's
mark. Bringing one exact chat tab forward uses a call Orca does not
  publish; when an Orca update changes it, the link opens the chat's workspace instead. The worker runs the CLI that
  ships inside the same Orca, so the two are always the same version.
- **The Orca build** follows Plannotator's releases by itself (see above). Its changes are kept as
  a few small patches and whole added files, and CI applies them to each new Plannotator release;
  when a release no longer takes them, CI fails, no build is published, and the plugin keeps the
  build it has.
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
| Add an "Open in Orca" link to Inbox messages | on | Off: no link is added and the listener does not run. |
| Use Orca's repository icons as project pictures | on | Off: project pictures are left alone. |
| Show each Orca chat with its agent's icon | on | A bot's chat with the bot's picture. Off: agent icons are left alone. Needs the Orca build. |
| Use the Orca build of Plannotator | on | Off: nothing is downloaded, and your own Plannotator is used as it is. Start, Stop and Resume from the Inbox need it on. |
| Only these projects | empty | One folder per line. Empty: every project. |
| Plannotator data folder | empty | Empty follows Plannotator: `PLANNOTATOR_DATA_DIR`, then `~/.plannotator`. When set, Orca chats send to that Inbox too, unless the agent's own environment names a folder. |
| Orca CLI path | empty | Empty uses the CLI inside this Orca. |

Commands: **Open Inbox**, **Show Status**, **Connect Agents**, **Disconnect Agents**,
**Restart Inbox on the Orca Build**, **Check for a New Orca Build**.

## Limits

- An agent that sends through the `plannotator` command line instead of the MCP tools is not seen
  as an Orca chat. The note in the server's instructions tells agents to use the tools.
- A chat is listened for after its first Inbox message through the launcher (or when the Inbox
  already holds a thread it wrote). A reply that arrives while the chat is closed waits in the
  Inbox and is delivered when the chat is open again.
- At most 64 chats are listened for at once.
- A reply in a thread whose project is not one of the chat's folders is not delivered, even when
  the chat started that thread. It is listed under **Not delivered** and stays in the Inbox.
- A plugin older than 0.2.0 cannot read the delivery record a newer one wrote, so do not go back
  to 0.1.x after running 0.2.0 without clearing the plugin's storage.
- Whether OpenCode passes Orca's chat variables to the launcher has not been checked with a real
  OpenCode chat. If it does not, OpenCode chats use plain Plannotator.
- A reply arrives by itself inside an Orca chat only for an agent Orca runs as a chat and that
  passes the chat's variables to its MCP servers. Every other connected agent sends through the
  launcher as plain Plannotator, and gets replies Plannotator's own way.
- Connecting agents other than Claude Code, Codex and OpenCode needs the Inbox to be running.
- From Orca 1.4.265 a reply's text goes to Orca through standard input (`orchestration send
  --body-file -`), never on the command line, so it does not show in the process list. A reply up
  to about 500 KB is included in the mail; a longer one is not, and the chat is told to read it
  from the thread. An older Orca takes the text on the command line: there that happens from about
  12,000 bytes on Windows and 62,000 elsewhere. If Orca refuses a reply before sending it, the
  panel lists it under **Needs you** with Orca's reason, and nothing is sent until you press
  **Send again**.
- Orca shows a reply in a bot's chat to the bot as a status for its information, with nothing to
  answer, and leaves it to the bot whether to act on it. The plugin sends it as it sends every
  reply; it cannot ask Orca to frame it otherwise.
- When a chat has ended (it was closed, as a bot's earlier Home chats are), or it is a bot's and
  bots are switched off, Orca refuses the reply and stores nothing: the panel lists it under
  **Needs you** in those words. Orca refuses mail to a paused bot under a general error code, so
  the plugin cannot tell that refusal from a lost answer: it reads Orca's records, finds nothing,
  and lists the reply as not known to have arrived. Nothing is sent again until you press
  **Send again**.
- Two Orca profiles under one user account share the launcher folder. A profile whose plugin is
  switched off does not stop the other from delivering, but the launcher cannot tell which
  profile a chat belongs to, so use the plugin in one profile at a time.
- Start, Stop and Resume from the Inbox need the Orca build, and Orca's own support for the agent
  in question. Where Orca cannot do one of them, the Inbox says so and nothing is sent.
- The Orca build is downloaded from this repository's GitHub releases only. Without a connection
  the build already installed (or your own Plannotator) stays in use.
- Between a Plannotator release and its Orca build (minutes to hours), an Inbox you update runs
  standard Plannotator: Start, Stop and Open in Orca are missing from the Inbox and per-agent icons
  are not shown. Both are back when the Inbox restarts on the Orca build.
- After a login the Inbox may start as standard Plannotator (see **After a login** above). Until the
  plugin moves it to the Orca build, which needs Orca open with the plugin delivering replies,
  Start, Stop and Open in Orca are missing from the Inbox and per-agent icons are not shown. The
  move restarts only a running standard Inbox of the Orca build's own release: never one that is
  stopped, one Plannotator has off, or one of a release other than the build's, and never when the
  Plannotator installed here is newer than the build (that waits for its own build, as above). The
  plugin never edits Plannotator's login item or any of Plannotator's files, so the next login may
  start standard Plannotator again, and the plugin moves it again.
- The **Update** button reaches Plannotator's own updater only for a `plannotator` installed by
  Plannotator's install script. For any other copy, Plannotator says it cannot update itself and
  nothing changes.
- A reduced build lacks what its panel line says until the full build is published. If none is
  ever published, the worker keeps looking every 15 minutes; that is one small download of the
  list of builds each time.
- Uninstalling the plugin leaves the launcher folder and the agent entries. Press **Disconnect**
  first, then delete `~/.orca-plannotator-inbox`.
- On Windows, Plannotator keeps starting agents from the Inbox switched off, and the Orca build
  does the same: Start, Stop and Resume are not offered there unless `inboxLaunch.enabled` is
  `true` in Plannotator's `config.json`. That has not been tried inside Orca on Windows.
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

# Bot pictures through a real Inbox, also in a throwaway HOME, with invented bots. With the Orca
# build every picture form is kept, set and served back; with standard Plannotator nothing is sent.
PLANNOTATOR_FACES_BIN=/path/to/plannotator orca plugin test .

# Read-only checks against the running Orca; add a chat's session id to read its mailbox,
# and ORCA_LIVE_SEND=1 to send that chat one marked test mail.
ORCA_LIVE_CLI="$(command -v orca)" orca plugin test .
```

Inside a real Orca, without touching yours:

```sh
# Starts a second, windowless Orca from the app you name, with a throwaway profile and home;
# installs the plugin there, opens a native chat and delivers a real reply to it.
# Add ORCA_INAPP_CLI_BEFORE and PLANNOTATOR_E2E_BIN_BEFORE (older releases) to make it an
# update test on one profile. Needs `claude` installed; it never has anyone's account there. It
# gets a made-up key and a model address on 127.0.0.1 that turns every turn away, so Orca (which
# from 1.4.266 closes a chat whose Claude is not signed in) keeps the chat open, and nothing leaves
# this computer. It makes no bot: Orca creates a bot only from its own window or a
# paired device, never through its CLI, so bots are covered by tests on recorded `worktree ps` rows.
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
