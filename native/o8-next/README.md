# o8 next: live sessions, composer and opt-in terminal

[Parity harness and measured checklist](../../docs/internals/o8-next-parity.md): paired native/current-UI captures, layout gaps and remaining acceptance.

[Current UI parity and Linux CI budgets](PARITY.md): surface states, remaining gaps and the headless release workload.

[Per-surface port documentation](docs/surfaces/): registration contracts and rebase steps. Add each port's documentation there.

[Brain conversation and memory retrieval](BRAIN.md): reading, search, sources and a native composer.

[Opt-in app shell](APP-SHELL.md): local connection, workspace switching and persisted session/grid surfaces. The explicit fixture modes below remain available.

Opt-in Rust GPUI surface for #4405, stacked on the static history slice in #4410.
Lists saved orchestrator sessions beside runtime workers, bootstraps the selected
session's latest 100 messages over HTTP, then subscribes to its existing WebSocket
history stream. Load older follows revision-bound cursors and preserves the
visible anchor and previously shaped rows. Workers use their original session
keys and remain read-only.
Operator/agent prose, lists, inline styles, code fences and tool-step groups are
read-only. Home/End and wheel scrolling work; scrollbar tracks are hidden.

Unchanged rows retain their shaped text, wrapping and measured height across tail
updates and scrolling. Only changed content or a viewport-width change computes a
new row layout. GPUI still positions list items and paints the scene. Replacement
snapshots and late tool results can invalidate the affected row. Refresh and
session selection cancel the previous subscription and load a new history.

Packet headers (including mission metadata), handoffs, compaction receipts,
tables, diff cards and image/PDF/file placeholders now use the same server fields
as the WebKit renderers. The authored rich recording is compared with production
React elements and painted through headless GPUI. See the
[transcript receipts and measurements](evidence/transcript/README.md).

This slice does **not** complete #4405. Disposable provider-session acceptance,
diagrams, visualization cards and real font-shaping/GPU/compositor measurements
remain open. Linux TestAppContext timing uses a no-op text system; its three
2,000-row runs are not substitutes for the existing macOS measurements. The
composer and queue actions are described below.

## Opt-in native terminal (#4487)

Pass `--terminal SESSION_ID` to open a native terminal pane for an existing
terminal session. This requires the normal `--enable-next`, explicit `--server`
and `O8_NEXT_API_TOKEN`. The CLI launcher forwards the option. It uses the same
published GPUI crate as the other native surfaces and `alacritty_terminal =
0.26.0` (Apache-2.0), with no GPL application crates. The shipped Tauri app is
unchanged. See [terminal protocol](TERMINAL-PROTOCOL.md) for attach, input, resize,
replay and reconnection details.

The pane paints ANSI/indexed/truecolor cells, combining/wide characters and
cursor shapes, preserves alternate screen state, and retains 10,000 lines.
Wheel and Shift+PageUp/PageDown/Home/End scroll without a scrollbar track.
Input uses GPUI's text-input contract plus terminal control/function keys;
resize follows the viewport. Clipboard escape requests are disabled. Terminal
selection/copy, mouse reporting, graphics protocols and display presentation
timing are outside this slice.

Use the existing disposable host with its new fixture mode:

```sh
node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/dev-server.ts --terminal
# Use the printed origin and terminalSession; supply the same explicit fixture
# O8_NEXT_API_TOKEN to the host and native process through the environment.
node cli/dist/o8.mjs next --enable-next --binary "$PWD/native/o8-next/target/release/o8-next" --server ORIGIN --terminal SESSION_ID
```

Linux headless verification (Node 22, Rust stable, GPUI linker prerequisites):

```sh
npx vitest run tests/next-terminal-real-path.test.ts
O8_NEXT_TERMINAL_RESULTS="$PWD/terminal-results.json" cargo test --release --locked --manifest-path native/o8-next/Cargo.toml terminal -- --nocapture --test-threads=1
O8_NEXT_TARGET=x86_64-unknown-linux-gnu O8_NEXT_LICENSE_OUTPUT=terminal-licenses.json node scripts/next/license-audit.mjs
```

The GPUI test measures local key dispatch to CPU scene paint separately from
the key → production WebSocket server → real PTY echo → CPU scene endpoint.
Flood frame time includes taking the current grid snapshot and painting it while
the socket thread parses output; the Python peer emits exactly 50,000,000 bytes
at 2.5 MB/s before its marker, following the repository's fixed-rate workload
pattern. The peer's separate `burst` command probes unpaced saturation; the
existing server deliberately drops visible data under backpressure.
RSS is sampled with the full 10,000-line history. Headless CPU scenes do not
establish GPU, compositor or physical input latency.
See [terminal verification and measurements](evidence/terminal/verification.md)
for the three release receipts, license graphs and remaining latency limits.

## Build and use

Linux release shell rendering is checked in [headless CI](PARITY.md#linux-ci-measurements).
macOS remains the interactive verification target. From the repository root, with the
normal JavaScript dependencies installed:

```sh
cargo +1.97.1 build --manifest-path native/o8-next/Cargo.toml --release --locked
node cli/esbuild.config.mjs
node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/dev-server.ts
```

The last command prints a newly allocated loopback origin and exits after two
minutes. It owns a temporary data directory, database and fixture Git repository.
It hosts the real production GET handlers without application startup hooks,
runtime discovery or provider calls. In another shell, substitute that exact
origin for `ORIGIN`:

```sh
node cli/dist/o8.mjs next --enable-next --binary "$PWD/native/o8-next/target/release/o8-next" --server ORIGIN
```

The normal window is created without activation. Automated verification always
adds `--offscreen`, which uses `Application::headless()` and a hidden window.
Do not run visible checks at an occupied desk. The shipped Tauri binary, its
startup/defaults, and its data directory are not part of this feature.

The launcher requires both the opt-in flag and an explicit absolute executable
path. The native client requires an explicit numeric loopback HTTP origin with a
port; it does not discover installed configuration, read app data files, follow
redirects or use environment proxies. The composer requires an explicit HTTP
operator bearer in `O8_NEXT_API_TOKEN`; its mutations use the existing composer
queue and Inbox approval endpoints.
Responses are bounded to 16 MiB and requests time out after five seconds.

## Existing contracts

Default server responses and authentication policies remain unchanged. Opt-in
`page=1` on the existing mobile history GET adds the shared chat-history cursor
metadata. `before` follows that cursor; a changed revision returns HTTP 409 and
the viewer offers Refresh. Runtime pages cover history retained by their existing
adapters; this does not recover histories the runtime has already discarded.

| Purpose | Existing source and contract |
| --- | --- |
| Saved session list | `src/app/api/mobile/orchestrator/threads/route.ts`: GET, `limit=500`, `{threads}`; thread id is used unchanged |
| Runtime worker discovery | `src/app/api/runtime/inventory/route.ts`: GET; merge `{agents}` by original `sessionKey` |
| Sidebar packet attention | `src/app/api/orchestrator/state/route.ts`: GET; join packets by `orchestratorThreadId` |
| Saved composer context | `src/app/api/v2/chat-history/route.ts`: GET with `tabId`, `limit=100` |
| Operator queue | `src/app/api/orchestrator/composer-queue/route.ts`: GET items/capabilities, POST frozen payload/id, PATCH existing id to steer |
| History used by web transcript store | `src/lib/transcripts/bootstrap.ts`, `src/app/api/mobile/history/route.ts`: GET with `sessionKey=llm-chat:<thread id>&limit=100`, `{sessionKey,transcript}` |
| Transcript fields | `src/lib/mobile/types.ts`: `MobileHistoryResponse`, `MobileTranscriptEntry`, `MobileTranscriptToolCall` |
| Web presentation | `WorkspaceTranscript.tsx` -> `workerTranscriptBlocks`, `groupActivitySteps`, `WorkerProse` -> `sanitizeTranscriptText`, `renderLLMMarkdown` |
| Live session history | `src/lib/transcripts/wireWsBridge.ts`, `src/ws-server.ts`: `realtime-subscribe` for `session:<sessionKey>`, realtime batches containing `history.snapshot` with `{sessionKey,entries,replace}` |

The native client gets port/token from the existing `/api/panel/ws-info` route,
then connects directly to the same numeric loopback host at `/ws?token=...`.
It sends `realtime-subscribe` with the selected `session:<sessionKey>` only;
it does not subscribe to unrelated global/provider inventories. It follows the
desktop provider's sequence, captured-sequence and boot-id rules. Reconnect uses
bounded backoff and omits `since` to request a fresh checkpoint. The selected
session ignores other streams and other session payloads.

`replace: true` replaces the live window, including an empty window. Explicitly
backfilled rows before an overlapping checkpoint remain retained. Empty or
disjoint replacement clears the old window and its pagination cursor. Other
updates use the dashboard's `mergeTranscriptEntries` semantics, preserving
optimistic local entries and supported metadata while allowing old server history
to disappear. Unpaged retention is capped at the web store's 200 entries; explicit
backfill retains the requested older pages. The client never
assumes that updates append or that completed tool results are immutable.

## Native Inbox

In the app shell, use Ctrl+K / Cmd+K and **Open Inbox**. Needs reply,
Contributions, Approvals, Agent issues and History show their own counts, source
and status. This workspace and All repositories scope the thread and incident
views; approvals always span all workspaces. Left/Right changes views, Up/Down
selects cards, Enter opens the related session or GitHub thread, and F5 refreshes.
Scrolling has no visible track. Returning to the surface retains its selected view.
Before any session is saved, Inbox opens globally without requiring a workspace.

Reads use the desktop's `/api/panel/supervisor-inbox` and
`/api/panel/approvals` routes. Reply deduplication, dismissed/history membership
and dossier exclusion match the desktop. Cached GitHub freshness and truncation
remain visible. Failed reads retain previous cards and expose a refresh error.
Approve and Reject send the same `{ action, id }` POST as the desktop to
`/api/panel/approvals`; existing middleware, principal checks and durable
continuation rules remain authoritative. A recorded but unconfirmed continuation
disables both decision controls. An unconfirmed delivery refreshes persisted state
before another decision. Session links open the exact existing transcript;
GitHub links use the platform URL opener restricted to HTTPS GitHub URLs.

Approval buttons accept Tab/Shift+Tab and Enter/Space, paint a visible focus ring,
and skip busy or unconfirmed decisions. View navigation returns focus to Inbox.
For ChatGPT-plan cards, the launching host can supply its current desktop session
through `O8_NEXT_CLERK_SESSION_TOKEN`. It is sent only on the approval POST as
`x-clerk-session-token`, alongside the operator bearer, through the desktop's
existing owner/session/account/generation checks. The original signed-in desktop
binding must already exist. This standalone experiment does not acquire, bind or
refresh that short-lived identity; missing or expired sessions remain refused.
The credential stays in process memory and is excluded from arguments, logs and
saved shell state. The shell launcher drops it for workers or a different origin.

Inbox uses the shared semantic colors and platform fonts in `src/theme.rs`,
which landed on main during review. Desktop type sizes remain unchanged.
Headless verification uses production route handlers and persisted fixtures:

```sh
cargo +stable test --release --locked --manifest-path native/o8-next/Cargo.toml inbox -- --nocapture --test-threads=1
cargo +stable build --release --locked --manifest-path native/o8-next/Cargo.toml
node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/dev-server.ts --shell --inbox
```

The fixture host is account-free. GPUI TestAppContext opens the production shell
with offscreen window options, compares all five views with the desktop routes,
and compares native/desktop persisted approval decisions and audit events.
It also covers worker refusal, uncertain continuations, exact session selection,
GitHub navigation, restart, empty/error states, and compact/wide geometry.
These are CPU scene and layout checks with the test text system, not font, GPU
or compositor acceptance.

## Verification

For three macOS release composer runs against fresh disposable fixture hosts:

```sh
cargo +1.97.1 build --manifest-path native/o8-next/Cargo.toml --release --locked
O8_NEXT_BINARY="$PWD/native/o8-next/target/release/o8-next" node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/macos-composer.ts
```

The runner always passes `--offscreen`, checks that the window stays inactive,
and limits each child to nine seconds. It records CPU scene acknowledgement,
not GPU presentation or physical input latency. See [macOS composer evidence](evidence/macos-composer.md).

```sh
cargo +1.97.1 test --manifest-path native/o8-next/Cargo.toml --release --locked
npx vitest run tests/next-render-parity.test.ts tests/next-stream-parity.test.ts
node cli/esbuild.config.mjs
O8_NEXT_BINARY="$PWD/native/o8-next/target/release/o8-next" node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/verify.ts
node scripts/next/license-audit.mjs
O8_NEXT_BINARY="$PWD/native/o8-next/target/release/o8-next" O8_NEXT_STREAM_RESULTS=native/o8-next/evidence/stream node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/verify.ts
```

The original three history recordings were captured through the production history route from
**authored disposable persisted sessions**, not private operator histories or live
provider runs. The long recording proves the existing 120-to-100 tail behavior.
The web oracle inspects the actual production React elements and tool grouping;
it is not another Markdown parser. The Rust renderer and its `--render-tree`
entry point consume the same typed model and expected trees. Five web checks
cover parity plus deliberate order/code/group mutations. Rust checks compare all
three trees and reject ambiguous or remote server origins.

The protocol runner starts and reaps its own server, compares fresh HTTP responses
with recordings and native trees, then runs the built CLI -> native asynchronous
session list -> history -> GPUI paint path. It verifies that an inherited database
path was never opened, rejects invalid native invocations before UI startup, and
asserts that every request used the existing list/history/ws-info GETs or the
read-only WebSocket subscription/ping messages. The host always generates a fresh
fixture credential, even if a token was inherited. The WS replay peer uses the
production wire schema; it does not import the large server startup module or
start runtime/provider discovery. This is protocol interoperability with a replay
peer, not a live provider run.
`--record` explicitly regenerates recordings and trees; ordinary verification
compares them without updating expected output. UTC fixes timestamp labels.

The live replay oracle runs the **actual desktop WebSocket provider** with the
dashboard's configured merger and production transcript renderer. Rust offline
replay and three native network runs must reach the same final structured tree.
Recordings include stale/late events, a real transport reconnect with checkpoint,
empty replacement, boot restart, wrong-session data, and an advancing partial
history window. Five additional production-merger cases cover optimistic entries,
metadata, argument order and duplicate-id ordering.

The retention probe checks unchanged row-state identity and monotonic layout
counters. A deliberately broken binary that recreated rows failed this assertion;
the retained implementation passes. See [stream receipts](evidence/stream/README.md).
The original static-only receipts remain in `evidence/verification.md`.

The preview-only tool case initially failed with native groups `[0,1,1,2]` versus
the web's `[0,0,0,1]`. Keeping absent command arguments distinct from empty string
arguments fixed the failure. See `evidence/verification.md` for final receipts.

UI imports come exclusively from `gpui = 0.2.2` (Apache-2.0). The locked normal/build
graph audit rejects GPL licenses and the excluded editor, terminal and markdown
application crates. Transitive dependencies include other permissive and MPL-2.0
licenses; the whole graph is not described as Apache-only.

Published GPUI pins Taffy exactly 0.9.0. A documented MIT-licensed
[manifest-only Taffy backport](vendor/README.md) selects patched Grid 1.0.1;
Taffy's published Rust source is unchanged. No security checks are suppressed.

## Measurements and unattended work

`--offscreen --benchmark FILE` runs the actual asynchronous session-loading path,
then acknowledges 20 Home/End keystrokes and 50 alternating scrolls inside GPUI.
Each keystroke must reach the scene's paint callback, and the first and last
content rows must reach their own paint callbacks. The scroll timer includes
the first draw after changing the visible range. Cold start includes HTTP loading
and the first content scene. Memory is RSS of this binary only. The base static run receipts and limits are in `evidence/metrics.md`; current
streaming results are in `evidence/stream/README.md`.

Needs an unattended on-screen run: compositor frame cadence and content capture.
GPU latency and compact/wide visual acceptance also remain unverified; this helper
does not automate those checks. The single script
`scripts/next/unattended-on-screen.swift` launches the explicit experiment binary
with a seven-second lifetime and in-process navigation, then captures only that
child PID's exact `o8 next` window for five seconds. It never sends OS input or
activates windows. Compile it with `swiftc -parse-as-library` and pass the binary,
the disposable server origin, and an output JSONL path. It was typechecked but
**not executed**. Captured complete frames still do not establish photon timing.

## Sidebar and composer (#4462)

The composer uses the existing durable queue API. Steer is the default when the
server advertises `canSteer`; otherwise it sends next. The mode control (or
Ctrl+Shift+Enter) selects Send next explicitly. Queued records expose Steer now
only for their server-advertised capability and before admission. F6 promotes
the first eligible record. Enter sends, Shift+Enter adds a line, and Tab switches
between composer and sidebar keyboard navigation. IME confirmation never sends.
Paste preserves line breaks; Unicode selection, copy/cut, undo/redo and scrolling
through long input use GPUI's platform text-input contract.

This slice sends text in Solo mode using the saved backend/model and latest
assistant permission receipt (workspace Full when absent; never inherits an
outside-workspace grant). Effort is Medium. The routing is shown before sending.
Drafts and undo stacks are retained per session in memory. An unconfirmed send
keeps its draft, identity and routing for retry during this process; it is not a
cross-launch draft store. Confirmed operator echoes come from persisted history.
Legacy history remains readable when its routing is insufficient for sending.

Sidebar sessions poll the existing session and mission APIs once per second and
use Working, Review and Recent groups. Review sorts attention before recency;
other groups sort by last message. Queue reconciliation preserves the live
transcript and its retained row layouts.

The mode control says "Steers the running turn" or "Queued for after this turn".
Queued messages also expose Remove; F7 removes the first cancellable message.
Removal uses the existing DELETE endpoint and cannot stop an admitted turn.

Set `O8_NEXT_API_TOKEN` to the selected server's operator bearer through the
environment. The native process sends it only to that numeric loopback HTTP
origin, without redirects or proxies; it never logs the token or discovers
application files. The fixture host and client share an explicit environment
credential and cross production middleware.

On Linux without a display, run `verify.ts --protocol-only` plus
`cargo test --locked --manifest-path native/o8-next/Cargo.toml`. Composer tests use
GPUI TestAppContext, production HTTP handlers and persisted queue/history,
replacing only native runtime admission with a fixture acknowledgement. See
[sidebar/composer evidence](evidence/sidebar-composer.md).

## Pane grid (#4530)

The independent grid root is opt-in. The normal single-session surface and the
shipped Tauri app keep their existing behavior. The dedicated disposable fixture
host reuses the `dev-server.ts` pattern and prints an `origin` and a `workspace`:

```sh
node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/grid-dev-server.ts
node cli/dist/o8.mjs next --enable-next --binary "$PWD/native/o8-next/target/release/o8-next" --server ORIGIN --pane-grid 6 --workspace WORKSPACE --pane-layout "$PWD/work/pane-layout.json"
```

Create the `work` directory first. Use the printed origin and workspace values,
and provide the selected server's operator bearer through `O8_NEXT_API_TOKEN`,
as for the existing composer. No installed configuration or data path is read.
The fixture host supports the existing protocol-only checks without a desktop.
The grid window itself still needs a platform display; on Linux without one,
use the headless tests below.

The size choices are 1, 2, 4 and 6. Ctrl+Alt+arrow moves focus geometrically;
adding Shift moves the pane and its focus together. Tab/Shift+Tab cycles focus.
Home/End scrolls the focused transcript. Ctrl+Alt+W closes its viewer, leaving
the worker running. Ctrl+Alt+P cycles through sessions not already in a slot;
Ctrl+Alt+1/2/4/6 changes size. Ctrl+Alt+Enter zooms the focused pane. The toolbar
also exposes size, session selection, zoom and refresh; headers expose Close.

The explicit layout file stores size, ordered session keys and focus separately
for each exact workspace path. A saved workspace layout takes precedence over
the initial command-line size. Smaller grids retain their hidden slots, live
streams and scroll positions. Closed viewers drop their subscription. Missing
sessions retain their slot and show “unavailable”; refreshing retries discovery.
Invalid layout files are rejected before window startup and preserved.

Saved threads and runtime workers come from the existing thread and inventory
GETs. Original worker keys select the existing history GET and session stream;
there are no new server routes. Each slot uses the existing native transcript
merger and retained row renderer. Headers contain at most 40 Unicode scalar
values of title and static state words from session status/outcome fields.
Hidden slots do not enter the element tree. Clip gates defer both header and
transcript layout until visible, before any text shaping or painting.

```sh
cargo test --locked --manifest-path native/o8-next/Cargo.toml
npx vitest run tests/o8-next-pane-grid-real-path.test.ts tests/next-render-parity.test.ts tests/next-stream-parity.test.ts
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml pane_grid_measurement -- --ignored --nocapture
```

Initial transcript-grid measurement endpoints and raw samples are in
[pane grid evidence](evidence/pane-grid/README.md). Per-slot terminal behavior
and its measurements follow below.

## Opt-in diff and packet review (#4531)

The separate read-only diff mode builds on main and does not require the open
transcript or terminal PRs. It leaves the ordinary transcript/composer launch
path and the shipped Tauri app unchanged. After building the native binary, use
the existing CLI launcher with one explicit target:

```sh
node cli/dist/o8.mjs next --enable-next --binary "$PWD/native/o8-next/target/release/o8-next" --server ORIGIN --review-packet PACKET_ID
node cli/dist/o8.mjs next --enable-next --binary "$PWD/native/o8-next/target/release/o8-next" --server ORIGIN --diff-worktree WORKTREE --diff-base main
```

`--diff-file RELATIVE_PATH` optionally limits a worktree read to one file. The
file list shows added, removed, renamed and modified states, counts, and the
original rename path. Permission changes retain their actual mode metadata.
Unified and split views share parsed rows, syntax spans and fixed 20 px heights;
GPUI's uniform lists materialize only visible file and diff rows. Long lines
scroll horizontally within the diff. U/S switch views, Home/End navigate rows,
Alt+Up/Down select files, and R refreshes. Binary changes are labeled without a
content preview. Tree-sitter highlights TypeScript/TSX, Rust, Markdown and JSON
from each side's displayed snippets; absent hunk context is not fetched.

Packet mode reads `/api/lanes/[id]/diff` and
`/api/orchestrator/review-state`, then posts decisions to the existing
`/api/orchestrator/review` endpoint with the displayed full HEAD and a retained
client mutation identity. It rereads the diff before posting and refreshes
persisted review state afterward. An unconfirmed response offers Retry decision
with the original body; Refresh discards that local attempt and reloads state.
Existing server governance refusals remain refusals. Worktree mode uses
`/api/worktrees/diff` and has no decision controls. Server byte limits apply;
truncated, incomplete, unsupported or empty patches cannot authorize a decision.
Colored/custom patch output is reported as unsupported rather than silently
omitting changes. No server routes or authentication policies are added.

Run the disposable production-handler host with `--review` to author fixture
Git and packet state. Its origin line is the same as the existing dev-server
pattern; the packet ids are `next-review-approve` and `next-review-reject`.
`O8_NEXT_API_TOKEN` must be supplied explicitly to both host and client.
`--review-drop-first` adds a fixture-only lost response after the first persisted
rejection, used by the GPUI retry regression. Neither mode starts providers or
uses accounts.

```sh
node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/dev-server.ts --review
```

The tests start and reap their own fixture host:

```sh
mkdir -p work
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml
npx vitest run tests/next-diff-review-real-path.test.ts tests/next-render-parity.test.ts tests/next-stream-parity.test.ts
O8_NEXT_DIFF_EVIDENCE="$PWD/work/diff-run.json" cargo test --release --locked --manifest-path native/o8-next/Cargo.toml diff_real_server -- --nocapture --test-threads=1
```

The headless GPUI test drives file/mode/decision controls, a real lost HTTP
response and retry, source drift, production colored output, truncation and wheel
events. It measures selected-file HTTP load through the first scene paint,
50 wheel frames, 50 alternating first/last viewport jumps, and native-process RSS
for 1,000 and 20,000 added lines in both modes. The test text system supplies no
native font shaping or GPU/compositor presentation; this does not establish
on-screen frame cadence. See [diff verification](evidence/diff/verification.md)
for raw samples, audit results and remaining acceptance.

## Real worker composer (#4532)

Add `--worker` to the disposable dev-server command to run the production HTTP
handlers and `src/ws-server.ts` with a real Pi SDK child process. The fixture
replaces only model inference and external tool servers. Its owned temporary
workspace and session store never use accounts or installed app data. It supports
the existing queue POST/PATCH/DELETE and production mobile history/sync handlers;
it adds no application routes. The original replay fixture remains available.

Send `Start streaming` to start the fixture's 20 Hz response. Subsequent steers
are delivered to that running Pi session. Queue mode waits for its turn to end.
Writing `release` followed by a newline to the dev server's stdin releases the
fixture model response; this is test control outside the application protocol.
The fixture recognizes `Steered instruction`, `Promoted instruction`,
`Queued instruction` and `Idle message` in later model contexts.

```sh
npx vitest run tests/composer-next-worker-real-path.test.ts
cargo test --locked --manifest-path native/o8-next/Cargo.toml
O8_NEXT_WORKER_RESULTS=work/worker-run.json cargo test --release --locked --manifest-path native/o8-next/Cargo.toml worker_send_steer_queue_promote_remove_and_streaming_latency -- --nocapture
```

The headless test types and submits through the GPUI composer, observes actual
worker output through the production WebSocket history bridge, and clicks queue
actions. Timers acknowledge changed input and worker content in CPU scene paint.
The existing one-second reconciliation tick refreshes the saved history tail,
including changes to an existing assistant id that the sync cursor omits. Older
retained rows survive; sequence/boot and request revisions reject stale reads.
Linux TestAppContext uses a no-op text system; these are neither GPU presentation
nor physical keyboard timings. See [worker composer evidence](evidence/worker-composer.md).

## Pane grid with per-slot terminals (#4530)

Slots reuse the standalone terminal pane and transport from #4502. This adds
grid attachment, visibility and focus handling to that shared implementation.

The explicit grid uses 1, 2, 4 or 6 slots. Start the disposable fixture host:

```sh
node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/next/grid-dev-server.ts --terminals
```

It prints an allocated loopback `origin` and a temporary `workspace`. Its six
runtime workers have persisted transcripts and distinct real fixture PTYs, served
by the production inventory/history routes and `src/ws-server.ts`. It uses no
accounts. The ordinary grid fixture without `--terminals` retains its independent
history replay streams. Both hosts stop after two minutes.

Build the native binary, set `O8_NEXT_API_TOKEN` explicitly for the selected
server, and substitute those exact values below. `LAYOUT_FILE` must be an explicit
absolute file in an existing writable directory:

```sh
cargo build --release --locked --manifest-path native/o8-next/Cargo.toml
native/o8-next/target/release/o8-next --enable-next --server ORIGIN --pane-grid 6 --workspace WORKSPACE --pane-layout LAYOUT_FILE
```

Ctrl+Alt+T switches the focused slot between its transcript and terminal. The
header's Transcript/Terminal control does the same. Terminal attachment uses
only the exact `tmuxSession` binding from the existing runtime inventory; a worker
without one shows an unavailable message. No terminal is created by this UI.
The standalone `--terminal SESSION_ID` mode uses the same terminal entity and
transport; it cannot be combined with `--pane-grid`.

Ctrl+Alt+arrows moves focus geometrically, adding Shift reorders a pane with its
session and view. Ctrl+Alt+1/2/4/6 changes the layout, Ctrl+Alt+Enter zooms,
Ctrl+Alt+W closes and Ctrl+Alt+P chooses the next unassigned session. In a focused
terminal, ordinary Tab, Home/End, arrows, text, paste and IME go to that terminal;
use the grid shortcuts to leave it. Titles stay within 40 characters and headers
show static session state words.

The selected view persists alongside ordered session keys, size and focus per
workspace. Existing layout files default to transcript in every slot. Invalid
view names or counts fail before opening a window and retain the original file.
Changing a slot to transcript, reducing the grid, zooming another slot or clipping
the slot leaves its terminal attached and parsing into bounded scrollback, while
its glyph shaping and painting stop. Closing or replacing the session drops only
that viewer attachment. Unrelated workspace layouts remain intact.

Linux headless checks and optimized CPU scene measurements:

```sh
cargo test --locked --manifest-path native/o8-next/Cargo.toml
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml grid_terminal_measurement -- --ignored --nocapture
npx vitest run tests/o8-next-grid-terminal-real-path.test.ts tests/o8-next-pane-grid-real-path.test.ts tests/next-terminal-real-path.test.ts tests/next-render-parity.test.ts tests/next-stream-parity.test.ts
O8_NEXT_TARGET=x86_64-unknown-linux-gnu node scripts/next/license-audit.mjs
```

The terminal parser is the published Apache-2.0 `alacritty_terminal` crate; all UI
uses GPUI. No GPL application crates are used. See
[slot terminal verification](evidence/slot-terminals/verification.md) for retained
red/green receipts, six-slot measurements and the remaining display acceptance.
The shipped Tauri app is unchanged.




## Issues in the opt-in app shell

Open **Issues** from the app shell command palette. Registered GitHub repositories
use the existing operator-authenticated panel routes. Search open issues by title
or number, or open a number directly to read a closed issue. The native viewer
includes Markdown, metadata, labels, readiness, GitHub links and retry with retained
data after a failed refresh.

New issue supports title, Markdown description, labels, preview, enhancement and
creation through the desktop's existing routes. Link an issue and open **Task
composer** to choose a saved worker session in the existing sidebar. **Work on
issue** sends its context through that session's normal durable composer queue;
missing checkouts and existing drafts refuse the launch. Link choices are scoped
to the selected session and stay in memory; submitted context persists in the
queue and worker history. Fresh desktop CLI-session creation is not ported here.

This adds no installed-app default, server route, dependency, release or publishing
change. See `evidence/issues/verification.md` for parity and fixture measurements.
