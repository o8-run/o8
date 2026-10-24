# Native issues evidence

Review correction round 2 binds creation receipts and sends to their owning
account, and keeps definite 429 refusals retryable. See the latest
[correction evidence](round-2/verification.md) for the red/green receipts and
current completion results.

Review correction round 1 adds per-repository drafts, idempotent creation retries,
canonical-path refresh and a frame-gap repository-switch regression. See the
[correction evidence](round-1/verification.md) for current verification counts and
red/green receipts; the original port evidence and measurements follow below.

The opt-in app shell opens an Issues tab using the shared native theme, editors,
Markdown renderer, session sidebar and durable composer. It calls the existing
panel repository/issue/detail/enhance/create routes with the selected server's
operator bearer credential. GitHub installation credentials stay in the broker.
The installed app, dependencies, release and publishing configuration do not change.

## Desktop parity

| Desktop control/state | Native counterpart | Status |
| --- | --- | --- |
| Viewer title, state, author, date, comments and labels | Native detail header and metadata | Ported |
| Description and empty description | Existing native Markdown renderer and empty-body text | Ported for reading; embedded media and inline link interaction remain limited by the native renderer |
| GitHub link | GitHub control via GPUI URL handoff | Ported |
| Loading, error, retry and last successful detail | Named loading state, Retry and retained detail | Ported |
| Repository readiness and missing-checkout refusal | Readiness text and blocked Work control | Ported |
| Work on issue | Existing native worker session and durable composer queue | Partial: fresh desktop CLI-session creation is missing |
| Creator title and Markdown description | Existing GPUI Composer editors | Ported; Shift+Enter inserts a newline |
| Label Enter, normalization, deduplication, Backspace and remove | Label editor and removable label controls | Ported |
| Preview/Edit | Native Markdown preview toggle | Ported |
| Enhance and enhancement errors | Existing enhance POST, merged label suggestions and retained draft | Ported |
| Create, required title, busy guard and success | Existing create POST and numbered success state | Ported |
| Picker open/close/Escape | Shell Issues command, Issue list, Escape and shell tab close | Adapted to a persistent native surface |
| Registered/preferred repository selector | Registered remote buttons, preferred workspace selection | Ported for HTTPS and scp-style SSH GitHub remotes |
| Search title/number, open-only list and selected marker | Search editor, Link and selected indicator; direct number lookup also reads closed issues | Ported |
| Linked summary, Open issue and Clear link | Native footer controls | Ported |
| Linked context in the worker message | Session-scoped link and compact context in the frozen queue wire message | Ported; the real fixture worker confirms receipt |
| Saved link choice across app restarts | Submitted context persists in queue/history; unsent link choice stays in memory | Missing restoration of the unsent link choice |

## Real entry points and red-first order

`tests/next-issues-real-path.test.ts` starts the existing disposable route host.
It crosses production middleware and handlers, then the production GitHub broker
against an isolated GitHub installation transport. The fixture generates its
signing key at runtime and has separate installation credentials per repository.
An outside repository is refused by the installation transport. Creation is read
back through the production detail route. Enhancement replaces only the model
transport. No account or provider service participates.

`native/o8-next/src/issue_tests.rs` opens the actual shell and drives palette,
mouse, keyboard and platform text events. Six GPUI tests cover viewing open and
closed issues, title/number search, link/open/clear, creator validation, labels,
enhancement, preview, creation, stale-detail retry, server mutation refusal,
repository/account switching, missing checkouts and worker-session selection.
The worker case starts the repository's actual fixture Pi worker and verifies a
persisted streamed reply confirming that the linked title and body reached its
model transport. It uses the same 35-second heartbeat deadline as existing native
worker tests. Queue receipt paths are compared through canonical filesystem paths.

The HTTP regression first failed at the absent issue route. The first four GPUI
cases failed at absent native issue controls. Later red cases caught unavailable
worker-host issue routes, a stale link indicator after selecting another worker,
missing direct-number lookup, and editor focus changes dropping a repository
click. The shared shell mouse-down focus handling fixes that click failure.
Sanitized receipts are retained in `red-server.txt`, `red-native.txt`,
`red-worker.txt`, `red-selection.txt`, `red-number.txt` and `red-focus.txt`.

GPUI 0.2.2 retains old debug bounds after controls disappear. These tests use
canvas paint receipts to verify current controls; debug bounds only locate a
control after its current paint receipt has been observed.

## Verification

All completion checks pass after rebasing onto the landed native Inbox addition.
Both surfaces remain registered and their fixture workflows pass. The touched TypeScript run reports **3 files / 8 tests**;
the full native run reports **42 passed / 3 ignored**, plus **7 passed** CLI tests.
The full `npm test` reports **1,233 files / 8,896 tests passed**, with **3 files /
5 tests skipped**, in **392.39 seconds**. TypeScript (8 GiB heap), fast typecheck,
touched-file ESLint, Rust formatting, classification and the rule check (four
eligible files, zero violations vs refreshed `origin/main`) pass. See `green.txt`.

| Mechanic | Before | After |
| --- | ---: | ---: |
| Native issue tabs | 0 | 1 |
| Native view / create / link flows | 0 | 3 |
| GPUI issue regression cases | 0 | 6 passing |
| Missing fixture issue route | HTTP 404 | HTTP 401 anonymous / 200 operator |

Commands used (Node 22, stable Rust, Linux):

```sh
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit
npm run typecheck:fast
npm run test:classify
node scripts/classify-tests.mjs --check
npx vitest run tests/next-issues-real-path.test.ts tests/composer-next-worker-real-path.test.ts tests/o8-next-shell-real-path.test.ts
npx eslint scripts/next/dev-server.ts scripts/next/issues-fixture.ts scripts/next/worker-server.ts scripts/next/worker-runtime.ts tests/next-issues-real-path.test.ts
npm run rule-check -- --base=origin/main
npm test
cargo build --locked --manifest-path crates/o8d/Cargo.toml --features experimental-http
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml -- --test-threads=1
cargo build --release --locked --manifest-path native/o8-next/Cargo.toml
```

The native suite needs its existing o8d fixture binary. This environment used
`O8D_HTTP_TEST_BINARY` to select that built binary, workspace-local linker names
for installed Linux runtime libraries, and a workspace-local tmux for the existing
PTY fixtures. The initial broader native run had one failure because its o8d
binary had not been built; the fixture was then built before verification resumed.
An intermediate run while other builds were active timed out in an existing worker
fixture. The final full run with all prerequisites and no competing builds passes.

No native dependencies were added. The unchanged locked graph audit passes for
472 Linux and 455 macOS packages, with zero GPL or excluded application crates.
The crate and this original implementation are Apache-2.0; existing transitive
license declarations are unchanged. `license-audit.json` retains the summary.

## Fixture measurements

The endpoint is GPUI TestAppContext CPU scene paint with its test text system.
Open starts immediately before selecting Issues in the real shell palette and
ends after loaded issue controls paint. It includes HTTP reads and native layout;
it excludes process/fixture startup. Each interaction sample replaces the search
query through focus, select-all and platform text input, then draws the resulting
scene. Twenty samples are retained per run; p95 is nearest-rank sample 19 of 20.

These are headless fixture measurements. Native font shaping, GPU submission,
compositor presentation, macOS execution and compact/wide visual inspection have
not been measured in this environment. There was no issue surface for a numeric
before-performance baseline.

| Run | Open to first CPU frame ms | Search interaction p95 ms |
| --- | ---: | ---: |
| 1 | 65.615 | 3.776 |
| 2 | 58.900 | 4.836 |
| 3 | 70.499 | 7.332 |
| Median | 65.615 | 4.836 |

The three `run-*.json` receipts retain all 60 interaction samples;
`measurements.json` retains the aggregate. Before: unavailable. After: the values
above. This is a new surface, so no performance improvement is claimed.

## Remaining scope

Fresh desktop CLI-session creation, restoration of an unsent link choice across
restarts, and embedded media/inline link interactions beyond the existing native
Markdown renderer remain unported. Work on issue uses an existing native worker
session. Use its sidebar to choose that session. This keeps the change referenced
rather than closing the issue; #4548 currently tracks the broader app shell.
