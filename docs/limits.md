# Limits

This page lists what the plugin does not do, or does only in part, and what to expect when you
meet one of these.

- Only native Orca chats on this computer are served. Terminal agents keep Plannotator's own
  integrations, and chats on SSH, WSL or paired hosts are left alone.
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
- In the chat, Orca shows a reply as mail from "an agent" with a "?" icon: it names a sender only
  from a chat, a terminal, a task or a bot, and a plugin is none of those. So the mail's subject
  says what arrived, then the thread's name: `Inbox reply: <thread name>` (`Inbox message`,
  `Inbox reaction`, `Inbox tag`, `Inbox thread handed to you` and so on for the other kinds).
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
- After a login the Inbox may start as standard Plannotator (see
  [After a login](orca-build.md#after-a-login)). Until the plugin moves it to the Orca build,
  which needs Orca open with the plugin delivering replies, Start, Stop and Open in Orca are
  missing from the Inbox and per-agent icons are not shown. The move restarts only a running
  standard Inbox of the Orca build's own release: never one that is stopped, one Plannotator has
  off, or one of a release other than the build's, and never when the Plannotator installed here
  is newer than the build (that waits for its own build, as in the item above). The plugin never
  edits Plannotator's login item or any of Plannotator's files, so the next login may start
  standard Plannotator again, and the plugin moves it again.
- The **Update** button reaches Plannotator's own updater only for a `plannotator` installed by
  Plannotator's install script. For any other copy, Plannotator says it cannot update itself and
  nothing changes.
- A reduced build (see [Reduced builds](orca-build.md#reduced-builds)) lacks what its panel line
  says until the full build is published. If none is ever published, the worker keeps looking
  every 15 minutes; that is one small download of the list of builds each time.
- Uninstalling the plugin leaves the launcher folder and the agent entries. Press **Disconnect**
  first, then delete `~/.orca-plannotator-inbox`.
- On Windows, Plannotator keeps starting agents from the Inbox switched off, and the Orca build
  does the same: Start, Stop and Resume are not offered there unless `inboxLaunch.enabled` is
  `true` in Plannotator's `config.json`. That has not been tried inside Orca on Windows.
- On Windows, CI runs the tests, the end-to-end run with the real Plannotator through the
  launcher, and the plugin inside a real Orca with the newest releases, where a reply is delivered
  to a real native chat. The update half of that test and the test with the Orca build run on
  macOS and Linux only, and no signed-in agent has been tried on Windows.

Bot pictures and the waiting mark have limits of their own, listed in
[Bot pictures](how-it-works.md#bot-pictures) and
[Chats waiting on you](how-it-works.md#chats-waiting-on-you).
