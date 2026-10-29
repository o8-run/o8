# Retained image cache and Grid loading, fix round 1

Main merged at `5ebb22eebf3f0b51f13314e7169397a1f963f836` without conflicts. Implementation validated at `755aefdda5ac9268020efb81fb55a4e95cbdf1a3`.
This is a debug Linux GPUI CPU scene receipt, with Node 22.23.3, npm 11.21.1,
nice 10, Cargo -j 4, debug information disabled and incremental compilation off.
No release build or quiet-window requirement was used.

## Mechanic

The old Surface cache outlived its rows, and Grid panes never populated the image
cache consumed by the shared retained renderer. Cache entries now follow a
24-path working set per transcript or Grid pane, selected near the scroll anchor.
Loading and failed entries count toward the same bound. Session switches and an
empty session inventory clear the cache immediately; installing streamed or
replaced rows prunes it. Eviction also invalidates cached row layouts, which can
hold decoded image Arcs. A load identity prevents late requests from restoring
an evicted entry or overwriting its replacement.

Grid installs the same cache in its RowStates and calls the existing shared
background media loader on history installation, stream changes and scrolling.
Network reads and decoding remain off the UI thread. Scrolling to evicted images
loads them again. The existing media route, image-delivery contract and auth code
are unchanged by this round.

## Red and green

Both review regressions failed on `b3a192493` with only the new tests added
(test-only commit `0c6ebec76`): **0 passed, 2 failed, 0 ignored**.

- `grid_image_history_decodes_user_and_assistant_images`: actual saved history,
  production session/history/media routes and a GPUI Grid window. The red tail
  was `Grid must paint decoded image dimensions, not Loading placeholders`,
  with `1870px x 18px` instead of `80px x 48px`.
- `transcript_image_cache_prunes_session_switch_and_stream_trim`: the red tail
  was `session switch must discard decoded images immediately`. Green also
  checks a production stream merge that trims 201 new text entries to 200,
  leaving no referenced image paths or cache entries.

Both now pass. Together with
`transcript_image_cache_bounds_working_set_and_reloads_after_scroll`, the focused
regression run is **3/0/0** passed/failed/ignored. The additional test
loads 32 distinct allowed image path spellings through the media route, checks
the 24-entry bound, scrolls away and back to verify decoded paint, and drops rows
while requests are in flight to check that stale results cannot resurrect them.

## Verification

Counts below are passed/failed/ignored, with the original ignore identities and
all existing assertion, timeout, input and timing bounds retained.

| Check | Result |
| --- | --- |
| cargo check --locked --all-targets | pass |
| npm run typecheck:fast | pass |
| Rule check against main | pass, one TS fixture, zero violations |
| Image group | 7/0/0 |
| Transcript group | 5/0/1 |
| Grid group | 9/0/2 |
| Full native suite, once, --test-threads=4 | 329/6/8 |

The full native run includes the integration binaries and uses the debug-built
HTTP fixture daemon. Main was run for isolated comparisons, not a second full
native sweep.

Every failing test was rerun alone on head and selected individually on main.
The PR-owned image benchmark is absent on main, as noted below:

| Test | Isolated head | Isolated main |
| --- | --- | --- |
| `shell::activity::identity_tests::activity_identity_matrix_linked_worktrees` | 1/0/0 | 1/0/0 |
| `diff_tests::diff_real_server_selection_modes_review_and_virtualized_paint` | 1/0/0 | 1/0/0 |
| `shell::session::image_loaded_shell_tests::native_composer_loaded_shell_images_typing_benchmark` | 0/1/0 | 0/0/0 (test absent on main) |
| `shell::sidebar::tests::sidebar_worker_archive_real_path` | 0/1/0 | 0/1/0 |
| `terminal::tests::production_pty_flood_waits_for_delayed_tail` | 1/0/0 | 1/0/0 |
| `terminal::tests::production_pty_to_gpui_terminal` | 1/0/0 | 0/1/0 |

The image typing benchmark was introduced by this PR, so its exact name collects
zero tests on main. Main's existing unmodified composer typing benchmark was also
run alone: **1/0/0**. That workload has no
images and is reported as a counterpart, not equivalent image timing evidence.
The image benchmark's 16.667 ms p95 assertion is unchanged. The passing focused
image group measured 14.020862 ms p95; the loaded full sweep measured 51.577085 ms.
These shared-host samples are not a controlled performance comparison.

Additional image timing control used the merged pre-fix revision `bed7a7a92`
and the same unchanged image workload. Both the control and the head retry passed.
The first isolated head failure remains in the table above; this retry does not
turn the full sweep into a passing run.

| Workload | p50 ms | p95 ms |
| --- | ---: | ---: |
| Head image group | 10.208434 | 14.020862 |
| Head full sweep | 22.801843 | 51.577085 |
| Head first isolated run | 10.295983 | 19.659779 |
| Merged pre-fix image control | 8.742301 | 13.255914 |
| Head image retry | 7.145967 | 10.584746 |
| Main text-only counterpart | 9.964465 | 15.438057 |

For the five existing failures whose exact tests exist on main, isolated head
was **4 passed / 1 failed** and isolated main was **3 passed / 2 failed**. Archive
failed on both with the missing-workspace notice. Activity and diff passed alone
on both. The delayed-tail PTY test passed alone on both; the 50 MB PTY test passed
alone on head but exceeded its original time bound on main. These are individual
comparisons, not a claim that the full suite is clean.

The extra npm hermetic unit gate could not collect tests: its first attempt
failed to create an experimental-cache temporary file; creating that missing
cache directory exposed a Vitest startup `TypeError: code.charCodeAt is not a
function`. The startup failure was compared on main. No source, configuration or
assertion workaround was applied. An additional local verify:ci sweep was not
run on top of the requested single full native sweep. Hosted CI is the final gate.

## Test and boundary audit

The final `git diff origin/main...HEAD -- '*tests*.rs'
'native/o8-next/src/**/tests.rs'` contains only the three new PR-owned files:

- `src/image_history_tests.rs`
- `src/image_cache_tests.rs`
- `src/composer/image_loaded_shell_tests.rs`

The branch's inherited edits to `src/composer/loaded_shell_tests.rs` were reverted
exactly to main. The image-specific benchmark moved to its own file with its
existing workload and assertions. No main test assertions or inputs were changed.

Shared native core files changed, including retained rendering, UI and Grid
lifecycle code. The PR carries `shell-work` for that boundary.
