# Files viewer

The opt-in viewer registers in `src/surfaces/files.rs`. Its source, actions, refusal states and regression test function names are retained from the preceding port head.

The disposable host discovers its fixture entry without shared dispatcher edits. Existing authenticated production routes remain authoritative.

The shared `main.rs`, `client.rs`, `diff.rs`, workspace state, shell view/test dispatchers and development host match main. The shell inventory has one entry for this surface. `files/requests.rs` owns Save and uses `Client::url`, `Client::request` and `Client::read`, retaining operator authentication, timeout policy, status decoding and conflict responses.

Window-close and Projects draft refusal remain enforced. The six-line generic draft query in `surface_registry.rs` lets shared lifecycle actions ask registered views whether they have unsaved changes. The five-line check in `surfaces/projects.rs` must run before Projects refreshes repository membership: removing it fails the real-shell regression after desktop unregisters an owned repository and refresh destroys its editor entity. The current registry has no refusal hook at that entry point. The surface owns its window-close callback. Existing source-input and production-route safety fixes remain intact; Files does not use the shared diff renderer.

Regression test function names are unchanged; fixtures extend `shell::test_support`.
