# Commit viewer

The opt-in viewer registers in `src/surfaces/commit.rs`. Its component, request adapter, privacy guard, draft lifetime policy, Patch view and tests live inside `src/surfaces/commit/`.

The disposable host discovers its fixture entry without shared dispatcher edits. Existing authenticated production routes remain authoritative.

The shared composer, registry, Projects, client, diff parser/renderer, workspace state and development host match main. The shell inventory has one registration line for this surface. `commit/requests.rs` owns mutations and commit-patch reads through the existing authenticated transport, retaining captured HEAD/file revisions and scrubbed diagnostics.

Open resolves the requested ref once to a full commit ID. Header, comparison selection, Patch and Patch Refresh all use that same ID, even if a tag with a hex-looking name is retargeted afterward. Patch also verifies the returned commit identity.

`commit/patch.rs` adapts the existing Apache-2.0 GPUI diff UI's virtualized unified/split presentation into a read-only commit view with a frozen target. It reuses the shared parser, line model and theme. The current shared renderer has no surface-owned loader hook; this adaptation avoids changing its target enum or standalone review behavior. Privacy checks and long-line limits remain inside the commit request adapter.

`commit/lifecycle.rs` retains dirty entities across navigation and registry refreshes, including desktop unregister followed by Projects refresh. Projects keeps main's behavior. Explicit discard releases the retained draft. Window close broadcasts a private query through existing registered callbacks so independently registered editors can veto it. Recovery does not steal focus from overlays. Source editing uses the unchanged shared Composer, including selection, clipboard, undo and its scrolling viewport; the surface handles source Enter only while that editor is focused and outside IME composition.

The private guard rejects credential-bearing assignments independently of value quoting, length or punctuation before assigning source to the editor. Ordinary code references remain editable, including in committed patch lines. Canonical containment, stale Save/Commit refusals and bounded binary/large comparisons remain enforced by the existing production routes.

Tests extend `shell::test_support`. `round2.rs` covers punctuated passwords, a retargeted hex-looking ref and ordinary committed code references through the real shell. `verify-module.mjs` creates an owned canonical temporary checkout of main and compiles only this module plus its registration line; run it with the normal Rust environment and an external Cargo target directory.
