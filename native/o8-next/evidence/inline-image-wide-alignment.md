# Wide transcript image alignment

Base: `3f66bc8c60e053dc416e92d5884e5f6164e8be92`.

## Baseline distinction

That reviewed image branch does not contain `COLUMN`, a width clamp, or centered
text/backdrop painting. The same is true of main `d316df7be` at verification time.
The centering prerequisite is in the unmerged chat-panel change `d46845b7d`.
Consequently, the new bounds test already passes on the reviewed image head:
image and text both start at x=286, inside a backdrop spanning x=278 to x=1652.
This is not presented as a failing control on the unmodified reviewed head.

To reproduce the reported interaction, a disposable control replays only the
column-width clamp and centered paint origin from `d46845b7d` onto the reviewed
image code. It does not merge the other chat-panel behavior. Those prerequisite
changes are removed from the final PR patch.

## Real transcript test

`ui::image_cache_tests::transcript_image_wide_user_picture_stays_inside_bubble_and_aligns_with_text`
opens saved history from the existing disposable image fixture using `Surface`.
The normal loader decodes the actual image through the production media route.
The test resizes to 1680 by 1050, renders the transcript, and reads
`transcript-image-user-image-0` debug bounds. Test-only observations capture the
actual positions passed to backdrop and text painting; these are not predicted
positions from an isolated layout helper.

It requires the decoded 80 by 48 image to lie within its painted user backdrop
and share the painted text's left edge. Existing test assertions and inputs are
unchanged.

## Red with the centering prerequisite

The row is 1406 px wide and the reading column is 768 px, leaving a 319 px
centering offset. Text starts at x=605 while the image remains at x=286.

```text
wide transcript image must stay inside its user bubble: image=Bounds { origin: Point { x: 286px, y: 105.5px }, size: Size { 80px × 48px } }, bubble=Bounds { origin: Point { x: 597px, y: 82px }, size: Size { 736px × 83.5px } }
test result: FAILED. 0 passed; 1 failed; 0 ignored
```

## Green with the image fix

The same test, fixture and temporary centering prerequisite pass after image
prepaint applies the centered origin. Image and text both start at x=605 inside
the backdrop at x=597 to x=1333.

```text
test ui::image_cache_tests::transcript_image_wide_user_picture_stays_inside_bubble_and_aligns_with_text ... ok
test result: ok. 1 passed; 0 failed; 0 ignored
```

The permanent change applies that offset to image children and gives pictures
10 px rounded corners. It does not bring the separate column-layout feature into
this PR or change image delivery, authentication or routes.

## Checks

- Image group: 8 passed, 0 failed.
- Composer group: 40 passed, 0 failed.
- `npm run typecheck:fast`: passed.
- `cargo check --locked --all-targets --manifest-path native/o8-next/Cargo.toml`
  with four build jobs: passed.

The complete native inventory recorded **334 passed, 2 failed, 8 ignored** across
332 unit cases and 12 CLI cases. The local verifier recorded 48 completed cases
before its native job deadline; only the remaining 296 identities were then run,
using four test threads and the existing isolated timed-terminal lane. No cases
remain unaccounted for, and this was not a second full-suite run. The new wide
image case passed. The known `sidebar_worker_archive_real_path` case also passed.

The original full-run failures remain failures in those counts:

- `shell::session::image_loaded_shell_tests::native_composer_loaded_shell_images_typing_benchmark`:
  p95 24.716589 ms exceeded the unchanged 16.667 ms CPU scene budget during the
  parallel verifier. Its immediate isolated rerun passed at p50 5.103031 ms,
  p95 6.028752 ms. It also passed in the focused image group.
- `shell::pull_requests::registration_tests::pull_requests_single_registration_owns_the_request_adapter`:
  the nested compile encountered concurrent Rust toolchain replacement. Its
  isolated rerun failed with E0514: dependencies built by Rust 1.99.0 were being
  read by Rust 1.99.1. Repeating that compile control with the original reviewed
  head's source reproduced the same incompatible-artifact failure. That control
  uses the unchanged registration-test harness to copy and compile the original
  application source; it is not a full baseline-suite run. No toolchain repair or
  unrelated product/test changes are included.

`npm run verify:ci` was attempted but **did not complete**: its first native job
exhausted the 20-minute local deadline amid cold compilation and concurrent work.
The broader verifier was stopped before another native shard started, and the
missing native cases were completed as described above. Lint, security audit,
test classification, changed-file integration tests, bundle size, type checks and
governance smoke passed. The hermetic matrix is incomplete. Hosted CI remains the
final gate; this receipt does not claim a green local verifier.
