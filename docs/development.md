# Development

This page covers how to check, test and try the plugin while working on it.

No build step and no runtime dependencies: Orca loads the TypeScript directly. `package.json`
holds only the type-checker.

```sh
npm ci                      # typescript and @types/node (installed without bin links, on purpose)
orca plugin types .         # writes .orca/types for this Orca
npm run typecheck
orca plugin validate . --json
orca plugin test .          # unit tests, with a stand-in Orca CLI and Inbox
orca plugin check . --json  # renders the panel in each scenario of src/panel.check.ts
node plannotator/build.mjs --fit <plannotator checkout>  # which Orca edits fit that checkout
```

Building the Orca build itself is described in
[`plannotator/README.md`](../plannotator/README.md).

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
