# Composer verification

Base: `417586b6b00e55f4759fc95a68091ffad7596213`. Linux Cloud, Node 22.23.4,
Rust stable 1.99.1, debug native build. No desktop account or macOS execution.
The original input behavior was tested before its implementation changed.

## Red and green

| Entry point and tests | Before | After |
| --- | --- | --- |
| `src/composer/native_tests.rs`, actual GPUI text input, keys and mouse events | 4 passed / 4 failed: word movement, double-click, undo and empty clipboard copy | All 10 native input checks pass |
| `src/composer/card_tests.rs`, existing Surface plus production HTTP fixture host | 0 passed / 2 failed: missing composer controls | All 8 card checks pass, including three production wire-mode comparisons |
| Platform input range bounds | 0 passed / 1 failed | Selected range width is reported; caret width remains 1 px |
| Single-line 1 MiB paste, selection, copy, cut/undo and paint | Command exceeded its 60-second limit, exit 124 | Test passed in 1.41 seconds |
| Hostile review: canonical repository alias, picker Escape, in-flight model save | 1 passed / 2 failed | 3 passed |
| Image added while Send is pending | 0 passed / 1 failed | Saved payload remains frozen and the later attachment remains in the draft |
| Compact / wide card with a 440-character model ID | 0 passed / 1 failed; Send overflowed | Bounded, truncated model chip keeps Send within the card |

Final composer command:

```text
cargo test --locked --manifest-path native/o8-next/Cargo.toml composer -- --nocapture --test-threads=1
test result: ok. 22 passed; 0 failed; 0 ignored
```

The count includes the four existing cases in `src/input_tests.rs`.
`src/worker_tests.rs` also passes through the production queue and a fixture
worker. Its assertions now identify the short Steer / Queue chip instead of the
removed permanent explanatory label. The original
`issues_link_follows_worker_selection` regression passes after preserving Tab's
sidebar handoff. `src/o8d_read_tests.rs` passes after building its existing
fixture binary with `--features experimental-http --bin o8d`.

The three likeliest review failures and their tests are:

1. macOS temporary directory aliases produce a canonical receipt different from
   the request spelling: `native_composer_review_canonical_receipt_accepts_temp_directory_alias`.
2. Closing a picker or moving focus loses keyboard access:
   `native_composer_review_escape_restores_chip_focus`, plus the existing issue
   worker selection test and the native drag/focus test.
3. A late server response changes another draft or consumes a newer attachment:
   `native_composer_review_inflight_model_save_cannot_change_another_draft_or_focus`
   and `native_composer_card_send_preserves_images_added_after_the_request`.

The module files include the card tests and request adapter directly. The diff
does not change `ui.rs`, `client.rs`, shell files, the surface registry or the
fixture host route table.

## Linux keystroke-to-CPU-paint measurements

Same standalone input test, 100 insertions per run and two CPU draws per
insertion. Every sample checks the editor's revision against its paint callback.

| Linux debug CPU scene | Before, ms | After, ms |
| --- | --- | --- |
| p50 | 0.537339 | 0.552561 |
| p95 | 0.641293 | 0.740900 |

Short-input latency increased slightly. These figures do not establish real font
shaping, native visual bidi behavior, GPU presentation, compositor timing or
physical keyboard latency. The later standalone run was collected after the
other verification processes finished. The 1 MiB before figure is a whole
command timeout; its after figure is the test runtime, not a latency percentile.

## Completion gates

- `npm run typecheck:fast`: passed using its supported TypeScript fallback.
- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`: passed.
- `npm run test:classify`: passed; 1238 hermetic / 910 resource-owning files,
  with no manifest change for the Rust test additions.
- ESLint on touched files: passed; Rust files are outside ESLint's language scope.
- `npm run rule-check -- --base=417586b6`: one TypeScript file, zero violations.
- Final `npm test`: 1242 files / 9057 tests passed; 3 files / 5 tests skipped.
  The first full run had one `git status` ENOBUFS failure from the large untracked
  scratch directory. A local Git exclude removed that noise, its 16-test file
  passed, then the full suite passed. No release file was changed.

A broader native sweep before the last fixes reported 139 passed / 4 failed /
3 ignored. The worker chip assertion and sidebar Tab regression were corrected
and pass their original tests. The missing saved-history fixture executable was
built with its existing HTTP feature and the test passes. The remaining Activity
palette-order assertion also fails on the untouched base; it is tracked in
[issue #4717](https://github.com/o8-run/o8/issues/4717). That broad sweep was not
repeated; the final focused checks above were rerun.

## Residual and decision

Ready for review as partial parity, using `Refs #4712`. The model chip uses a
server-validated model-ID editor rather than the complete current catalogue.
The microphone is disabled, and native recording / transcription remain absent.
The native image dialog and real macOS/font/visual-bidi behavior need platform
verification. No new screen, release, deployment or publishing file is changed.

The red tails, final composer tail and measurement receipt are retained beside
this file. They contain authored fixture data only.
