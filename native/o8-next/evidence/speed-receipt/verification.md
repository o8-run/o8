## Mechanic

One script drives owned session histories through the current production transcript/composer components and the native production Surface, then atomically writes a single JSON receipt.

## What changed

Run from the checkout with Node 22, Rust stable and the existing native build dependencies:

```sh
node scripts/next/speed-receipt.mjs --output work/paired-speed.json
```

The script builds and discovers the GPUI test executable using compiler JSON. `--binary TEST_EXECUTABLE` reuses a previously built test executable. The existing browser resolver honors `O8_BENCH_BROWSER_PATH` on Linux and macOS. Both workloads are headless and use no accounts. Their two 80-entry fixtures come from the disposable production history routes. Content identity is compared before measurement results are accepted; only the digest and fixture ids enter the receipt.

Shell work: the existing renderer registers one test-only workload module. No interactive surface or screen is changed. The existing browser input observer gains an optional readiness signal to prevent dispatch racing listener registration. Legacy string arguments retain their behavior.

## Verification

- Test first: `tests/next-speed-receipt-real-path.test.ts`, 2 failed / 2 passed before the script existed, then 4 passed. The native process probe in those tests covers only orchestration, validation and atomic output; it is not a performance result.
- Real compiled workload: `run-linux.json` was produced by the script without `--binary`, through `ui::speed_receipt::paired_speed_receipt` and the production browser components. Before: no paired receipt. After: one receipt, two matching 80-entry sessions, 20 key / 50 scroll / 10 switch samples per UI.
- Observed medians, current / next: key-to-paint 29.800 / 6.342 ms; scroll CPU cost 4.091 / 3.154 ms; switch 46.350 / 76.240 ms. RSS 666.57 / 29.70 MiB. These are different endpoints and memory scopes, not speedup or memory-saving claims.
- Hostile review: canonical executable/output aliases cover macOS temporary-directory aliases; switching steals browser focus before real input is restored and acknowledged; mismatched or truncated native output cannot replace an earlier receipt. Listener readiness fixes a race observed through the actual compiled workload.
- Existing observer checks: `tests/composer-input-probe.test.ts` and `tests/bench-design-gesture-real-path.test.ts`, 5 passed.
- TypeScript fast check, heap-bounded `tsc --noEmit`, touched-file ESLint, rule-check and test classification pass. The full npm completion gate passed earlier in this batch: 1242 files / 9057 tests passed; 3 files / 5 tests skipped.

The current UI endpoint is the existing production-component browser fixture, not the installed full desktop. Native timing uses GPUI TestAppContext with its no-op text system; the ordinary Linux headless platform refuses app-window creation without a display. Native debug timing includes production history reads on switch. Browser key timing observes the following frame, scroll cost uses TaskDuration through two animation frames, and browser memory includes its owned process tree. The native value is the test process RSS. Neither side measures display scanout. macOS execution and optimized native measurements remain unverified in this Linux environment. The script creates no native runtime files or platform resources; installed dependencies and GPUI's existing test platform own those boundaries.


## Review round 1

The initial `run-linux.json` predates the workload corrections: native actually used a 1920 × 1080 logical viewport at scale 2, while the browser used 1200 × 816 at scale 1. Only one native session had painted before switch sampling. Its original common viewport field concealed that difference. Preserve that artifact as the earlier, mismatched run; do not use its timings for a performance comparison or compare them with measurements from another OS.

Both workloads now use a 1200 × 816 logical viewport at device scale 2. Each side records its actual dimensions and scale. Both select and acknowledge paints for session 0, then session 1, before the ten measured alternating switches. Each receipt records the actual prewarmed session order and switch starting session. A fresh owned process is used for each side; cold startup is excluded, and filesystem/OS cache state is explicitly uncontrolled without a cache reset. The browser retains mounted session components; native selection continues to read history through production routes on every switch. Those distinct policies are recorded rather than presented as an identical cache implementation.

- Real entry-point red: `review-1-native-red.txt` shows native viewport 1920 × 1080 and only the second prewarmed session against the required 1200 × 816 and both sessions. The compiled workload asserts these conditions before timing.
- Orchestration red: `tests/next-speed-receipt-real-path.test.ts`, 4 failed / 3 passed, for missing per-side setup and acceptance of viewport/partial-warmup/missing-warmup evidence. The additional scale regression was 1 failed / 7 skipped before matching the browser to GPUI's fixed scale 2.
- Green: the same script entry-point suite is 8 passed. The synthetic native executable covers validation and atomic publication only; it supplies no performance evidence. Existing observer/focus tests `composer-input-probe.test.ts` and `bench-design-gesture-real-path.test.ts`: 5 passed.
- Hostile review: canonical executable/output aliases cover macOS temporary-directory spelling; actual browser focus is restored after warmup and switches before twenty trusted keystrokes; viewport, scale, partial/missing warmup, fixture mismatch and truncated evidence preserve an earlier receipt. Native readiness acknowledges each selected session's CPU content paint before recording it as warm.

No installed app or real account is used. Timings still use different browser-frame and native CPU-scene endpoints and memory scopes. macOS execution remains unverified in this Linux environment; neither the earlier Linux figures nor the reviewer's macOS figures are a speedup baseline for this corrected workload.


The corrected `review-1-run-linux.json` was collected with the verification processes stopped, through the script without `--binary` (compiled GPUI workload and production browser components). Both fixture digests match. Current/next medians: key-to-paint 30.900 / 5.322 ms; scroll CPU cost 2.799 / 2.680 ms; switch 48.100 / 75.646 ms; RSS 685.50 / 30.03 MiB. These endpoints and memory scopes still differ; the numbers are not speedup or memory-saving ratios. Native viewport 1920 × 1080 → 1200 × 816; browser scale 1 → 2; native prewarmed sessions 1 → 2; per-side setup records 0 → 2.

Completion gates passed: `npm run typecheck:fast`, `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`, touched-file ESLint, `npm run rule-check -- --base=origin/main` and `npm run test:classify`. Full `npm test`: 1242 files passed / 3 skipped; 9074 tests passed / 5 skipped. No release, version, deploy or publishing files changed.
