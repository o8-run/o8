# Glass probe correction round 2

This correction changes the test harness. The production material remains a
sibling below GPUI's Metal content and keeps the existing tint/fallback tokens.

## Red then green through the real example

The actual Cargo example now compiles its shared GPUI view/window code on Linux:

- cargo check reproduced E0277 for both event conversions (red-api.txt).
- Explicit PlatformInput variants reproduced the crate-private return failure
  for both dispatch calls (red-private.txt).
- Real GPUI window tests failed for the old -10000 origin and for the capture
  callback at actual x=-728 (red-placement.txt).
- The corrected example check/build and both GPUI tests pass. The adjusted-frame
  case covers -728, 0 and 128, reaches the capture callback and uses the public
  GPUI test click helper on the real Proof view.

The probe starts both owned inactive windows on a known primary-screen frame.
It accepts a finite, capturable actual frame after AppKit constrains placement;
it no longer requires x < -9000. Receipts record actualFrame. Native hit testing
and event coordinates derive from that window's actual view. Pixel counting
uses the centre text region, excluding native titlebar decorations.

The native input path creates window-local AppKit events and delivers them to
the hit-tested owned view outside the GPUI update borrow. It verifies one action
and no window activation. No private GPUI dispatch function is called.
public-api-audit.md records the pinned source visibility checks.

## What Linux verified

- Locked cargo check and build of o8-next and window-occlusion, including the
  shared GPUI example code. The material module remains macOS-gated.
- Two real GPUI test-context probe tests passed. These validate placement,
  callback progression and a public test-context click, not native pixels/input.
- Existing glass/plain shell tests: 2 passed / 1 ignored child entry; the outer
  tests explicitly exercise both child modes. Theme tests: 3 passed.
- window_occlusion_cli: zero tests on Linux because the native run is macOS-gated.
- typecheck:fast; full tsc with an 8192 MiB heap; touched ESLint; rule-check and
  formatting passed. ESLint has no Rust rules; rule-check saw no changed TS.
- npm run test:classify passed: 1238 hermetic / 911 resource-owning.
- Full npm test: 1242 files / 9074 tests passed; 3 files / 5 tests skipped.

No macOS compiler or native-rendering result is implied by those Linux checks.

## macOS reviewer run still required

With Reduce Transparency off for the initial glass case, from the repo root:

```sh
cargo build --locked --manifest-path native/o8-next/Cargo.toml --example window-occlusion
probe_target=$(cargo metadata --locked --manifest-path native/o8-next/Cargo.toml --no-deps --format-version 1 | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).target_directory')
probe_output=$(mktemp -d)
O8_NEXT_OCCLUSION_BINARY="$probe_target/debug/examples/window-occlusion" \
O8_NEXT_OCCLUSION_DIR="$probe_output" \
cargo test --locked --manifest-path native/o8-next/Cargo.toml --test window_occlusion_cli -- --ignored --nocapture
```

The integration launcher canonicalizes paths and bounds each native child to
30 seconds. It runs glass and the injected reduced-transparency policy fixture.
The native run must establish all of these:

- Cocoa/CoreGraphics and the complete macOS example compile/link.
- The primary-screen windows paint and remain inactive, even if AppKit changes
  their requested origin. The actual frame reaches capture and click checks.
- The centre text region has more than 80 contrasting text pixels over the owned
  busy backdrop; native hit testing reaches GPUI; one action click is delivered
  without reentrant AppCell borrowing or activation.
- The reduced-policy case paints solid dark (28, 28, 30), within the existing
  channel tolerance. It does not change the system accessibility preference.
- Inspect glass.png/reduced.png and their numeric receipts, and attach readable
  screenshots to the PR. Actual Reduce Transparency-on behavior should also be
  checked through the system-preference entry, beyond the injected fixture.

There are no new native screenshots or measured native pixel/click results from
Linux. Keep Refs #4711 until the remaining native acceptance is complete.
