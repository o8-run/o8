# Right-panel ports

## Activity

Reference: classic's `O8ActivityPane.tsx`, `O8ActivityCIDetail.tsx`,
`o8-activity-grouping.ts`, `o8-activity-helpers.tsx`, and `useO8ActivityData.ts`
under `src/components/desktop/`.

| Parity check | Native behavior |
| --- | --- |
| Repository scope and six filter pills | Existing native scope menu, filter counts, and saved per-scope expansion/scroll. |
| First use | The panel can open Activity for a selected folder before workspace view state has been saved. |
| Chronological feed and grouping | Fifty-row cap; repository-qualified commit/CI grouping; parsed instants determine order, including timezone offsets. |
| CI detail | Lazy validated reads; three failing jobs and first failed steps; bounded error summary; retained detail, cooldown, and explicit retry. Detail freshness is two minutes. |
| Retention | Per-checkout remote streams survive failed reads. Broker stale PR/issue snapshots work on first open and retain their upstream age. A failed repository-registry read retains known identities. Successful empty reads replace saved rows. |
| Local history | Revalidate the folder on every feed read; never retain a failed local history read as a successful one. |
| Live updates | Visible panes use the existing global event transport. Lifecycle/reconnect updates request fresh data; transcript-only batches do not. Covered panes release their subscription. The fallback is two minutes for an active native window and five minutes for an inactive window. |
| Idle auxiliary reads | Proposals and dossiers update on lifecycle events, focus, and explicit refresh, with a five-minute fallback. One-second shell maintenance does not reread and repaint these drawers. |
| Concurrent refresh | One in-flight feed read plus one coalesced trailing read, preserving fresh/manual intent. Automatic reads respect the repository cooldown; explicit Retry can recover. |
| Commit navigation | Show commit details and double-click open the shared native diff viewer through the existing commit-detail route. Back preserves the feed filter and expansion. The GitHub link remains available. |
| PR and issue navigation | Panel PRs open in the panel's native PR tabs, preserving the main conversation. The saved browser destination preference is read without changing defaults. Main-area Activity keeps its existing navigation. Issues use the shell's native issue view. PR previews show at most six files. |
| Packets and recommendations | Existing native mission controls, packet cards, review/editing controls, proposals, and recurring problems remain in place. Undated packets keep one per-mount timestamp; failed mission reads retain the known mission. |
| Motion and scrolling | No animation loop added; existing hidden-scrollbar scrolling remains. |

Verification uses headless GPUI controls and disposable fixture HTTP hosts. It
does not establish installed-app or compositor acceptance. The additional fixture
modes author upstream timestamps and a disposable local commit; production
handlers still serve the activity and commit data.

The original five-minute fallback fails
`activity_foreground_fallback_refreshes_after_two_minutes` before the port.
All thirteen cases in `activity/updates_tests.rs` passed across focused runs,
along with `activity_commit_details_open_native_diff_and_return_to_feed`.
The initial broader 44-case run passed 43 cases and exposed the rapid-click test
helper draining background work between presses. The corrected test dispatches
both real clicks before draining and passes. Fixture ESLint, touched-file
Rust formatting, and the whitespace check pass.

## Side chat

Reference: classic's `O8Panel.tsx`, `o8-panel/SideChatIntro.tsx`, and
`contextual-panel/surfaces.tsx` under `src/components/desktop/`.

| Parity check | Native behavior |
| --- | --- |
| Separate conversation | A dedicated thread per workspace; its ID is outside the main empty-chat reuse pool. |
| Shared conversation and composer | Uses the production `Surface`, composer, queue, history, and message rendering. No second chat implementation. |
| History isolation | The embedded view is bound to its own thread and cannot follow unrelated main-history selection. |
| Main conversation | Starting and using Side chat preserve the main tab and unsent draft. |
| Startup and recovery | Named loading state and an in-panel Retry after failure. No indefinite startup label after a confirmed failure. |
| Persistence | Reopening the panel or shell restores the workspace's saved Side chat ID and server history. |
| Appearance | Solid reading surface and classic's explanatory header. No animation loop added. |

The GPUI regression is
`side_chat_retries_sends_its_own_messages_and_restores_its_thread`. It drives the
tool and retry controls, types into the native composer, checks the production
queue and persisted history, preserves the main draft, and reopens the shell.
The fixture authors only its local lead and backend admission; history and queue
handlers are the existing production routes.

## Resources

Reference: classic's `O8ResourcesPane.tsx`. Uses the existing
`GET/POST /api/panel/resource-usage` routes without changing the collector or its
process-stop policy.

| Parity check | Native behavior |
| --- | --- |
| Metrics | Host totals, session and process sections, runtime/repository/PID labels, memory-sorted rows, proportional memory bars, monospace CPU/RAM values. Unknown readings remain em dashes. |
| Polling | One read at a time, at least 2.5 seconds after the previous completion, driven by existing shell maintenance. Covered tools pause; reopening reads again. No animation timer. Identical readings do not notify the window. |
| Failure | Retains the last good snapshot for transport and structured collector errors, with a visible error and Retry. A successful empty snapshot replaces old rows. |
| Stop | Hover or keyboard-revealed Stop, separate Kill confirmation, Cancel, one mutation at a time, explicit refusal feedback and a fresh read after success. The existing server decides whether a process can stop. |
| Verification | `resources_opens_from_launcher_and_shows_live_metrics` drives the launcher, Retry, Stop, Kill, Cancel and panel toggle. Authored metrics and request receipts establish UI behavior, not host process attribution or actual termination. |
