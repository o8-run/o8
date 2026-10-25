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
