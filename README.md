# Plannotator Inbox for Orca

One inbox to manage and respond to all your agents. This [Orca](https://github.com/stablyai/orca)
plugin connects your Orca chats to the [Plannotator Inbox](https://plannotator.ai), a window where
agents send you their questions and you answer when you get to it.

An agent in an Orca chat asks you something through the Inbox. You answer there. Your answer
arrives in the chat that asked, by itself, as its next turn.

## Install

You need Orca 1.4.248 or later and Plannotator.

```sh
orca plugin install bakescakes/orca-plannotator-inbox
```

Then, in Orca:

1. Approve the plugin when Orca asks. It runs a worker with your user account's access, stores
   its delivery record in its own plugin storage, and may show a notification.
2. Open the **Plannotator Inbox** panel in the right sidebar and press **Connect agents**. This
   adds one `plannotator-inbox` MCP server to every agent Plannotator supports that is on your
   computer. It is the only time the plugin writes outside its own folders, and **Disconnect**
   puts back what was there. Where the Inbox is off, Connect first has Plannotator turn it on
   with its own `plannotator inbox --open`. See
   [Which agents are connected](docs/how-it-works.md#which-agents-are-connected).
3. Start a new chat. Connections apply to chats started afterwards.

The status bar shows an **Inbox** item; pressing it opens the Inbox window.

## What you get

- Your answer goes back to the chat that asked, once. If it cannot be delivered, it stays in the
  Inbox and the plugin's panel says why.
- From the Inbox you can start a new Orca chat on a thread, stop one, resume it, and bring it
  forward in Orca.
- Each message from an Orca chat ends with an **Open in Orca** link that brings that chat forward.
- Each Orca chat shows the icon of the agent it runs, and a bot's chat shows the bot's picture.
- Inbox projects get the icon of their Orca repository.
- A chat waiting on you gets a waiting mark in the Inbox's Agents list (Plannotator 0.29.1 or
  later, with **Show agent status** on).
- One button, **Connect agents**, connects every agent Plannotator supports.
- It keeps working through Orca and Plannotator updates. CI tests it every day against the newest
  release of each. See [Staying working through updates](docs/updates.md).

## The Orca build of Plannotator

Starting, stopping and opening Orca chats from the Inbox, and the per-agent icons, need a build of
Plannotator with a few small changes for Orca. The plugin downloads it from this repository's
releases, checks its size and SHA-256 before using it, and keeps it on the version of the
Plannotator installed on your computer. It is the same Plannotator release with those changes,
built in public by this repository's CI. Nothing is installed over your own `plannotator`, and
your Inbox and its data stay as they are. If you would rather not use it, switch off **Use the
Orca build of Plannotator** in Settings: then nothing is downloaded and your own Plannotator is
used as it is, and replies still come back to the chat that asked. Read more in
[The Orca build of Plannotator](docs/orca-build.md).

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

- Only native Orca chats on this computer are served. Terminal agents keep Plannotator's own
  integrations, and chats on SSH, WSL or paired hosts are left alone.
- An agent that sends through the `plannotator` command line instead of the MCP tools is not seen
  as an Orca chat.
- A chat is listened for after its first Inbox message. A reply that arrives while the chat is
  closed waits in the Inbox and is delivered when the chat is open again.
- In the chat, Orca shows a reply as mail from "an agent" with a "?" icon. The subject says what
  arrived, such as `Inbox reply: <thread name>`.
- Between a Plannotator release and its Orca build (minutes to hours), and sometimes after a
  login, the Inbox runs standard Plannotator. Until it moves to the Orca build, Start, Stop and
  Open in Orca are missing from the Inbox and per-agent icons are not shown.
- Use the plugin in one Orca profile at a time.
- The plugin has not been run inside Orca on Windows.

The full list is in [Limits](docs/limits.md).

## Uninstall

Uninstalling the plugin leaves the launcher folder and the agent entries. Press **Disconnect**
first, then delete `~/.orca-plannotator-inbox`.

## License and credits

MIT; see [LICENSE](LICENSE). This is an independent plugin, not part of Plannotator or Orca.
[Plannotator](https://github.com/backnotprop/plannotator) (MIT or Apache-2.0) is by backnotprop;
the text a chat receives with a reply follows Plannotator's own wording, so that its guide stays
true. [Orca](https://github.com/stablyai/orca) (MIT) is by Stably.

The Orca build is a modified Plannotator. Plannotator is licensed MIT or Apache-2.0, and each
build's release carries both license texts (LICENSE-MIT and LICENSE-APACHE).

## More

- [How it works](docs/how-it-works.md)
- [The Orca build of Plannotator](docs/orca-build.md)
- [Staying working through updates](docs/updates.md)
- [Limits](docs/limits.md)
- [Development](docs/development.md)
