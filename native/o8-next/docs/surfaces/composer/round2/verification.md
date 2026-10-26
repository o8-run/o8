# Composer latency review, round 2

Keystrokes now repaint the editor while retained siblings reuse their GPUI layout,
dispatch tree and CPU scene. The session header, sidebar, transcript and composer
footer have separate boundaries. Shell chrome retains its measured height, including
wrapping workspace rows. Bounds changes or explicit owner notifications invalidate
the appropriate regions. Existing `RowState` caches retain shaped text for unchanged
rows; their width key still causes reshaping after a resize.

This is **shell work** because GPUI marks input ancestors dirty. The shared shell
must retain its chrome separately from session content to avoid rebuilding it for
each keystroke. Only the small ancestor flex containers run for placement. No new
screen or shell policy is introduced. The PR retains its `shell-work` label.

The card keeps its initial 52 px editor viewport and scrolls longer drafts inside
it. Typing, wrapping and multiline pastes therefore do not resize the conversation.
Native caret bounds verify that scrolling keeps the insertion point visible.

## Fail first

`src/composer/card_tests.rs::native_composer_loaded_typing_invalidates_only_editor`
failed against the old implementation through the production HTTP fixture, history
pagination and native GPUI input entry point:

```text
typing must reuse the transcript scene, without laying out or painting its rows
test result: FAILED. 0 passed; 1 failed
```

A further regression exposed draft growth changing the conversation geometry:

```text
native_composer_loaded_wrapping_keeps_transcript_geometry
growing a draft must scroll inside the composer, without resizing the conversation
before: composer card height 92 px
after typing: composer card height 216 px
```

Both now pass. The loaded shell benchmark also observes the real Shell and Surface
entities and checks sibling render counters after every keystroke. A notification
outside the composer, or a transcript/chrome rebuild, fails the check.

## Hostile review

The three most likely failures and their tests in `src/composer/card_tests.rs`:

1. Different viewport/font metrics on macOS leave stale row shapes after resize:
   `native_composer_loaded_resize_reshapes_rows_then_resumes_isolation` checks a
   visible row reshapes at the new width, then resumes scene reuse on input.
2. Refocusing an editor after a pending session switch revives an old scene:
   `native_composer_loaded_focus_and_pending_switch_keep_current_scene` sends a
   late notification from the old draft while the real history request is pending,
   then blurs/refocuses the selected editor and verifies its text and retained rows.
3. A wrapping/pasted draft changes conversation bounds or hides its insertion point:
   `native_composer_loaded_wrapping_keeps_transcript_geometry` checks stable bounds,
   no sibling renders and visible native caret bounds after twenty pasted lines.

All fixture paths use the existing canonical temporary roots. No real accounts,
operator desktop or external provider are involved.

## Focused-keymap composition

The actual peer revision remains `a7f9dfc2f167216f93f1fa4288985056b2f4e793`.
The executable port in `../round1/check_composition.py` retains its Global/session
actions, palette editor and modal ownership while installing these scene boundaries.

The new loaded-shell check initially failed in that composition: every sibling
render counter advanced from 13 to 14 on the first keystroke. The peer caches the
entire Surface, and GPUI forces nested cache refreshes when that outer cache misses
for a dirty descendant. The port gives Session its own element hook without that
outer cache; other surfaces retain their original caching. The adapter and canonical
word operations from round 1 remain in place.

```text
composed composer: 32 passed; 0 failed
composed keymap: 16 passed; 0 failed; 1 ignored
keymap focus matrix: 6496 dispatch cases
```

The ignored keymap case is its opt-in performance measurement.

## Measurement protocol

`scripts/next/surfaces/70-composer.surface.ts --composer-loaded` seeds 200 fixed
messages, with styled prose and inline code. Both benchmarks load all 200 through
the production history client and pagination before focusing the editor. Each
dispatches 100 individual `a` keystrokes at a 1200 × 816 viewport. GPUI test support
flushes the first CPU scene before the input update returns; there is no additional
draw or `Window::refresh` inside the measured interval. Editor revisions must reach
paint, and scene/notification assertions run after timing each sample.

These are **Linux headless CPU-scene** measurements using the GPUI test text system,
without GPU presentation. The full-shell case uses the existing packaged shell's
`open_window`, session registration and fixture entry points. The session-only case
uses the existing `Surface::new` test entry.

Final isolated results, milliseconds, 100 inputs per row:

| Linux CPU scene | Before p50 | Before p95 | After p50 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Loaded session, debug | 3.478851 | 3.816322 | 1.047677 | 1.205091 |
| Loaded shell, debug | 4.115266 | 4.180614 | 1.324879 | 1.407502 |
| Loaded session, release | 0.295609 | 0.379474 | 0.064856 | 0.089573 |
| Loaded shell, release | 0.387566 | 0.435247 | 0.088541 | 0.122602 |

The Linux debug and release runs meet the <2 ms target at both reported quantiles.
Raw measurement lines are retained in `measurements.txt`.

The comparison script creates an owned canonical temporary worktree at the old
implementation and overlays only the fixture, benchmark and test-only probe. It
does not copy the retained regions or editor fix into that checkout. Its old-head
probe omits only scene counters that did not exist then. It forces the app crate
to rebuild for each side, preserving dependency caches, so a shared Cargo target
cannot run the other checkout's stale executable. The baseline is the reviewed
round 1 head, `8b1b41169bcce8d04527d4b3192dfca65486305c`.

Run both profiles, including the before/after comparison:

```sh
git fetch origin 8b1b41169bcce8d04527d4b3192dfca65486305c
python3 native/o8-next/docs/surfaces/composer/round2/compare_typing.py \
  --before 8b1b41169bcce8d04527d4b3192dfca65486305c
```

Run the shipped tests directly:

```sh
cargo test --locked --manifest-path native/o8-next/Cargo.toml \
  --bin o8-next native_composer_loaded -- --nocapture --test-threads=1
cargo test --release --locked --manifest-path native/o8-next/Cargo.toml \
  --bin o8-next native_composer_loaded -- --nocapture --test-threads=1
python3 native/o8-next/docs/surfaces/composer/round1/check_composition.py \
  --peer-ref a7f9dfc2f167216f93f1fa4288985056b2f4e793 --test composer
python3 native/o8-next/docs/surfaces/composer/round1/check_composition.py \
  --peer-ref a7f9dfc2f167216f93f1fa4288985056b2f4e793 --test keymap
```

The reviewer measured macOS debug loaded-session p50 at 48.84 ms, or 51.08 ms with
the focused keymap, and standalone editor p50 at 0.797 ms. No new macOS numbers are
available from this Linux environment. The macOS <2 ms target remains unverified;
Linux results do not establish it. The earlier microphone, full model catalogue,
native dialog and visual bidi residuals remain, so the PR continues to use `Refs`.

## Completion checks

- Rebased onto `origin/main` at `3484fb0187910952c852972032dbf5c2343fdf6a`.
- Branch composer tests: 31 passed, including clipboard paste and native caret bounds.
- Transcript tests: 2 passed, 1 opt-in measurement ignored.
- Broader shell tests: 135 passed. The earlier Activity command-order failure
  reproduced on the old baseline and is fixed by upstream #4735 on the rebased main.
- `npm run typecheck:fast` and
  `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`: passed with Node 22.
- `npm run test:classify`: 1239 hermetic / 923 resource-owning files; no manifest diff.
- Touched-file ESLint and `npm run rule-check -- --base=origin/main`: passed,
  one TypeScript fixture scanned with zero violations. Rust/Python have no ESLint rules.
- Full `npm test`: 9084 passed / 5 skipped; 1243 passing / 3 skipped files.
- Touched Rust formatting, Python syntax and `git diff --check`: passed.
