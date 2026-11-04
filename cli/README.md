# o8 CLI

Agent-first wrapper over the local o8 HTTP API. Worker agents in dispatched
worktrees, CI runners, and scripts call `o8 <cmd>` instead of curling
`http://127.0.0.1:<port>/api/...` with a bearer token.

Commands default to JSON; pass `--human` for ANSI-formatted output.
Bare `o8` in an interactive terminal opens a conversation. Piped invocations
and `--json` stay in command mode.

## Interactive conversation

With o8 running, open a terminal in your repository:

```sh
o8 chat
o8 chat --backend codex --model <model-id> --effort low
o8 chat --resume thoughts-<conversation-id>
```

This uses the same local orchestrator, authentication, workspace, and saved
conversation history as the app. It does not start a separate inference service
or change saved settings. New and resumed chats start in **plan mode**; use
`--execute` explicitly to request the backend's full execution mode. Model and
effort overrides apply only to a new conversation. A resumed conversation keeps
its saved backend, agent, and model routing.

Enter sends, Ctrl+J inserts a newline, and pasted newlines remain in the draft.
Use Esc to request interruption, Ctrl+O to expand tool details, and Page Up/Down
or the mouse wheel to read earlier output; Ctrl+G returns to latest. Hold Shift
to use your terminal's native mouse text selection. Reading earlier rows holds your
position while new output arrives. When an answer's prompt is above the viewport,
a single prompt row stays at the top; it yields when the full prompt is visible.
`/help` lists controls and `/session` gives the resume
command. `/quit` detaches; active work continues in o8. Disconnections never
resend prompts automatically: `/reconnect` reloads saved history.

Drop file paths into the terminal or use `/attach "path with spaces.png"`.
Files are staged locally, with no shell execution or automatic send. `/attachments`
lists them; `/remove 2` removes the second file and `/remove all` clears the list.
Add a message and press Enter to send. PNG, JPEG, GIF, and WebP bytes use the existing
image attachment transport, with backend support checked before sending. UTF-8
files send their actual contents as data, not a path the remote backend might lack.
Limits are eight attachments, 3.7 MB per image, 256 KiB per text file, and 1 MiB of
text in total. Directories, devices, and other binary documents (including PDF)
are rejected with a visible explanation. Raw clipboard image paste is not supported
in this slice; save the image and drop its file path. Attachments remain local
until send, and unsent drafts are not persisted across terminal exit.

New turns stream live. When attaching to an already-running turn, chat refreshes
the saved response until completion so a bounded event buffer cannot omit the
beginning of a long answer. Tool details received in this terminal are expandable;
historical tool details are not reconstructed from text-only history.

Use `--no-motion` or `O8_REDUCED_MOTION=1` for a static activity indicator. Standard
terminal color settings apply. The minimum terminal size is 36 columns by 12 rows.
From a source checkout, run `npm run build:cli` then `node cli/dist/o8.mjs chat`.

## Commands

| Command | Purpose |
|---|---|
| `o8 chat [--repo <path>] [--resume <thread>]` | Interactive local orchestrator conversation |
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
| `o8 terminal control <id>` | Claim one existing shell for input/output; refuses an active writer and releases on exit |
| `o8 packet log <event>` | (Phase-1 stub) — will append a structured lane event once the backend route lands |

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
