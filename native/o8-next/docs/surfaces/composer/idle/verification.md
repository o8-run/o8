# Composer idle residency

The 14 by 20 pixel microphone used a stroked GPU path. On Linux this activated
the renderer's viewport-sized path intermediate and MSAA targets, keeping about
24 MiB resident even while the composer was empty. The microphone now uses four
bounded quads in the existing quad pass. Its slot, disabled state and theme color
remain the same. Retained transcript, footer and shell scenes remain in place.

Production changes stay in `src/composer/card.rs`. The five-line GPUI test helper
counts paths in the completed CPU scene, including replayed retained scenes; it
is compiled only with test support. This test instrumentation accompanies the
existing shell work needed for isolated composer paints.

## Fail first

The reviewed release executable was built at
`2fe766898749020298481e6d5f7f720c7fa67acb`. All three warm measurements failed a
main-plus-5 MiB budget through the existing `linux-headless.mjs --check` entry.
The new `src/composer/card_tests.rs::native_composer_idle_card_avoids_viewport_path_targets`
also failed through the real Surface and HTTP fixture: one vector path, expected
zero. Both checks pass after the icon change. See [red](red.txt) and
[green](green.txt) tails.

## Paired Linux renderer measurements

Before, main and after use the same Node 22 fixture host, fonts, private Xvfb
1440 by 1024 display and software Vulkan stack. Executables are copied before
rebuilding another checkout. The harness performs one informational cold launch
and three fresh warm launches, sampling each idle process five times. These are
Linux Cloud measurements; absolute values differ from the review's CI host.

Main/rebase: `fbe95283d61468118b450b75e167b6b76f10fee3`.

| Linux release executable | Warm idle RSS, MiB | Warm launch-to-frame, ms |
| --- | --- | --- |
| Reviewed head | 125.04 / 124.67 / 124.77 | 984.23 / 985.09 / 918.41 |
| Main | 101.11 / 100.87 / 100.16 | 919.45 / 897.78 / 895.67 |
| Fixed | 101.49 / 100.93 / 101.90 | 912.19 / 901.44 / 932.79 |

Maximum idle RSS falls from 125.04 to 101.90 MiB, 0.79 MiB above main's maximum.
Each paired run is within 1.74 MiB of main. Warm launch median falls from
984.23 to 912.19 ms; main is 897.78 ms. The committed 150 MiB budget is unchanged.
The tighter local comparison budget is 106.11 MiB. Raw receipts are in
[measurements.json](measurements.json).

The independent CI review measured 156.41 / 156.11 / 155.69 MiB before
([run 40258021260, attempt 2](https://github.com/o8-run/o8/actions/runs/40258021260/attempts/2)),
versus main's 133.63 / 133.27 / 134.16 MiB
([run 40254845587](https://github.com/o8-run/o8/actions/runs/40254845587)).
Those supplied CI numbers are separate from this paired Linux Cloud run.

## Release session latency

The unchanged fixed 200-message session benchmark dispatches 100 keystrokes
through the native input entry point, acknowledges the first CPU scene and
asserts transcript/region reuse. It runs with GPUI's headless test text system;
GPU presentation and network send delivery are excluded. Both immutable release
test executables were run consecutively after the other verification jobs ended.

| Linux release session | Before | Fixed |
| --- | ---: | ---: |
| p50, ms | 0.068862 | 0.071026 |
| p95, ms | 0.092968 | 0.088031 |

The p95 speed win is preserved. The independent review's supplied release
session p95 of 0.344 ms, down from 22.72 ms, is a separate measurement.

```sh
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml \
  --bin o8-next native_composer_loaded_typing_benchmark \
  -- --nocapture --test-threads=1
```

## Reproduction

Build each checkout with `cargo build --release --locked --manifest-path
native/o8-next/Cargo.toml` and preserve its executable before building the next
one. Use separate Cargo targets, or clean both the app and locally patched GPUI
packages when sharing a target, so another checkout cannot replace a library
behind a cached fingerprint. Dependency caches can remain.

With the prerequisites in `.github/actions/next-linux-setup/action.yml`:

```sh
xvfb-run -a -s '-screen 0 1440x1024x24 -nolisten tcp -noreset -br' \
  node scripts/next/linux-headless.mjs --binary EXECUTABLE --output RECEIPTS
node scripts/next/linux-headless.mjs --check RECEIPTS/measurements.json \
  --budget native/o8-next/linux-budgets.json
```

Use the same renderer environment and current fixture host for every executable.
Set a copy of the budget's `idleRssMiB` to the measured main maximum plus 5 and
its `baseline` to those main warm runs for the stricter comparison check. No
shipping or release file needs editing.

## Hostile review

1. A scaled or resized icon reactivates the large target: the new scene test
   checks two viewport sizes using the headless platform's 2x scale.
2. Blur or retained-scene replay revives the old path: the same test checks the
   completed scene after deactivation, including cached primitives. The existing
   pointer/keyboard Send focus test remains enabled.
3. A late async update regresses input isolation or draft ownership: the loaded
   focus/pending-switch and late-image receipt tests remain enabled in the same
   composer test module. The loaded release benchmark observes scene reuse.

Rebased onto current main before implementation, retaining its shortcuts and
event-driven tests. The separate parity capture issue #4786 is outside this fix.

Full native verification passed 265 unit and 11 CLI tests, with 6 existing
opt-in cases ignored. Format, cargo check, both typechecks, classification,
touched-file ESLint and rule-check passed. Full npm test passed 9165 tests with
5 skipped (1251 passing and 3 skipped files). No test was removed or disabled.
