# Workspace thread sidebar verification

## Real entry points

`tests/next-sidebar-real-path.test.ts` starts the disposable route host and calls
production mobile-thread, desktop-history-list and metadata PATCH handlers.
`src/shell_tests.rs` and `src/sidebar_tests.rs` (under `native/o8-next`) open the
production shell with GPUI TestAppContext and offscreen windows. They compare
every native row with production route records ordered by the desktop attention
helpers in `scripts/next/sidebar-oracle.ts`: workspace, section, identifier,
title, order, badge state and running state. Renames and archive read back the
same persisted records and preserve their message counts. Worker archive reads
back the production runtime archive store; worker selection retains its original
session key and opens its persisted history. Streamed running/ready transitions,
unread markers, keyboard selection, draft retention, Unicode rename and message
search use the existing editor, APIs and socket protocol.

The owned host authors 2,000 chats across two workspaces, an unassigned chat,
baseline fixture sessions and a persisted runtime worker. Its replay peer uses
the existing global/session event schemas, including the production-sized short
initial snapshot; it does not run a real account or operator desktop.

## Red before fix

Preserved tails are next to this file. The first route test observed 2,500
repeated page records instead of 2,000 because offset was ignored. The first
native shell test exposed only 500 of the expected 2,000 authored chats. The
later regression tails preserve worker archive, retained selection/F8, live
failure recovery, message search and unassigned selection failures. Each was
captured before its fix. Fixture-directory names are replaced by `[fixture root]`.

| Check | Before | After |
| --- | ---: | ---: |
| Native authored chats available | 500 | 2,000 |
| Unique authored chats via paged route | repeated first page | 2,000 |
| Message-only search matches | 0 | 2,000 |
| Unassigned thread selected | previous session | saved unassigned session |

## Headless release measurement

Rust 1.97.1, Node 22.23.4, Linux, locked release build. Ten newly opened shell
windows against one disposable fixture host yield ten first-paint samples and
500 wheel/paint samples. Fixture-host and process startup are outside the first-
paint timer; HTTP bootstrap, shell construction and first sidebar row paint are
inside it. The first window has cold route caches; later windows share that host.
Every scroll sample dispatches an actual GPUI wheel event and paints its next
CPU scene. Assertions check later virtual rows, the final row, and row paint
acknowledgements. The benchmark is rerun after builds and other checks finish.

| Endpoint | p50 (ms) | p95 (ms) |
| --- | ---: | ---: |
| First painted sidebar row | 414.200 | 597.412 |
| Wheel event through next CPU scene paint | 2.840 | 6.206 |

Maximum materialized rows: **22**. Raw samples and nearest-rank percentiles
are in `run-1.json`. No before timing is claimed because the native sidebar did
not exist. The before/after count above comes from the real-path red/green test.
GPUI TestAppContext uses its test text system. These numbers exclude native font
shaping, GPU submission/presentation and compositor scheduling. No visible
window was opened.

## Completion checks

`gate-status.json` records exits for `NODE_OPTIONS=--max-old-space-size=8192 npx
tsc --noEmit`, `npm run typecheck:fast`, ESLint on all seven touched TypeScript
files, `npm run rule-check -- --base=origin/main`, and test classification.
`green-tail.txt` preserves final JavaScript, sidebar, native and o8d summaries.
The final JavaScript command runs these files:

- `tests/mobile-orchestrator-threads-route.test.ts`
- `tests/next-sidebar-real-path.test.ts`
- `tests/o8-next-shell-real-path.test.ts`
- `tests/next-render-parity.test.ts`
- `tests/next-stream-parity.test.ts`
- `tests/release-artifacts.test.ts`
- `tests/o8-next-grid-terminal-real-path.test.ts`

Result: seven files, 38 passing tests. The final native run passes 34 unit tests
and seven CLI tests; three existing explicit measurement workloads stay ignored.
The isolated sidebar measurement above runs explicitly and passes. o8d passes
eight tests.
Native build/test commands use the README's `+1.97.1`, `--locked`, and release
flags. o8d is built with `experimental-http` before its native read test and is
also tested with `--all-features`.

The one full npm run and its remaining baseline account fixture failure are
recorded in `npm-test-summary.txt` and #4633. The final focused JavaScript run
includes mobile threads, sidebar, shell, render/stream parity, artifact provenance
and the newly landed grid-terminal path.

Main had no `native/o8-next/src/theme.rs` at start (31ccf0315); sidebar colors
stay local to its new view file. The final branch integrates current main's grid
terminal changes without editing release, version, deployment or publishing files.

[Correction round 1](correction-1/README.md) records the test-first fix for a live
message shifting a chat across offset pages, plus the repeated-page fallback.
