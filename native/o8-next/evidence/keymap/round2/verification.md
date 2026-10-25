# Focus-aware keymap, review round 2

Rebased onto `origin/main` at `a0b4f4f1084d291db00fbc1d4631240d1faeaf56`.
Resolved shell, shell-view, fixture and shell-test conflicts with the incoming
shell palette. Both PTY commands and both command-entry assertions remain.
No tests were deleted. No dependency, release, version, deployment, publishing
or packaging files changed.

## Mechanic and fail-first receipts

`review_reference_dismissal_restores_selected_surface_focus` opens the production
hidden shell with its existing HTTP fixture, opens Grid, returns to the first
surface, then sends exactly Cmd+/, clicks the Grid tab, sends Escape and sends
Cmd+1. Before the fix the active surface remained Grid; afterward it is the
first session. Dismissal now uses `restore_focus` for the selected surface instead
of restoring an unqualified handle saved before the reference opened. The
existing per-surface focus map preserves same-surface return focus.

The incoming palette owns rendering, workspace entries and command execution.
Its shortcuts now use the action extension and shared keymap; the filter uses
the existing Composer input. Cmd/Ctrl+Shift+P remains the explicit global command
chord, including focused fields and terminals. Cmd/Ctrl+K remains focus scoped.
The incoming setup busy guard intercepts actions before palette navigation.
The incoming target picker declares a context, handles actions and uses the
same native text-input contract. Its asynchronous restore-race test remains,
calling the production action handler before the response can attach a child.

`red.txt` contains the exact-sequence failure and the integration failures before
their corresponding fixes: six palette tests, the busy-setup navigation test,
and the new raw-listener guard. The broad run also caught the explicit global
chord being excluded from Settings by its modal context. Its existing lifecycle
test failed first and passed after restricting the exclusion to the reference. `green.txt` records the passing tails. The seven
round-1 regressions remain in the complete native run.

## Coverage and counts

The focus matrix now fires 803 test rows (802 production rows and one fixture
probe), with text-field, terminal, list and absent focus, each isolated and in
the complete map: 6,424 dispatch cases, up from 6,352. Reference equality and
canonical binding uniqueness still pass. The explicit global palette chord and
picker reopen chord have their intended input-context exceptions.

Raw event attachment is counted with
`git grep -l -E '\.(on|capture)_key_down[[:space:]]*\(' origin/main -- native/o8-next/src`
and the equivalent working-tree search. Current main has 14 matching files;
this branch has one, `keymap.rs`. Surface files outside that shared map: 14 to 0.
The new source guard prevents another surface attaching a listener. The two
central adapters remain the terminal text protocol and optional registered
unbound-event fallback.

Hostile review checked three likely failures and retained their tests:

1. A detached reference returns an off-screen handle: the exact click/keyboard
   sequence above now passes.
2. The incoming global palette chord is swallowed by a terminal binding, or
   Cmd/Ctrl+K steals field/PTY input: the focus matrix includes standalone and
   hosted terminal paths, and the incoming real-field and PTY tests pass.
3. Modal setup navigation bypasses its guard after switching to actions: the
   incoming busy lifecycle test failed first, then passed with action dispatch.

## Release measurement

Command (from the repository root, with the native toolchain configured):

```sh
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml review_palette_release_cpu_frame_budget -- --ignored --nocapture --test-threads=1
```

This uses the release profile, checks that debug assertions are disabled, sends
Cmd+K to the hidden production shell, flushes effects, draws its first CPU scene
and checks that the painted revision acknowledges the action. It paints both
open and close before the next sample. Ten warmups precede 80 measured samples.
The final release rebuild completed in 31.47 seconds with cached dependencies.
The measurement invocation completed in 1.20 seconds.
Run the measurement without competing test/build workloads. This endpoint does
not include GPU or compositor presentation and does not establish macOS timing.

Release result: median **0.584599 ms**, p95 **0.700932 ms**, median dispatch
**0.400896 ms**, median paint **0.181860 ms**. The median assertion below 2 ms
passes. The earlier controlled Linux before/after medians were 0.785147 /
0.561564 ms (p95 0.862171 / 0.724868 ms). This round's 0.584599 ms result includes
the incoming palette integration. The review's 6.44 ms median / 36.50 ms p95 and
1.5 ms baseline remain separate desktop observations.

## Completion checks

The final broad native run reported **180 passed, one worker-fixture failure,
four ignored**, and one filtered case. The worker queue-promotion test timed out
with an HTTP 400 response. It passed in the preceding broad run and then passed
alone on the final source in 57.00 seconds. This intermittent failure remains
unresolved; the broad native run is not claimed green. `residuals.txt` retains the
failure and isolated passing summary. All keymap, palette, setup and earlier
regression tests passed in the final broad run; all seven CLI checks also passed.
Passing tails are in `green.txt`.
The only filtered case is the previously tracked Activity-order assertion
(#4717): it still expects Diff immediately after Activity, while current main
lists Pull requests there. A separate run reproduced the same known failure.
The four ignored cases are explicit measurements; this release measurement
passes when run explicitly.

Full `npm test`: 9,084 passed, five skipped; 1,243 passing files and three skipped
files, 276.26 seconds. TypeScript (`NODE_OPTIONS=--max-old-space-size=8192 npx tsc
--noEmit`), fast typecheck, classification (including dated fixture audits),
touched-file ESLint, rule-check, Rust formatting and all-target Clippy passed.
ESLint has no applicable Rust/Python rules; rule-check scans zero eligible
TypeScript files. The actual reference-surface registry composition build and
the shell-work boundary check pass. Clippy completed with warnings.

External checks still unavailable here: macOS desktop timing, GPU/compositor
presentation and real accounts. Publishing is the authorized same-branch update;
no merge is performed.
