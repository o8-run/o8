# System glass verification

Shell work: window construction, the native material and the window-wide veil
belong to the shared shell. No new surface is ported. The macOS source and its
three exact dependencies are selected by Cargo's target configuration; they are
not manually copied into Linux fixtures. All dependency versions were already in
the locked graph; only direct edges changed. The macOS license audit passed for
453 packages, with no GPL or excluded application crates.

red.txt records the first production-shell probe: a glass request had background
alpha 1 instead of 0. green.txt runs the existing restart/offline test and an
isolated glass/plain probe (two parent tests passed). The ignored probe is invoked
explicitly in two child test processes, so global appearance selection cannot
leak between tests. green-theme.txt records all three theme tests passing; the
new contract compares the native values directly with the desktop overrides and
three-stop veil source.

| Requested glass token | Before | After |
| --- | ---: | ---: |
| In-flow background alpha | 1 | 0 |
| Panel alpha | 0.82 | 0 |
| Elevated alpha | 1 | 0.05 |
| Window veil stops | 0 | 3 |

The three hostile-review risks are unavailable native handles, material/focus
changes and teardown during pending reads. The production hidden-window entry
uses an opaque root without requesting AppKit handles. Each mode deactivates the
window, opens/cancels the palette with the platform shortcut, resizes/reopens and
closes another window before pending reads finish. The glass probe then emulates
only native-install success to paint the actual two-piece veil and click through
to a workspace, checking that the tint does not intercept input.

The macOS adapter installs FullScreenUI with BehindWindow blending and Active
state once at window creation. Parent-view ownership handles release; width and
height autoresizing follow the content view. Non-macOS, offscreen and unavailable
native handles use the plain dark root. The veil uses two contiguous gradients
because pinned GPUI supports two stops per gradient. It preserves the desktop's
55 percent middle stop and does not emulate system blur.

glass.json and plain.json are headless production-shell receipts. They are not
raster screenshots. The pinned test backend discards scenes and does not provide
native font shaping. Remaining: actual macOS compilation/AppKit execution,
wallpaper/compositor captures in glass/plain, and the separate type/placement
acceptance from #4711. These limitations keep the issue open.

Node 22.23.4, Rust stable 1.99.1. Locked cargo check and touched native tests,
typecheck:fast, NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit and
rule-check passed. Rule-check has zero applicable TypeScript files; ESLint was
invoked on every touched Rust file and reports no matching Rust configuration.
test:classify passed (1238 hermetic, 910 resource-owning); no manifest drift.
The full npm test receipt is deferred to the end of the three-item batch.
