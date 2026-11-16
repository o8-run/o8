# o8 inside Rex

[Rex](https://www.superlogical.com/rex) is a terminal multiplexer: sessions, tabs and panes, on this machine or over SSH. o8 works inside it without any setup. When you run o8 in a Rex pane, it marks the tab with what its workers are doing and can open a pane for each worker so you can watch them work.

o8 keeps ownership of every worker. Rex only shows them. Closing a pane, a tab or Rex itself never stops a worker.

## Setup

There is nothing to run. The first time you run an `o8` command in a Rex pane, o8 adds "Show o8 Terminals" to the Rex command palette and says so in one line. It writes one file, `o8.lua`, beside your Rex `init.lua` and adds one `require("o8")` line to it; nothing else in your Rex config changes. The action starts the `o8` command on your PATH, so updating o8 keeps it working.

- To bind a key as well, run `o8 terminal shortcut --key cmd+shift+o`.
- `o8 terminal shortcut --remove` takes it out, and o8 remembers that and does not add it back. Run `o8 terminal shortcut` to add it again.
- Set `O8_REX_SHORTCUT=0` to stop o8 from adding it on its own.
- o8 never replaces an `o8.lua` you wrote yourself, never binds a key on its own, and does nothing when it runs as a worker or without a person at the terminal.

## Watch your workers

Press the key, or pick "Show o8 Terminals" from the palette. Rex opens a tab named `o8 terminals`:

- A narrow `o8 watcher` pane on the left. It checks every few seconds and opens a pane for each packet or terminal that starts.
- One pane per running packet, labeled with the packet's title. It follows the worker's transcript: each tool it calls and what it says. Most workers have no terminal of their own, so this is how you watch them.
- One pane per live worker terminal and dashboard shell, mirrored read-only.

When a packet's worker stops, its pane stays open with the final report on screen. Press Enter in it to close it. If you steer the packet back to work, the pane follows the new turn. A terminal's pane closes on its own when the terminal ends. A pane you close stays closed while its packet keeps running. Close the watcher pane, or press Ctrl-C in it, to stop watching; the other panes stay.

Pressing the shortcut again while the watcher it started is still running does not start a second watcher: the new tab says "o8 is already watching this session." and closes. A watcher you started by hand is not counted.

Without the shortcut, run the same thing yourself from any Rex pane:

```sh
o8 terminal panes --watch --here   # fill this tab, beside this pane, and keep filling it
o8 terminal panes                  # one pass: a new tab, or beside o8 panes already open
```

`--limit` caps the panes (8 by default, up to 16).

## Read the tab marks

Rex marks a tab while a program in it reports its state. o8 reports from:

| Where | Working | Then |
|---|---|---|
| A packet's pane | while its worker runs | error when the packet failed, is blocked on a decision, or was archived; done for any other stop, such as awaiting review. While it runs, error with "Needs you" when the worker looks stuck (see below) |
| The `o8 watcher` pane (`o8 terminal panes --watch`) | while a packet it has seen runs | a count of the packets it has seen run since it started, by where each stands now, such as `2 running · 1 needs you`; error when one waits on you or failed; done when none runs and at least one finished (a merged or dismissed packet counts as done); idle before the first ("No workers yet"), when only paused ones are left, and while o8 does not answer ("Cannot reach o8") |
| `o8 mission dispatch --watch`, `o8 mission wait` | while it waits | done when the packet reaches review or release; error when it fails, blocks or is archived; cleared on a timeout or any other wake |
| `o8 mission tail` | while packets run | one mark per packet (up to 60), and one for the mission |
| `o8 chat` | while a turn runs | done when a reply to a message you sent from that chat is ready; error when the connection drops or the chat shows an error |

A worker can be stuck without asking for anything. A packet's pane watches for three signs and marks the tab for attention when one shows, with a line in the pane that says what it saw:

- **No output:** nothing from the worker for 10 minutes, or 30 minutes while a command it started is still running. The mark reads `Needs you: no output`.
- **Same error 3x:** the same command failed with the same output three times. Numbers such as timings are ignored when comparing output. The mark reads `Needs you: same error 3x`.
- **Edits, tests flat:** one file was edited four or more times while the test command failed the same way three runs in a row. The mark reads `Needs you: edits, tests flat`.

Only progress clears a sign: any new output clears the first, the command passing or failing differently clears the second, and a different test result clears the third. A steer starts all three over. A sign only marks the pane. The worker keeps running until you stop or steer it.

So a tab of worker panes tells you at a glance which workers finished and which need you. Marks are written to stdout only with human output in an interactive Rex pane, so JSON output on stdout stays clean. Set `O8_TERMINAL_STATUS=0` to turn them off, or `O8_TERMINAL_STATUS=1` to send them in another terminal that reads the Program Status Protocol; with JSON output, forced marks go to stderr.

## Start work from the terminal

```sh
o8 mission create --title "Add a health route" --body "Create /api/health returning 200." --dispatch
o8 packet transcript <packet-id> --follow    # follow one worker here
o8 packet steer --packet <packet-id> --message "Also cover the error path"
```

The task goes in `--body`. Run it from the repository, or pass `--repo <path>`. `mission create --dispatch` returns as soon as the dispatch is admitted; the watcher picks up the packet when its worker starts.

## Limits

- Running packets and worker terminals on a saved SSH machine are not listed yet. `o8 terminal panes --machine <label-or-id>` shows that machine's dashboard shells only.
- Panes read the operator credential from the o8 data directory, so a credential supplied only through an environment variable does not reach them.
- The shortcut edits the config Rex reads. If the Rex server was started with `REX_CONFIG`, run `o8 terminal shortcut` with the same value.

See [Persistent terminals](persistent-terminals.md) for every `o8 terminal` command, and the [CLI reference](../../cli/README.md) for the full command list.
