# System material correction round 1

Shell work: the window-owned native material and accessibility fallback belong to
window construction. The effect is now a sibling below the GPUI content view,
whose Metal backing layer previously lay underneath the effect subview.

Reduce Transparency is read from the system at window creation and again during
material installation. Its fallback is an opaque plain dark root. Linux compiles
without the AppKit module.

## Native regression entry

`test-support/window_occlusion.rs` was written before the layer-order correction.
It is a native executable so application startup runs on the OS main thread.
`tests/window_occlusion_cli.rs` launches it with canonical paths and a bounded
30-second deadline. It owns two inactive off-desktop windows: a busy checkerboard
backdrop and a GPUI text/action surface. The probe captures only its own window,
requires more than 80 contrasting white text pixels, verifies AppKit hit testing
reaches the content view, and dispatches a click that must invoke the action once.
The reduced-policy fixture requires a solid dark pixel within 8 channel units of
(28, 28, 30). It exports glass/reduced PNGs and numeric receipts on success.

The ordinary glass path calls the production system-preference entry; the reduced
case injects the policy through that same material adapter. It does not change
system accessibility settings or post global input.

On a macOS native runner with Reduce Transparency off for the initial glass
case, build and invoke explicitly from the repository root:

```sh
cargo build --locked --manifest-path native/o8-next/Cargo.toml --example window-occlusion
mkdir -p /tmp/o8-native-occlusion
O8_NEXT_OCCLUSION_BINARY="$(pwd -P)/native/o8-next/target/debug/examples/window-occlusion" \
O8_NEXT_OCCLUSION_DIR=/tmp/o8-native-occlusion \
cargo test --locked --manifest-path native/o8-next/Cargo.toml --test window_occlusion_cli -- --ignored
```

Set the binary path to the actual build output when CARGO_TARGET_DIR is configured.
All captures must be inspected before attaching them to the PR.

## Local receipts and limits

Locked Linux cargo check passed for the binary and example, without material.
Production shell tests: 2 passed, 1 explicitly ignored nested-mode probe; the two
outer tests invoke the glass/plain child cases. Theme tests: 3 passed. The macOS
integration target runs zero tests on Linux; that is not macOS evidence.
Typecheck:fast, full tsc with an 8192 MiB heap, touched ESLint, rule-check and test
classification passed. ESLint has no Rust configuration. Classification remains
1238 hermetic and 911 resource-owning tests. The correction batch reran full
npm test after rebasing both branches on 0eeb65889; it ran on the chrome branch: 1242 files / 9074 tests passed, 3 files / 5 tests
skipped, retained in that branch's chrome/review-1/npm-test.txt.

Hostile-review risks and coverage:
1. The effect overlays Metal text: the native probe requires real contrasting text
   pixels; it never accepts an empty capture.
2. The effect catches a click when inactive: the probe asserts native content hit
   testing, inactive state and exactly one action dispatch. Existing shell tests
   cover focus cancellation through the palette on both modes.
3. Accessibility policy differs between construction and install: production
   install rechecks the preference; the native reduced-policy case requires both
   opaque appearance and solid pixels.

Native before/after numbers are unavailable. Linux has no AppKit, so neither a
native red run nor a native green run could execute. No native pixel/contrast,
click, busy-wallpaper or Reduce Transparency screenshot is claimed. macOS
compilation and execution, both PNGs attached to the PR body, and validation with
the actual accessibility setting remain open. Keep Refs #4711.
