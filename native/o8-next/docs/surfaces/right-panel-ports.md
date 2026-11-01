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
