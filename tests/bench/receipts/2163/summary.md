# Issue 2163 — correction round 1

Browser component receipts: Chromium 154.0.8037.57, Node 22.23.4; 3 runs per revision.
Original = cdc3e6ea; PR0 = 94d9fd91; R1 = this correction. Same fixture/cadence/paint observer.
Each of 2 histories: 5,000 messages, 1,704,281 UTF-8 JSON bytes, 3,000 fences, 1,000 tables.

| Metric (samples/revision) | Original | PR0 regression | R1 |
| --- | ---: | ---: | ---: |
| Cold component switch (3) | 5109.9 / 7386.7 / 7386.7 | 3599.5 / 4390.4 / 4390.4 | 4147.1 / 4164.1 / 4164.1 |
| Warm switch (18) | 2317.6 / 3570.9 / 3570.9 | 243.3 / 350.7 / 350.7 | 277.2 / 343.4 / 343.4 |
| Scroll frame (717) | 116.7 / 216.7 / 766.7 | 50 / 83.4 / 633.4 | 50.1 / 83.3 / 400 |
| Background input (90) | 32 / 104.8 / 638.5 | 37.5 / 171 / 2063.7 | 23.4 / 32.6 / 402.7 |
| Foreground input (90) | 113.5 / 343.9 / 643.2 | 37 / 170 / 1186.2 | 38.3 / 53.1 / 94.7 |
| Task ms (3; median/max) | 83246.93 / 92190.26 | 38703.91 / 55026.79 | 33025.20 / 36877.04 |
| Layout ms (3; median/max) | 12592.69 / 14060.38 | 4891.04 / 5900.32 | 5338.27 / 5715.17 |
| Style ms (3; median/max) | 7819.16 / 9137.94 | 1535.18 / 1886.29 | 1735.87 / 1814.53 |
| End heap MiB (3; median/max) | 364.85 / 472.21 | 373.01 / 719.16 | 522.89 / 548.15 |
| Scroll long tasks (count/max ms) | 721 / 751 | 189 / 635 | 197 / 378 |
| Injected 80 ms control (3; min/max ms) | 97.6 / 119.6 | 102.8 / 104.8 | 103.6 / 116.1 |

Interaction times: p50 / p95 / maximum, ms. Heap values are end snapshots, not continuous peaks.
Cause: zero-width inactive views reconciled every 50 ms, allocating full-history JSX.
Fix: retain one presentation snapshot only while actually hidden; reveal uses latest owner data.
Visible unfocused panes still update; stream cadence, observer and thresholds were not weakened.
RED ChatMessageList.reuse.test.ts: expected 0 hidden-history reads, received 223 (1 failed, 3 passed).
GREEN focused: 5 files passed; 64 tests passed, 1 optional WebKit skip. Hidden-history reads: 0.
TypeScript, typecheck:fast, ESLint passed; rule-check: 3 production files, zero violations.
Full npm test: 1,228 files passed, 3 skipped; 8,803 tests passed, 4 skipped (one run).
Browser checks: draft/selection/scroll, copy, keyboard, full tails on reveal, 80 ms delay control.
Background p95/max 32.6/402.7 ms beats original 104.8/638.5 and PR0 171/2063.7.
Foreground p95/max 53.1/94.7 ms beats PR0 170/1186.2; absolute 16 ms target remains unmet.
Absolute switch/scroll limits and installed macOS/persisted-cold acceptance remain open.

Regenerate raw samples from this checkout with Node 22 (files stay under work/):
```sh
node scripts/bench/interactions/transcript-tab-reuse.mjs --long-history --samples=3 --source-ref=cdc3e6ea96eced47bdd5d3d04ee9a48919ba4261 --output=work/2163/original.json
node scripts/bench/interactions/transcript-tab-reuse.mjs --long-history --samples=3 --source-ref=94d9fd912b797780d7c1cbdae929f2b4870ee000 --output=work/2163/pr0.json
node scripts/bench/interactions/transcript-tab-reuse.mjs --long-history --samples=3 --baseline=work/2163/original.json --output=work/2163/r1.json
```
Add --profile-input for CPU samples of foreground/background typing.

Refs #2163
