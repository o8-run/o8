# o8 CLI

Agent-first wrapper over the local o8 HTTP API. Worker agents in dispatched
worktrees, CI runners, and scripts call `o8 <cmd>` instead of curling
`http://127.0.0.1:<port>/api/...` with a bearer token.

Commands default to JSON; pass `--human` for ANSI-formatted output.
Bare `o8` prints command usage. Run `o8 --help` to list available commands.

## Tab status in the terminal

`o8 mission dispatch --watch` and `o8 mission wait` report the packet's state to
terminals that read the Program Status Protocol (`OSC 7501`). The tab shows that
the watcher is working, then keeps a finished mark when a packet reaches review
or release, or a failed mark when it fails, blocks, or is archived. A watcher
that times out clears its mark.

`o8 mission tail` reports each packet on its own record under o8's
(`o8/<packet>`), with a fixed phrase for its status, and uses o8's record for
the mission as a whole: how many packets have finished, then one finished or
failed mark once all of them have. A mission with more than 60 packets marks
its first 60 and still counts all of them in the summary.

Reports are written only with `--human`, when stdout is an interactive terminal,
and when the terminal is known to read the sequence. Rex is detected through
`REX_SESSION`. Set `O8_TERMINAL_STATUS=1` to send reports in any interactive
terminal, or `O8_TERMINAL_STATUS=0` to turn them off. With JSON output, forced
reports go to stderr, so stdout stays parseable; do not force them where
stderr is merged into stdout (`2>&1`). A report carries the packet
title and a fixed status phrase, and nothing else. o8 writes to its own record
(`id=o8`), so it never replaces the status of the program that runs it.

## Commands

| Command | Purpose |
|---|---|
| `o8 version` | CLI version + connected server version |
| `o8 doctor` | Verify port + token resolution; ping `/api/panel/status` |
| `o8 status` | Operator snapshot: running packets, active lanes, recent merges, pending approvals. Packet workers receive only live lane/packet IDs, states, and checkout paths. |
| `o8 history <thoughts-thread-id> [--limit 200]` | Read one continuous orchestrator transcript with permanent, audited handoff seams |
| `o8 worker spawn --title "..." [--repo <path>]` | Create and dispatch one governed worker from any local repo without adding it to Projects; the running app opens a dedicated worker pane |
| `o8 worker login` | Connect a dedicated encrypted native worker token on macOS from an operator terminal; no source checkout is required and raw setup output is suppressed |
| `o8 mission create --title "..." [--dispatch] [--effort high]` | Create a transient-repo mission; `--dispatch` starts it immediately, `--effort` pins a reasoning tier (`adaptive` resets to the runtime default) |
| `o8 repo list` | List every repository registered in the running app |
| `o8 repo add <path>` | Register an existing local Git repository from any current directory |
| `o8 repo remove <id\|name\|path>` | Remove the registration and project links while preserving the local folder and remote |
| `o8 project list` | List projects, active state, and repo membership |
| `o8 project create <name> [--repo <target>...]` | Create a project and optionally attach registered repos |
| `o8 project use <target>` | Switch the active project by ID or exact name |
| `o8 project add-repo <project> <repo>` | Attach a registered repo without changing its folder |
| `o8 project remove-repo <project> <repo>` | Detach a repo while preserving its registration and folder |
| `o8 project delete <target>` | Delete a project and its exclusive repo registrations while preserving every local folder and remote |
| `o8 packet info` | Info about the packet bound to the current worktree (auto-discovered via cwd) |
| `o8 packet stop <id>` | Interrupt the worker and hold the packet; resume with `packet reset` or `packet rerun`; `packet cancel` is an alias |
| `o8 mission stop --mission <id>` | Interrupt and hold every packet in a mission, then print per-packet results |
| `o8 run stop <runId>` | Stop an o8-managed run listed by `o8 run --list` |
| `o8 run --last` | Show the latest run's command, start time, durable exit receipt, and retained log path |
| `o8 terminal list` | List live dashboard shell IDs, including detached sessions |
| `o8 terminal show <id> [--lines N]` | Read up to 1000 lines from an existing dashboard shell |
| `o8 terminal observe <id>` | Stream an existing shell read-only; `--human` prints terminal text |
| `o8 terminal panes` | Inside Rex, open one read-only pane per running packet (its transcript), worker terminal and live shell, labeled by title; `--watch` keeps opening panes as work starts, `--here` opens them beside the current pane, `--limit 1..16`, `--machine <label-or-id>` |
| `o8 terminal shortcut` | Added on its own the first time you run o8 inside Rex (`O8_REX_SHORTCUT=0` turns that off). Add a "Show o8 Terminals" action to Rex that opens a tab running `o8 terminal panes --watch --here`, and a "Go to o8 Pane That Needs You" action that runs `o8 terminal needs-you`; `--key <key>` binds a key to the first, `--remove` takes both out |
| `o8 terminal needs-you` | Focus the next o8 pane in this Rex session that is blocked or failed: the most urgent first, then each of the others as you run it again. Skips the watcher pane. `--session` and `--from` pick the session and the pane to start from; inside Rex they default to the pane you are in |
| `o8 terminal control <id>` | Claim one existing shell for input/output; refuses an active writer and releases on exit |
| `o8 packet log <event>` | (Phase-1 stub) — will append a structured lane event once the backend route lands |
| `o8 packet transcript [id]` | Read what a packet's worker is doing: tool calls, replies, steers and how it ended. `--follow` keeps reading until the worker stops, and `--hold` then keeps the command open until you press Enter; `--limit 1..200` sets how many recent events to show first |

## Configuration

The CLI auto-discovers the running o8 backend.

Outside terminals and agents can dispatch from an unregistered repo. o8 keeps
the repo context on the mission and audit history, but it does not add the repo
to the user's saved Projects list. Pass `--caller <label>` when the app should
show which outside agent or terminal started the worker.

Resolution order:

1. `O8_API_PORT` / `O8_API_TOKEN` env vars (set by dispatch for worker agents)
2. `~/.o8/api-port` and `~/.o8/ws-token`
3. `~/.cortex-ide/api-port` and `~/.cortex-ide/ws-token` (legacy data dir)
4. Fallback port `3001`, no token (dev workflow on loopback)

Loopback callers don't need a token; cross-origin callers do.
Terminal commands require the local operator token even on loopback; worker credentials cannot read or control operator shells.

For a person at a terminal, run `o8 --human terminal control <id>`. The shell
streams in place; press Ctrl-] to release the CLI attachment without ending the
shell. Ctrl-C is sent to the shell. A second writable pane or controller must
close before control can be claimed, while read-only observers may stay open.

For automation, `o8 terminal control <id>` writes newline-delimited JSON events
to stdout and accepts newline-delimited JSON on stdin:

```json
{"type":"input","data":"pwd\r"}
{"type":"resize","cols":120,"rows":30}
{"type":"release"}
```

Input is sent as terminal bytes, so a command needs a carriage return to run.
Closing stdin or disconnecting releases the writer slot. The shell and its
saved history remain available for later attachments.

`o8 terminal wait <id> --match <text> [--timeout ms]` attempts to check existing
visible terminal text, then follows the same live shell read-only for new output. It defaults to a
30-second wait and never takes the writer slot or resizes the shell. A match
returns the matching line and elapsed time; timeout exits 5 with a specific
`wait_timeout` error. A timeout says only that no matching output was observed,
so inspect the shell before retrying the command that should have produced it.
The same command accepts `--machine <label-or-id>` for a saved SSH target when
the remote o8 CLI also supports `terminal wait`.

### Saved SSH machines

Save a machine only after its remote o8 terminal host is already running:

```sh
o8 machine add workbox --label Build
o8 machine list
o8 machine check Build
o8 terminal list --machine Build
o8 terminal show <id> --machine Build
o8 terminal control <id> --machine Build
o8 --human terminal control <id> --machine Build
```

`machine add` accepts `--port`, `--ssh-config /absolute/path`, and
`--remote-cli /absolute/path/to/o8` when the remote executable is not on the
non-interactive SSH path. Profiles contain the target and these paths, not keys
or passwords. OpenSSH handles authentication and verifies the host key. The
remote o8 installation uses its own local operator credential. A disabled,
missing, or unreachable target fails without sending the command to Local.
Use `o8 machine rename <id> --label <name>`, `disable`, `enable`, or `remove`
to manage a profile. Remote control supports both the JSON stream and the
interactive terminal. Ctrl-] releases the attachment without ending the remote
shell. A connection failure never changes the selected machine or routes input
to Local. Native workspace switching is a separate app feature.

## App and runtime updates

Run `o8 update` (or `o8 update apply`) to update installed runtime CLIs through
the server's detected original installers, then request the native app update.
`--dry-run` reads versions and prints the plan without invoking installers or
requesting an app update. `--runtimes a,b` filters the server's runtime inventory;
the app is still included. `--check` requests a fresh app check before applying,
and `--force` retains the app updater's existing live-work override.

JSON `results` and `--human` rows include the machine, runtime name, before and
after versions, and status. A failed runtime does not stop later updates.
Unsupported or custom installations report `manual-update`. The app reports
`requested` with an unknown after version until its asynchronous update finishes.
`o8 update check` keeps its existing app-only check behavior.

`--machines` reads the connected machine registry. An empty registry produces a
`local-only` row. This server has no fleet execution route: registered remote
machines produce `unavailable` rows and a nonzero exit status. Run the update on
each remote machine until fleet execution is available.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | invalid args / unexpected |
| 2 | connection refused (o8 not running) |
| 3 | unauthorized (bad token) |
| 4 | not found |
| 5 | conflict (state machine rejected the op) |
| 6 | server timeout; the operation may have landed |
| 7 | lead turn is unreported; send new work or stop the lead |

## Output schema

Every JSON payload includes a `schema` field:

```json
{ "schema": "o8/cli/<command>/v1", "...": "..." }
```

Errors:

```json
{
  "schema": "o8/cli/error/v1",
  "error": { "code": "...", "message": "...", "hint": "..." }
}
```

## Build

```sh
# from the repo root
npm run build:cli
# or from cli/
node esbuild.config.mjs
```

Produces `cli/dist/o8.mjs` — a single Node 22+ ESM bundle. Run directly via
`node cli/dist/o8.mjs <cmd>` or after a `chmod +x` as `./cli/dist/o8.mjs`.

## Typecheck

```sh
npx tsc --noEmit -p cli/tsconfig.json
```

This strict project includes CLI tests and resolves shared `@/` imports against
the root source tree. Its libraries cover Node 22's ES2023 APIs and the web types
used by fetch tests and shared application contracts; the bundle targets Node 22.
`tests/cli-standalone-real-path.test.ts` runs this compiler entry point and checks
the bundled artifact and setup commands against an isolated HTTP fixture.

## See also

- Epic [#926](https://github.com/o8-run/o8/issues/926) — full
  command surface and design principles.
