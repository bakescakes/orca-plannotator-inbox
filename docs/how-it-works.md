# How it works

This page covers what the plugin does in detail: its parts, the checks on every message and reply,
links, pictures and icons, bots, waiting chats, and how agents are connected and told.

## The parts

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

## How a reply is delivered

A reply moves through `prepared → sending → accepted → acknowledged`. Each step is saved before
the next program is asked to do anything, with the request id Orca will see, so a crash or a lost
answer resumes the same request instead of sending twice. A lost answer is settled by reading
(Orca's request receipt, then the chat's mailbox, without consuming anything). When reading cannot
settle it, the reply is **blocked** and shown in the panel for you to send again; it also stays in
the Inbox. The Inbox is told a reply was delivered only after Orca's mailbox shows the chat
received it.

## Which chats are served

Only native Orca chats on this computer are served. Terminal agents keep Plannotator's own
integrations, and chats on SSH, WSL or paired hosts are left alone.

## Checks before anything is sent or delivered

A reply wakes an agent, so both directions are checked rather than trusted.

### Sending

The launcher does not take the chat's identity from its environment. Orca's own CLI must say that
this exact chat is live, and Orca's workspace list says which repository and worktree it works in.
Until that is proven, the launcher is plain Plannotator and rewrites nothing. With it, the chat is
filled in as the author and its own project as the project. A call that names another chat, or a
project folder that is not the chat's, is refused with a message that starts `Not sent:` and says
what to change. The launcher keeps a small record of each send under
`~/.orca-plannotator-inbox/receipts` so a retried call is not posted twice.

### Delivering

Before a reply is sent to a chat, its thread is read from the Inbox. The reply must be written by
a person, be newer than the moment this plugin first served that Inbox (older replies are skipped,
so installing the plugin never wakes chats for old mail), belong to a project that is one of the
chat's own folders, and follow a `reply_to` chain that leads to a message this same chat wrote or
that was addressed to it. A reply that fails is never sent and never marked delivered: it stays in
the Inbox and the panel lists it under **Not delivered** with the reason.

### Only these projects

When the setting lists folders, only chats whose worktree or repository is in one of them send as
Orca chats and get replies. Others use plain Plannotator. A bot's chats are in the bot's home
folder, so they count only when that folder (or one above it) is listed.

## Open in Orca links

Each message a proven Orca chat sends ends with an **Open in Orca** link. It points at a listener
on `127.0.0.1` that the worker runs, and is signed with a key kept in
`~/.orca-plannotator-inbox/link-key`. A click brings that exact chat tab forward where this Orca
allows it, and otherwise opens the chat's workspace through Orca's CLI. A chat in a folder
workspace, a bot's home among them, opens only by bringing the chat itself forward, because Orca
does not open a folder workspace by its id; when Orca cannot, the page says nothing was opened,
and for a bot's chat it names the bot and the chat.

The link names a chat, never a path; it is checked against Orca's current chats on every click; a
link preview or a script gets a page with one button instead of opening anything. Links work only
on this computer and only while Orca runs. Switch them off in Settings.

## Project pictures

Once a minute the worker gives each Inbox project the icon of the Orca repository at the same
folder (an emoji or an image Orca holds itself; remote images are never fetched). It only fills
an empty picture or replaces one it set itself, so a picture you choose in the Inbox stays.

## Agent icons

In the Inbox every Orca chat has the same host, Orca. With the Orca build, the worker gives each
chat the mark of the agent it runs (Claude Code, Codex, OpenCode, Pi, Cursor, Grok, Antigravity,
Copilot and the others Orca can run), through the Inbox's own face picker route. A face you chose
yourself is never replaced, and standard Plannotator is never sent one.

## Bot pictures

With the Orca build, a bot's chat shows the bot's picture from Orca in place of its agent's mark,
wherever the Inbox draws that chat's agent icon: the sidebar's Agents list, the author of its
messages, its threads' rows. Two bots that run the same agent look as different as they do in
Orca. Only a chat in the bot's own home gets it (see [Orca bots](#orca-bots)); a chat in a
workspace nested under a bot, and every other chat, keeps its agent's mark.

| The bot's picture in Orca | In the Inbox |
| --- | --- |
| A mascot | The same mascot, read from the installed Orca's own files, on its default sky blue |
| A picture you uploaded | That picture, made 128 px square |
| An emoji (bots from before mascots) | The emoji |
| None | The bot's initial on a grey tile, as Orca shows a bot without a picture |

The worker reads the picture again once a minute, with the agent icons, so a new picture in Orca
shows within about a minute and a renamed bot keeps its own. A chat that stops being a bot's (the
bot was removed while the chat stayed open) goes back to its agent's mark.

Orca's CLI does not name a bot's picture, so the worker reads `bot.json` in the bot's home (Orca
rewrites it on every change, and it must name the bot Orca lists there), and for an uploaded
picture `avatar.png` beside it. It opens no other file of the home, and none through a link: the
home must be a real folder, not a link (nor a junction on Windows), whose real place is still
directly in a folder named `bots`, and each file a real file directly in it. Links above that are
yours and are followed (your home or Orca's data folder kept on another disk, macOS's `/var` and
`/tmp`), including a `bots` folder linked to another folder named `bots`; a bot's home linked out
to anywhere else gives no picture.

It gives the picture to the Inbox the way "Your own…" in the face picker does
(`POST /api/inbox/agent-icons`) and sets the chat's face to it (`own:<sha256>`). As with agent
marks, a face you chose for the chat yourself is never replaced, and standard Plannotator is sent
nothing. Choosing **Agent** in the picker counts as your choice too: a later picture from Orca
does not undo it.

Nothing of Orca's artwork is in this plugin: a mascot is read at run time from the Orca installed
on this computer (`app.asar.unpacked/out/renderer/assets`, found from the CLI the worker runs) and
kept only in this computer's Inbox. Orca, mascots included, is MIT-licensed.

Limits of bot pictures:

- A mascot's tile colour is kept only in Orca's own store, which the plugin does not read, so a
  mascot you put on another colour shows on its default sky blue.
- The chat shows its agent's mark instead when the picture cannot be read or shown: the app's
  files moved in an Orca update, a mascot or `bot.json` is not in the shape the plugin checks for,
  an uploaded picture is a PNG it does not read (only 8-bit, not interlaced) and larger than the
  Inbox's 512 KB, or the Inbox keeps no pictures for agents. A mascot Orca does not know shows the
  initial, as in Orca.
- Each picture the plugin gives the Inbox stays among the Inbox's own pictures for agents ("Your
  own…" in the picker) until the Inbox lets go of old ones that no agent shows; it keeps 60.
- A bot's chat on a paired computer is not served by this plugin, so it gets no picture either.

## Orca bots

A bot's chats (every chat in its home) take replies like any other chat, the same way: one mail
to that chat's own address, never to another chat of the bot. Orca's `worktree ps` marks a bot's
home (`bot`, `botHome`), and the plugin names its chats from that alone: `Name (Claude bot)` as
the author in the Inbox, and the same in the panel's list of chats, on a reply that needs you, and
in the plugin's log. A chat in a workspace only nested under a bot is an ordinary chat. With the
Orca build, a bot's chat shows the bot's own picture as its icon (see
[Bot pictures](#bot-pictures)).

Orca takes mail to a bot's chat as a request to that bot: it keeps the sender, the address and the
text, and puts its own record of the request in place of the plugin's payload. The plugin accepts
Orca's receipt for that mail only with the exact text it sent, so a reply is still sent once and
settled by reading. A chat that is holding its mail (its last turn failed) keeps the reply on the
way until it takes it; the Inbox is told only then. Starting a chat from the Inbox never offers a
bot's home.

## Chats waiting on you

With Plannotator 0.29.1 or later and **Show agent status** turned on in the Inbox's settings, an
Orca chat the plugin listens for (see [Limits](limits.md)) that waits on you gets a waiting mark
on its icon in the Inbox sidebar's Agents list, as a terminal agent does. It shows while the chat
holds a permission prompt or a question in Orca, and while a chat's own turn has asked you
something it goes on without (a Codex question). The plugin looks at Orca's chats every ten
seconds, so the mark comes and goes about that long after Orca shows the change.

Orca's list of chats says that a chat waits, not on what. The plugin learns which with one read of
the chat's newest entries (`orca agent read`) per wait, and keeps only whether a permission or a
question is pending: never the words. The Inbox is told on every reply poll, and at once when it
changes; with standard Plannotator older than 0.29.1 nothing is shown and nothing else changes.

A reply to a chat at a prompt is still sent to Orca at once. Orca keeps it until you answer the
prompt, and the chat then takes it as its next turn; until then the reply is on its way, and the
Inbox is told it arrived only once the chat has it.

Limits of the waiting mark:

- When the plugin cannot tell what the chat waits on (an Orca without `agent read`, a read that
  fails, or nothing pending in what it reads), it shows nothing rather than guess.
- A wait held by a child agent the chat started, not by the chat itself, shows nothing.
- The Inbox draws no Agents-list mark for a chat it started itself (Start in a thread); it shows
  such a chat's state on the thread's run line instead. With the Orca build, a chat started from
  the Inbox that holds a permission prompt reads "waiting on a permission prompt" there, with
  **Open in Orca**, and its thread moves to the ones stopped on you. An Orca build from before
  this shows no line for it. A question in such a chat shows nothing on the run line:
  Plannotator's words there are for a permission prompt only.

## Which agents are connected

One method serves every agent: Plannotator's own connector, the one `plannotator inbox` runs
when you start it in a terminal. The Orca build runs it when you press **Connect agents** and
has it write the launcher instead of `plannotator inbox mcp`. That covers Gemini CLI, Qwen Code,
Cursor, Windsurf / Devin, Amp, Cline, Kiro, Pi, DeepSeek Harness, Muse Code, OpenClaw, Hermes
Agent, Antigravity, the Claude app and any agent Plannotator adds later. What Plannotator cannot
do for an agent (an agent you connect by hand, one turned off in Plannotator's Settings) shows in
the panel with Plannotator's reason.

### What Connect agents writes

**Connect agents** adds one `plannotator-inbox` MCP server, which runs the launcher, to every
agent Plannotator supports that is on your computer, at user level. It is the only time the plugin
writes outside its own folders, it happens only when you press it, and **Disconnect** puts back
what was there. An entry that ran Plannotator directly keeps its environment settings (such as
`PLANNOTATOR_DATA_DIR`) and its binary, so the same Plannotator and the same Inbox are used.

From Plannotator 0.29.1 the Inbox is off on a computer where it never ran, and chats see none of
its tools until a person starts it. Pressing **Connect agents** is that choice: where the Inbox is
off, Connect first has Plannotator turn it on with its own setup step, `plannotator inbox
--open`, which starts the Inbox and opens its window. Nothing else in the plugin turns it on.

### Claude Code, Codex and OpenCode

Three agents get the plugin's own writer instead, because the launcher needs something
Plannotator's connector does not do for them:

- Plannotator writes no entry for Claude Code and relies on its own Claude Code plugin.
- Codex passes an MCP server no environment unless each variable is listed, and the launcher needs
  the chat's variables. The plugin lists them by name, never by value.
- OpenCode's settings are JSON with comments, which Plannotator does not edit; it connects
  OpenCode only through its OpenCode plugin. The plugin edits the one entry and keeps every
  comment.

The panel lists these three, then every other agent Plannotator found on this computer. It reads
that list from the running Inbox when you press **Refresh** and after a connect, never on a
timer. While the Inbox is not running, Connect does the three and says the others are connected
once the Inbox runs (where the Inbox is off, Connect turns it on first, so it is running).

### With standard Plannotator

With standard Plannotator (the Orca build switched off), Connect still does the three, then asks
Plannotator to connect the others its own way. Those entries run Plannotator directly: messages
arrive, but replies do not come back into Orca chats. With the Orca build running the Inbox, press
**Connect agents** again to move them to the launcher. **Disconnect** then takes back only the
three; turn the others off in Plannotator's Settings. An Orca build from before this route
connects the others through the launcher, but cannot move or disconnect them until it has updated
itself.

## How agents are told

Plannotator already teaches agents the Inbox: its MCP server sends instructions, `plannotator
inbox --help` is the full guide, and the Inbox sidebar has **Copy connect prompt**. The plugin
adds nothing of its own to an agent's context except four sentences, and is built so those
materials keep working as written:

- The reply looks like Plannotator's own. It starts `Plannotator Inbox: <title> (<reply id>)`,
  says how to answer (`send_message` with `reply_to` set to that id), names the thread, carries
  the person's words unchanged and ends with Plannotator's closing line. That is the shape the
  guide tells agents to expect. Anything else the Inbox says about a reply (a hand-off, a tag,
  open questions, fields a later version adds) is passed along as a `Context:` line.
- `send_message` says the reply arrives by itself, because the launcher tells Plannotator this
  connection wakes the chat. The agent ends its turn, as the guide says.
- The connect prompt cannot take a chat off this path. The guide and the connect prompt tell an
  agent on a plain stdio server to pass its own `agent_host`, and to register `plannotator inbox
  mcp` unless a server "that runs this command" is already set up. In an Orca chat the launcher
  makes the chat the author whatever host the agent names (its `agent_name` is kept, except in a
  bot's chat, which is named as the bot's), and adds a short note to the server's instructions
  saying the chat is already connected and to change nothing. The entry in each agent's settings
  carries the same note as a comment.
- When the plugin is off or cannot deliver, the launcher changes nothing. The agent then talks to
  plain Plannotator, with Plannotator's own identity and wake rules.

If you use Plannotator's own Claude Code plugin, Claude Code is already connected for Orca chats
and **Connect agents** leaves it alone.
