# Final image-only Send review

An empty draft returned before constructing the queue request, even with images.
The default composer already sends `[Image attached]` for this case. The native
composer now uses that same text and the existing frozen payload, routing, POST
and confirmed-receipt path. Server validation still requires nonempty text.

## Real-path regression

`src/composer/card_tests.rs::native_composer_review_image_only_send_persists_through_real_route`
opens the native Surface against the existing HTTP fixture. It sends the same
valid PNG with text, without text, and with whitespace. The first two activate
the actual Send button; the third uses Return. A fresh queue GET checks three
unique durable identities, exact images, text, wire directives, thread and status.
Confirmed sends clear their draft and images. Empty Return without images remains
a no-op.

The exact test was copied into an owned checkout at reviewed head
`6811d3f442e6348b46758871e6be0b13aa48b63f` without production changes. Image plus
text persisted; image-only left one item instead of two. See [red tails](red.txt)
and [green tails](green.txt).

## Rebase and shell work

Rebased onto `origin/main` at `d1bab39d70d649fb2b793c9d17e00475cff6f700` first,
then onto its newer tip `c14b23bd75121e792ddf5f1654ef5e2f96fedfb2` before the
gates. The second rebase changed no native source or dependency files. A final
rebase onto `cc29c1fc9318c47cf4044ec4cd05682e7b8b2293` retained the newly merged
parity harness and its tests. The Refresh conflict keeps the shared command and
the upstream wait for completion.
Kept the workspace thread sidebar, glass backdrop, embedded session layout,
typography/geometry tokens, right Brain panel, worker registration and native
dependency-table fixes. Kept the card, word operations, UTF-16 handling and scene
boundaries. No tests were removed.

The new rail originally painted on each composer keystroke. The loaded-shell test
now observes its existing paint probe alongside Shell/Surface notifications and
region counters. It failed before giving the rail its own retained scene, then
passed. This is shell work because the rail is supplied by the shell decorator.
Its own notifications still invalidate it; search, selection and refresh tests
remain enabled. Successful connection clears the permanent shortcut hint again.

Empty-state placement keeps the centered card and right panel. No queue means no
empty queue gap. Footer groups wrap beside Brain; natural height is measured and
retained between owner changes, so typing still reuses the footer scene. The
placement test now also checks Send stays inside the card beside the panel.

Tests using removed permanent workspace buttons or an embedded session header now
use the actual workspace switcher and shared Refresh command. Original assertions
remain. The diagnostic's changes are formatting-only, required by full cargo fmt.

The newer main also requires the managed credential's account owner. The Issues
and Pull Requests transport fixtures now name their intended synthetic owners.
The Issues transport answers comments with an empty list: its old missing-route
404 triggered the new anonymous-read fallback and hid later detail reads. Only
fixture responses changed; production authorization remains intact. Both failing
real native tests passed after adapting these responses.
The second workspace now also has its saved remote staged as a Git origin; main
refreshes registry remotes from Git, so fixture metadata must match the repository.
The existing repository-switch test failed before this staging and passed after it.

## Hostile review

The three likeliest failures and their retained real-path tests in `card_tests.rs`:

1. macOS temporary directory aliases reject a valid receipt:
   `native_composer_review_canonical_receipt_accepts_temp_directory_alias` compares
   canonical directory identity through the real queue path.
2. Send or a late completion misplaces focus:
   `native_composer_review_send_button_returns_focus_to_editor` exercises pointer
   and keyboard Send; `native_composer_review_inflight_model_save_cannot_change_another_draft_or_focus`
   switches sessions during a pending save.
3. A receipt clears an image added after the request snapshot:
   `native_composer_card_send_preserves_images_added_after_the_request` injects a
   second image while saving and checks persisted and retained images separately.

Round-2 resize, pending-switch, paste and notification guards remain. The new rail
guard is in `src/composer/loaded_shell_tests.rs`; merged placement/no-hint tests
remain in `src/surface_tests.rs` and `src/shell_look_tests.rs`.

## Measurements

Independent macOS review supplied at `6811d3f44`, release, first CPU scene,
200-message fixture and 100 inputs; milliseconds:

| macOS release endpoint | Before p50 / p95 | Reviewed head p50 / p95 |
| --- | ---: | ---: |
| Loaded session | 1.97 / 22.72 | 0.376 / 0.569 |
| Loaded shell | 2.87 / 23.77 | 0.516 / 0.663 |

That review confirmed zero Shell/session notifications while typing. These are
supplied Mac measurements at the reviewed head; this environment runs Linux.
Current Linux checks appear in `green.txt`.

Final Linux headless CPU-scene checks after the last rebase, milliseconds:

| Linux endpoint | Debug p50 / p95 | Release p50 / p95 |
| --- | ---: | ---: |
| Loaded session | 1.060396 / 1.199533 | 0.070264 / 0.088983 |
| Loaded shell | 1.783871 / 2.021916 | 0.134831 / 0.162832 |

Linux debug shell p95 is 2.021916 ms against the <2 ms target. The release
quantiles and supplied independent Mac release quantiles meet that target.
Notification and scene-reuse assertions pass in both Linux profiles. These
headless measurements exclude GPU presentation.

```sh
cargo test --locked --manifest-path native/o8-next/Cargo.toml --bin o8-next \
  native_composer_loaded -- --nocapture --test-threads=1
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml --bin o8-next \
  native_composer_loaded -- --nocapture --test-threads=1
```

The round-2 comparison harness omits the new rail observer on the old head because
that rail did not exist. The keymap composition script explicitly replays reviewed
`6811d3f44` against its historical peer, rather than claiming to port the new
workspace sidebar onto that older shell schema.

## Commands

Use Node 22 for the HTTP fixture. Build the saved-history sidecar with its required
HTTP feature. Fixture paths retain canonical comparisons, including `/var` versus
`/private/var` on macOS. Linux libraries use the existing packaged file names.

```sh
cargo build --locked --manifest-path crates/o8d/Cargo.toml --features experimental-http
cargo fmt --manifest-path native/o8-next/Cargo.toml --check
cargo check --manifest-path native/o8-next/Cargo.toml
cargo test --manifest-path native/o8-next/Cargo.toml -- --test-threads=2
npm run typecheck:fast
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit
npm run test:classify
git diff --name-only -z origin/main -- | xargs -0 npx eslint
npm run rule-check -- --base=origin/main
npm test
```

Do not rebuild the same native test executable concurrently with the full suite:
the glass probe reexecutes that binary. No tests were disabled for integration.
An earlier full run had a worker promotion timeout; its immediate isolated rerun
passed without a source change. The final full-run result is recorded in green.txt.
Final checks on `cc29c1fc9`: 248 native unit tests and 11 CLI tests passed, with
6 existing opt-in cases ignored. Full npm test passed 9160 tests, with 5 skipped
(1251 passing and 3 skipped files). Format, cargo check, both typechecks,
classification (1247 hermetic / 933 resource-owning), touched-file ESLint and
rule-check (3 files, zero violations) passed. Classification has no manifest diff.
The full model catalogue, microphone recording/transcription, native image-dialog
and visual bidi checks remain original parity residuals, so the PR uses Refs #4712.
