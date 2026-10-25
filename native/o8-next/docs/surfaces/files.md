# Files viewer

The opt-in viewer registers in `src/surfaces/files.rs`. Its component, request adapter, privacy guard, draft lifetime policy and tests live inside `src/surfaces/files/`.

The disposable host discovers its fixture entry without shared dispatcher edits. Existing authenticated production routes remain authoritative.

The shared composer, registry, Projects, client, diff renderer, workspace state and development host match main. The shell inventory has one registration line for this surface. `files/requests.rs` owns Save through the existing authenticated transport. Conflict decoding reads at most 16 KiB; larger responses use the bounded file-content endpoint to recover the current raw-byte revision. Both Reload and Keep mine remain available without decoding the complete external file. A successful overwrite also skips the potentially large `oldContent` receipt and confirms the saved content and revision through that bounded endpoint.

`files/lifecycle.rs` retains dirty entities across navigation and registry refreshes, including desktop unregister followed by Projects refresh. Projects keeps main's behavior. Explicit discard releases the retained draft. Window close broadcasts a private query through existing registered callbacks so independently registered editors can veto it. Recovery does not steal focus from overlays. Source editing uses the unchanged shared Composer, including selection, clipboard, undo and its scrolling viewport; the surface handles source Enter only while that editor is focused and outside IME composition.

The private guard rejects credential-bearing assignments independently of value quoting, length or punctuation before assigning source to the editor. Ordinary code references remain editable. Binary and truncated reads, revision-guarded saves and canonical workspace containment remain enforced by the existing production routes.

Tests extend `shell::test_support`. `round2.rs` covers punctuated passwords, 32 MiB external conflicts and ordinary code references through the real shell. `verify-module.mjs` creates an owned canonical temporary checkout of main and compiles only this module plus its registration line; run it with the normal Rust environment and an external Cargo target directory.
