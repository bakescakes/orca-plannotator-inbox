# The Orca build of Plannotator

This page covers the Orca build of Plannotator: what it is, how the plugin installs, uses and
updates it, and what happens while it is missing.

Standard Plannotator can take messages from an Orca chat, but it cannot start, stop or resume one,
or show which agent each chat runs. The Orca build adds that. It is the Plannotator release of the
same number with the changes under [`plannotator/`](../plannotator/) applied, built by this
repository's public CI for macOS, Linux and Windows, and published on its Releases page with a
checksum for each file.

On a new install the panel asks once, before anything is downloaded: **Use it** or **Not now**.
**Not now** switches off **Use the Orca build of Plannotator** in Settings, which is also where
to change your mind later. With it off nothing is downloaded, and your own Plannotator is used as
it is. Start, Stop and Resume from the Inbox need it on. Where the plugin already keeps an Orca
build, an update of the plugin does not ask.

## Plannotator owns its updates

The plugin never decides which Plannotator release you run. It follows the `plannotator`
installed on your computer: the Orca build in use is always the one of that release. When no
Plannotator is installed, it uses the newest Orca build.

## Install

Once you have pressed **Use it**: on start, at most every six hours after, and within seconds of
your Plannotator changing, the worker reads the list of Orca builds, downloads the one of your Plannotator's release for your
computer, checks its size and SHA-256, runs it once to see that it answers, and only then records
it under `~/.orca-plannotator-inbox/plannotator/`. Nothing is installed over your own
`plannotator`.

## Use

The launcher and **Open Inbox** start the Orca build when one is installed and the worker is
delivering; otherwise they start your own Plannotator. A `PLANNOTATOR_BIN` you set always wins.
If the Inbox is already running on standard Plannotator, the panel offers **Restart Inbox**;
nothing saved is lost.

## After a login

The Inbox may start as standard Plannotator: Plannotator's own login item starts it, and on macOS
the Orca build is sometimes stopped there, or a plain `plannotator` command starts the Inbox
first. When that Inbox is of the same release as the Orca build in use, the worker moves it to the
Orca build by itself, within about half a minute of Orca starting (or of seeing it), the same way
**Restart Inbox** does: nothing saved is lost, and if the build does not answer within 30 seconds
the Inbox runs standard Plannotator again.

The plugin's log says "The Inbox started on standard Plannotator 0.29.1 (pid 812); restarted it
on the Orca build 0.29.1 (orca.1)." and the panel says "moving it to the Orca build" while it
does.

It does this once for each start of the Inbox, at most three times a day, and after a failure not
again for six hours (sooner when the build or your Plannotator changes); the panel then says why
and keeps **Restart Inbox**. **Check for a new build** and **Restart Inbox** move it at once,
whatever these limits say, and count toward them.

## Update

Press **Update** in the Inbox, leave Plannotator's automatic updates on, or run
`plannotator update` in a terminal: each one is Plannotator updating itself, with its own
installer. From the Inbox, the Orca build hands the request to Plannotator's own
`plannotator update` and the plugin then follows; from a terminal, the worker notices the new
release within seconds. If Plannotator's own update fails, nothing changes and the Inbox's update
card says why, in Plannotator's words.

## After an update

If the Orca build of the new release is published, the Inbox restarts on it. It must start and
answer within 30 seconds, or the one before it is put back.

If it is not published yet, the Inbox restarts on the Plannotator you updated to, without the
Orca additions: no Start, Stop or Open in Orca from the Inbox, and no per-agent icons. Replies
still reach your chats. The panel says "Plannotator 0.28.67 is in use. Its Orca build is not
published yet, so the Orca additions (Start, Stop and Open in Orca from the Inbox, and per-agent
icons) are missing until it is; the Inbox moves to it by itself.", the worker looks every 15
minutes, and when the build arrives the Inbox restarts on it.

CI looks for a new Plannotator release four times an hour, but GitHub starts scheduled runs when
it has room: on this repository they have come hours apart, so the build of a new release can
take that long.

An Orca build that cannot be downloaded or fails its checks is treated the same way, with the
reason shown. A failed download is tried again every 15 minutes; a build that fails its checks is
left alone for six hours (then longer) unless you press **Check for a new build** in the panel,
and a newer build of the release is taken at once.

## Never back

The plugin does not move you to an older release. If the Plannotator installed here is older than
the Orca build in use, the build stays.

## Reduced builds

The Orca changes come in groups, one per feature. When a Plannotator release breaks one group, CI
publishes a build without that group, and only its feature is missing: the rest of the build works
as usual. Its `manifest.json` lists what it serves (`features`) and the groups it leaves out
(`omitted`); manifests without these lists are full builds.

The panel says in one line what a reduced build lacks, such as per-agent icons, or starting and
stopping chats from the Inbox. While one is in use, the worker looks every 15 minutes, and
installs the full build of the same version (`orca.2` after `orca.1`) as soon as it is published.

## Start, Stop, Resume, Open

The Orca build calls a listener the worker runs on `127.0.0.1`, with a key kept in
`~/.orca-plannotator-inbox/bridge/`. A launch is recorded before Orca is asked, so a retry never
starts a second chat. A chat you stopped takes no reply until you write to it again or resume it.
Workspaces offered are limited to **Only these projects** when set.

## License

The Orca build is a modified Plannotator. Plannotator is licensed MIT or Apache-2.0, and each
build's release carries both license texts (LICENSE-MIT and LICENSE-APACHE).
