# Focus-aware keymap: main update

Merged main `4afce63db` (#5002, #5013, #5001) into feature head `006955448`.
Verification source: `50f12dd18`.

## Conflict resolution

- `shell.rs`: use main's capture-blocking predicate, including extension capture guards. Retain per-surface focus only after that content exists, so main's startup connection capture does not save the shell root as a surface field.
- `shell_features/palette.rs`: use main's Chrome render slot and extension/fallback renderer ownership. GPUI focused actions replace the raw-key dispatcher.
- `surfaces/palette.rs`: use main's free renderer and removed extension registration, retaining the focused palette input and action implementation. Main's layout wins.

Main's connection code now owns offline input. The focused action bridge admits its management commands while protecting hidden tabs, and the shell root carries palette/shortcut contexts when offline focus reaches it. Main's connection implementation and tests are unchanged.

## Test audit

The requested `git diff origin/main...HEAD -- '*tests*.rs' 'native/o8-next/src/**/tests.rs'` contains only:

- New `keymap_tests.rs` and `keymap_review_tests.rs` files owned by #4718.
- Appended #4718 tests in `projects_review_tests.rs` and `terminal_tests.rs`; each file retains main's entire text as an exact byte prefix.

A broader `*test*` audit has the same result. Restored the inherited `bind_root: None` edit in `shell_features/probe_test.rs`; root input binding is now a default feature hook, leaving main's probe fixture and KeyContext structure unchanged. No main assertions or inputs were changed.

Removed the branch-only `review_palette_does_not_resize_the_retained_surface` test and its diagnostic selector, because that layout assertion contradicted main's Chrome stack. The accepted ignored release benchmark remains identical to `006955448`.

## Verification

Node 22, declared npm 11.21.1, locked Cargo dependencies, debug builds with debug information/incremental compilation disabled, `nice -n 10`, four Cargo jobs. Group runs use four test threads and the debug HTTP fixture daemon.

| Group | Passed | Failed | Ignored |
| --- | ---: | ---: | ---: |
| shortcuts | 15 | 0 | 0 |
| keymap | 19 | 0 | 1 |
| palette | 26 | 0 | 1 |
| settings | 14 | 0 | 0 |
| shell | 17 | 0 | 3 |
| connection | 10 | 0 | 0 |

`cargo check --locked --all-targets` and `npm run typecheck:fast`: pass.

Initial merge validation reproduced failures in restored startup field/restart focus, offline shortcut dismissal, and offline hidden-tab closure. The three startup/dismissal cases each passed alone at `53bb223bd`; the offline hidden-tab recovery case passed alone at `50f12dd18` (each 1/0/0). The final groups repeat all affected cases at `50f12dd18`; initial logs remain alongside successful reruns. The discarded branch-only layout assertion was not a main contract.

Full native suite and local verify:ci were skipped for this update per operator scope. Hosted Linux CI remains the final validation gate.
