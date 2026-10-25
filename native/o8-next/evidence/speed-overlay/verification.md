## Mechanic

The opt-in app shell exposes Experimental speed as one compact overlay. It starts off on every launch and never persists the opt-in. Metric values have no helper text.

## What changed

The speed module owns the control, bounded samples, sampling and rendering. Shell work: two generic registration hooks observe the existing reconciliation tick and insert a final paint probe; the session embedding API exposes its existing composer entity so input is acknowledged only after a changed revision paints. No surface is ported.

Key timing ends at changed-composer CPU scene paint. Frame timing covers rebuilt shell frames through the final CPU paint probe. Reused probes publish once. Idle wakeups count existing shell reconciliation callbacks after one second without keyboard input, not OS interrupts. Memory is process RSS in MiB, sampled off the UI thread at most once per second. None of these values measure display presentation.

## Verification

- Test first: `red.txt` retains the real shell failure, 0 passed / 2 failed, missing Experimental speed. `green.txt` retains 5 passed / 0 failed. The panel changes from absent to one 248 × 96 px panel; default opt-in stays false; retained input/frame samples cap at 64.
- Tests: `src/surfaces/speed/tests.rs`, plus the existing `src/shell_tests.rs` palette/switch/restart/server-down test (1 passed).
- Hostile review: macOS Command palette focus is checked alongside Control; losing focus before paint discards input timing; rapid disable/re-enable rejects an in-flight memory result from the old generation. Reopening uses a canonical state-file path and starts off.
- `npm run typecheck:fast`, `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`, touched-file ESLint, rule-check and test classification pass. ESLint and the TypeScript rule checker have no applicable Rust source rules.
- `npm test`: 1242 files passed, 3 skipped; 9057 tests passed, 5 skipped. A broad native sweep was stopped to avoid concurrent fixture contention; the focused overlay and existing shell regression checks passed serially.

Linux uses the existing GPUI test window and disposable production route host. macOS display appearance, GPU presentation, OS-wide idle wakeups and a physical keyboard remain unmeasured. The side-by-side receipt and preference mirroring are separate items of #4713.


## Review round 1

- Regression first: `review-1-red.txt` retains 4 passed / 2 failed: the old 248 × 96 panel cannot fit the two-row contract, and the real shell sampler invokes a trapped `ps` executable. `review-1-green.txt` retains 6 passed / 0 failed, with the manual CPU receipt ignored in the normal suite.
- The panel is now 176 × 56 px, with four numbers and units in a fixed two-by-two layout. Key-to-CPU-paint and rebuilt-frame-to-CPU-paint occupy the first row; shell callbacks per second and resident MiB occupy the second. No secondary labels or helper text are rendered.
- Sampling remains off by default, absent while the panel is hidden, throttled to at most once per second, off the UI thread and guarded by the opt-in generation. Current-process CPU and RSS come from `/proc/self/statm` plus the process CPU clock on Linux, and `proc_pid_rusage(RUSAGE_INFO_V2)` on macOS. No sampler child process is started.
- `review-1-idle-cpu-linux.json` retains four alternating, settled 10-second spans before and after, using the actual shell's 50 Hz callback cadence. Mean off/on CPU: before 2.42% / 3.54% (+1.12 percentage points); after 2.75% / 3.69% (+0.93 points). The delta decreased by 0.19 points in this Linux debug test process plus reaped helpers. The live fixture server is excluded; this is a noisy fixture measurement, not the reviewer's macOS desktop measurement or a claim that the panel has zero idle cost.
- Hostile review: the canonical-path isolated executable test traps any sampler helper on Linux/macOS; the actual window asserts the four cells form two rows, with existing Command/Control focus tests retained; the generation test covers rapid opt-in changes, immediate repeated ticks and sampling after the panel closes.

Paint timings stop at CPU scene paint. They do not include GPU work or display presentation. Wakeups count existing shell reconciliation callbacks while input-idle, not operating-system wakeups. The macOS idle CPU delta and physical display behavior remain unverified in this Linux environment.


Round-1 completion gates: `npm run typecheck:fast`, heap-bounded `npx tsc --noEmit`, touched-file ESLint, `npm run rule-check -- --base=origin/main` (zero applicable TypeScript files), and `npm run test:classify` passed. `shell::tests::shell_palette_switch_restart_and_server_down`: 1 passed. Full `npm test`: 1242 files passed / 3 skipped; 9074 tests passed / 5 skipped. No release, version or publishing configuration changed; the native dependency declaration only makes the already-locked system API bindings a direct dependency.


## Review round 2

Sampling formerly called the shell entity's `notify`, rebuilding the window's registered content. The readout now owns an independent cached view and publishes only when its four formatted strings change. Sampler completion, callback-rate updates and keystroke observation do not notify the shell; the explicit user toggle still does. A readout paint cannot become a new timing sample and perpetuate another readout update.

Shell work: the single generic `Content::element` line now uses GPUI's cached-view boundary so a readout update reuses unchanged registered content. The speed module's final paint probe is absolute: adding or skipping it cannot change content height by one pixel and defeat that cache. No new screen or unrelated cleanup is included.

- First failure, `src/surfaces/speed/tests.rs`: `sampling must never invalidate the shell`, observed 1 vs required 0; 0 passed / 1 failed. `review-2-red.txt` retains the parent failure. Green: 8 passed / 0 failed / 1 ignored; the ignored receipt was executed separately.
- Three completed sampler callbacks while open yield zero shell, session or composer notifications; an unchanged composer paint sentinel survives window drawing, proving scene reuse. Genuine platform keystrokes still change and paint the composer revision and produce an acknowledged key timing.
- Formatted values 3.0001 → 3.0002 ms notify neither entity; 3.0002 → 3.01 ms notifies the readout once and the shell zero times. A subsequent sampler tick does not publish feedback from that readout frame.
- Hostile review: existing Command/Control palette focus tests and canonical temp paths remain; genuine input after a cached sample repaints; opt-in generation guards reject stale memory and readout paint completion. Existing palette tests: 7 passed; session routing: 1 passed; palette/switch/restart/server-down: 1 passed.
- Required checks passed: fast typecheck, heap-bounded `npx tsc --noEmit`, touched-file ESLint, rule-check (zero applicable TypeScript files) and test classification. Full `npm test`: 1243 files passed / 3 skipped; 9084 tests passed / 5 skipped.

Paint timings remain CPU scene paint, excluding GPU/compositor/display presentation. Wakeups count input-idle shell callbacks, not OS wakeups. macOS real-window idle CPU remains unmeasured in this Linux environment.


The final rebased notification-driven idle receipt, `review-2-idle-cpu-linux.json`, contains four prespecified 30-second spans in closed/open/open/closed order, after three seconds of settling per span, with all other verification processes stopped. Totals: closed 60.033 seconds / 1.062% CPU; open 60.038 seconds / 1.463% CPU; overhead **+0.401 percentage points**, below 0.5 in this Linux fixture. All four spans recorded zero shell notifications. The initial run before the last main rebase is also retained in `review-2-idle-cpu-linux-initial.json`: closed 1.088%, open 1.475%, overhead +0.387 points, with at least 60 seconds per state. Both receipts identify their base commit.

The driver watches shell/session/composer/readout notifications and draws only if the window has not already painted, without forced refreshes or a sampling helper process. CPU is from in-process self plus reaped-child `getrusage`; the live owned fixture server is excluded. Native test text and CPU scenes exclude GPU/compositor work. All raw spans are retained; no cross-platform reduction claim is made against the reviewer's macOS 5.86% / 10.87% (+5.01-point) measurement. The real macOS target remains unverified.
