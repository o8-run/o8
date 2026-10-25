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
