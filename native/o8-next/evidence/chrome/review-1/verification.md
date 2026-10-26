# Chrome correction round 1

Shell work: manual refresh dispatch, palette scrolling and retained session Brain
routing cross the existing shell/session bridge. No screen is added.

Written before the fixes, the three production-shell regressions all failed
(`red.txt`). The palette is driven with real keyboard/click events and the server
fixture uses the registered production history route after its one-shot 503.
A later focus test also failed before the explicit New message focus correction
(`red-new-message.txt`).

- `shell_tests.rs`: initial history failure followed by palette Refresh;
  workspace 15 bounds and click at 1200 × 816 and 900 × 700; Cmd+E draft followed
  by palette Brain and New message.
- `brain_tests.rs`: retained dock error/cancel/minimize/restore and workspace
  isolation through the palette.
- `surface_tests.rs` and `worker_tests.rs`: existing session/composer/worker seam.
- `tests/o8-next-shell-real-path.test.ts`,
  `tests/composer-next-worker-real-path.test.ts`,
  `tests/next-render-parity.test.ts`: 3 files, 15 tests passed.

Before: 0/3 correction regressions passed. After: 3/3 passed; the complete shell
subset passed 7 with one explicitly ignored native capture probe. Brain passed
3/3, session/worker 4/4, theme 2/2. Workspace 15 originally occupied y=544.5–577.5
outside the visible palette y=49–349 at 1200 × 816. After scrolling, the row occupies y=316–349 at both sizes, fully inside
the palette y=49–349. Green shell output retains the bounds. Palette Brain originally selected a standalone
Brain tab; it now retains the selected session and appends to the same Brain draft.

Hostile-review risks:
1. Inventory reload racing a manual history recovery: initial 503 recovery and
   existing refresh-during-workspace-change tests drive the real command.
2. Keyboard selection below a compact macOS window: bounds and actual row click
   are asserted at both sizes, including the fifteenth workspace.
3. Palette/focus changes directing a draft into the wrong composer: retained
   Brain append, explicit New message, and workspace restore are exercised.

Typecheck:fast, full tsc with an 8192 MiB heap, touched ESLint and repository
rule-check passed. ESLint has no Rust configuration. Classification passed with
1238 hermetic and 911 resource-owning tests. After rebase on 0eeb65889, full npm test passed
1242 files and 9074 tests (3 files and 5 tests skipped); `npm-test.txt` retains its
summary.

## Remaining visual evidence

No screenshot is claimed or attached. `correction_native_screenshots` launches the
real CLI against owned fixtures on an isolated virtual display. Both default and
narrow captures stayed black (257–285 bytes); the explicitly invoked probe failed
rather than accepting them (`capture-failure.txt`). The pinned GPUI test backend
cannot rasterize screenshots. Actual rendered default/narrow PNGs and macOS visual
acceptance remain required. Keep Refs #4707 until that evidence exists.
