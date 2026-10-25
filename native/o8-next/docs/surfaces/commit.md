# Commit viewer

The opt-in viewer registers in `src/surfaces/commit.rs`. Its source, actions, refusal states and regression test function names are retained from the preceding port head.

The disposable host discovers its fixture entry without shared dispatcher edits. Existing authenticated production routes remain authoritative.

The shared `main.rs`, `client.rs`, workspace state, shell view/test dispatchers and development host match main. The shell inventory has one entry for this surface. `commit/requests.rs` owns mutations and commit-patch reads, using the shared transport helpers with the same operator authentication, status decoding, error scrubbing and revision payloads.

Window-close and Projects draft refusal remain enforced. The six-line generic draft query in `surface_registry.rs` lets shared lifecycle actions ask registered views whether they have unsaved changes. The five-line check in `surfaces/projects.rs` must run before Projects refreshes repository membership: removing it fails the real-shell regression after desktop unregisters an owned repository and refresh destroys its editor entity. The current registry has no refusal hook at that entry point. The surface owns its window-close callback.

The five added lines in `diff.rs` supply the immutable commit target and delegate its load to this surface. The existing renderer requires that target to keep Patch and Refresh reading the selected commit. Its request, privacy check and long-line bounding live in `commit/requests.rs`; the shared parser and renderer stay in use. Existing source-input and production-route safety fixes remain intact.

Regression test function names are unchanged; fixtures extend `shell::test_support`.
