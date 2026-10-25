# Workspace thread sidebar (#4548)

The app shell includes a virtual native list grouped by workspace, then Working,
Review, Recent, Workers and Archived, including chats with no saved workspace
under Unassigned. It uses the existing mobile thread route
with bounded 500-record offset pages, the desktop archived-history route, runtime
inventory and packet attention state. Worker keys are preserved when opening the
existing session surface. The embedded transcript keeps its drafts and no longer
renders a second session sidebar.

Ctrl+F / Cmd+F opens search using the existing native text editor. Titles,
workspaces and states filter immediately; message text uses the desktop history
search route after a 300 ms debounce, rejecting results for an older query. F8 focuses
sidebar navigation; Up/Down and Home/End move through threads and Enter opens
the choice. Escape clears search. F2 renames a saved chat. Delete archives the
choice or restores an archived saved chat. Mouse controls appear on hover or
keyboard focus. Saved chat metadata uses the desktop PATCH endpoint; worker
archive uses `/api/runtime/archive` with a retained mutation identity for retry.
Worker renaming has no equivalent desktop action and is not offered.

The global event stream updates thread summaries and invalidates metadata on
snapshots and lifecycle events. A short snapshot never replaces the full list.
Broad fallback refresh is five minutes; runtime-only discovery is ten seconds,
matching the desktop rail. Session-history and composer reconciliation remain
independent of sidebar discovery. The sidebar uses the shared semantic tokens
from `theme.rs` alongside the other native surfaces.

The fixture host accepts `--sidebar` alongside `--composer --shell`. It authors
2,000 chats across two workspaces plus the baseline fixture sessions and one
persisted runtime worker, using production routes and a replay peer for the
existing event schema. Run headless checks and measurements with the documented
toolchain:

```sh
npx vitest run tests/next-sidebar-real-path.test.ts tests/o8-next-shell-real-path.test.ts tests/next-render-parity.test.ts tests/next-stream-parity.test.ts
cargo +1.97.1 build --release --locked --manifest-path native/o8-next/Cargo.toml
cargo +1.97.1 build --locked --manifest-path crates/o8d/Cargo.toml --features experimental-http --bin o8d
cargo +1.97.1 test --locked --manifest-path crates/o8d/Cargo.toml --all-features
cargo +1.97.1 test --release --locked --manifest-path native/o8-next/Cargo.toml -- --test-threads=1
O8_NEXT_SIDEBAR_RESULTS="$PWD/work/sidebar.json" cargo +1.97.1 test --release --locked --manifest-path native/o8-next/Cargo.toml sidebar_2000_thread_first_paint_and_scroll_measurement -- --nocapture --test-threads=1
```

First paint includes HTTP bootstrap through the first painted sidebar row.
Scroll samples include a wheel event and its next CPU scene paint, with bounded
materialization and first/last-row paint assertions. Linux GPUI TestAppContext
uses a test text system; these measurements do not include native font shaping,
GPU presentation or compositor cadence.

See the [preserved red/green receipts and 2,000-thread measurements](../../evidence/sidebar-thread-list/verification.md).

## Registration and shared seams

`src/surfaces/sidebar.rs` owns the rail runtime, its empty persisted slice,
initialization, refresh, content decoration, keyboard hooks and tests under
`src/surfaces/sidebar/`. Its sole inventory entry is in `register_surfaces!`.
The fixture entry is `scripts/next/surfaces/25-sidebar.surface.ts`; the shared
host no longer contains sidebar route or route-identity branches.

The rail needs generic initialization, refresh, tick, decoration and catalog
change hooks beyond the original tab/overlay contract. These hooks default to
no-ops in `surface_registry.rs`; the shell dispatches them without naming the
sidebar. Projects dispatches catalog changes so pending HTTP snapshots cannot
replace a newly selected project. The fixture contract similarly accepts a
surface-owned socket peer. Session embedding, shared HTTP/transport contracts,
backend pagination and the worker fixture retain the prior integration fixes.

Sidebar request adapters live in `src/surfaces/sidebar/thread_list_client.rs`.
They use `Client::get`, `url`, `request` and `read`, preserving operator bearer
handling, timeouts, response limits and mutation errors. `client.rs` is unchanged.
The existing `Client::sessions` entry delegates to sidebar discovery so standalone
sessions, grids and worker callers retain the same complete paged inventory.

Each shared file still changed has a cross-surface responsibility:

| Shared file | Why this cannot live only in the sidebar module |
| --- | --- |
| `native/o8-next/src/shell.rs` | Dispatch generic rail lifecycle hooks, normalize Unassigned workspace selection, and contain the single sidebar inventory entry. |
| `native/o8-next/src/surface_registry.rs` | Define shared initialization, refresh, tick, content decoration and catalog-change hooks with no-op defaults. |
| `native/o8-next/src/shell_view.rs` | Pass the shell's active content through registered decorators so a persistent rail can sit beside every surface. |
| `native/o8-next/src/surfaces/session.rs` | Own the shared Session record and compatibility `sessions()` entry used by grids, workers and standalone sessions; delegate discovery to the sidebar adapter. |
| `native/o8-next/src/shell_session.rs` | Expose retained-session selection and embed the existing session surface without constructing another session sidebar. |
| `native/o8-next/src/ui.rs` | Suppress the session surface's own rail when embedded while preserving standalone rendering and focus. |
| `native/o8-next/src/conversation.rs` | Reconcile embedded transcripts using shell-owned inventory rather than independently rereading every sidebar page each second. |
| `native/o8-next/src/transport.rs` | Reuse the shared authenticated WebSocket connection lifecycle for a global subscription without duplicating transport. |
| `native/o8-next/src/projects.rs` | Expose the Projects-owned ledger snapshot needed to retain registered repositories without chats. |
| `native/o8-next/src/surfaces/projects.rs` | Publish catalog-change notifications at the owner of project mutations so stale sidebar reads cannot overwrite newer choices. |
| `native/o8-next/src/issue_tests.rs` | Keep the previously fixed bounded real-I/O wait in the sibling Issues fixture tests that run alongside sidebar bootstrap. |
| `scripts/next/dev-server.ts` | Attach a discovered surface's socket peer at the shared HTTP server lifecycle boundary. |
| `scripts/next/surface-routes.ts` | Type the generic socket registration hook used by the shared fixture host. |
| `scripts/next/worker-server.ts` | Keep the history-list production route available on the separate worker fixture entry used by shell tests. |
| `src/app/api/mobile/orchestrator/threads/route.ts` | Admit the bounded offset query at the actual shared desktop/mobile HTTP endpoint. |
| `src/lib/mobile/orchestrator-thread-history.ts` | Apply bounded paging in the server's shared history reader so all clients read the same records. |
| `tests/test-classification.json` | Register the sidebar's real-path test in the repository-wide generated classification manifest. |
