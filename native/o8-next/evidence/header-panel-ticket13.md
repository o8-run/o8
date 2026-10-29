# Header and right panel verification, Ticket 13

Original local head: `71a4acf6953915288902de36d23eefea1622c0b7`.
Pinned main control: `3966e7312`, the original head's parent. This work adds
commits without rebasing, squashing, pushing or opening a pull request.

## Classification of the original 35 failures

Every named failure ran as an exact invocation on pinned main in a disposable
home-directory worktree, using the same Cargo target as the header branch.
The ignored `glass_shell_probe` child also ran explicitly; it is additional to
the 35 top-level failures. Fixture invocations had at most four owners; the two
fixed-rate PTY probes ran alone. The main worktree was removed after the control.

Using the brief's main-pass criterion: **32 introduced/main-pass, 3
pre-existing/environmental**. On an unchanged-header rerun, **20** of the 32
still failed and **12** passed with the configured fixture environment. Those
12 required no assertion changes. The unchanged-header top-level control was
13 passed and 22 failed. The ignored glass child passed on main and failed on
the original header code.

| Original test | Main | Original header rerun | Classification |
|---|---|---|---|
| `diff_tests::diff_real_server_selection_modes_review_and_virtualized_paint` | P | P | Main-pass |
| `pane_grid::tests::terminals::real_slot_terminals_route_keys_retain_hidden_attachments_and_restart` | P | P | Main-pass |
| `shell::activity::tests::activity_empty_local_auth_and_scoped_retention` | P | F | Main-pass |
| `shell::fake::parity_tests::parity_capture_real_shell` | P | F | Main-pass |
| `shell::inbox::tests1::inbox_cards_counts_statuses_and_approval_match_desktop_routes` | P | F | Main-pass |
| `shell::inbox::tests1::inbox_empty_and_server_error_never_claim_a_false_clean_state` | P | F | Main-pass |
| `shell::inbox::tests1::inbox_keyboard_buttons_activate_enter_space_and_skip_disabled` | P | F | Main-pass |
| `shell::inbox::tests1::inbox_opens_related_session_and_pull_request_and_restores` | P | F | Main-pass |
| `shell::inbox::tests1::inbox_plan_session_header_preserves_desktop_authority_and_continuation` | P | F | Main-pass |
| `shell::inbox::tests::inbox_is_reachable_from_the_real_shell_palette` | P | F | Main-pass |
| `shell::palette::target::tests::target_choices_compare_canonical_workspace_paths` | P | P | Main-pass |
| `shell::palette::tests::palette_keyboard_opens_all_surfaces_and_switches_workspaces` | P | P | Main-pass |
| `shell::palette::tests::round1_focused_pty_receives_ctrl_k` | P | P | Main-pass |
| `shell::projects::tests::projects_preserve_session_focus_and_allow_inbox_navigation` | P | F | Main-pass |
| `shell::pull_requests::registration_tests::pull_requests_single_registration_owns_the_request_adapter` | P | F | Main-pass |
| `shell::settings::tests1::settings_fixture_all_default_controls_persist_and_refresh` | P | P | Main-pass |
| `shell::settings::tests1::settings_fixture_toml_save_reload_conflict_and_cancel` | P | P | Main-pass |
| `shell::settings::tests1::settings_fixture_validation_locks_loading_errors_and_empty` | P | P | Main-pass |
| `shell::shortcuts::tests::review::correction_2::shortcuts_control_k_reaches_the_focused_grid_pty` | P | P | Main-pass |
| `shell::shortcuts::tests::review::correction_2::shortcuts_settings_chords_do_not_steal_pty_focus` | P | P | Main-pass |
| `shell::shortcuts::tests::review::shortcuts_focused_grid_terminal_keeps_question_and_close_keys` | P | P | Main-pass |
| `shell::tests::chrome_switcher_cancel_restores_composer_with_platform_shortcut` | P | F | Main-pass |
| `shell::tests::correction_fifteenth_workspace_scrolls_into_view` | P | F | Main-pass |
| `shell::tests::glass_and_plain_open_through_the_production_shell` | P | F | Main-pass |
| `shell::tests::look::chrome_switcher_cancel_restores_composer_with_platform_shortcut` | P | F | Main-pass |
| `shell::tests::look::correction_fifteenth_workspace_scrolls_into_view` | P | F | Main-pass |
| `shell::tests::look::correction_placement_uses_the_single_shell_header` | P | F | Main-pass |
| `shell::tests::look::correction_rebase_keeps_header_without_secondary_labels` | P | F | Main-pass |
| `shell::tests::look::shell_chrome_fifteen_workspaces_keeps_one_switcher` | P | F | Main-pass |
| `shell::tests::shell_chrome_fifteen_workspaces_keeps_one_switcher` | P | F | Main-pass |
| `shell::tests::shell_palette_switch_restart_and_server_down` | P | F | Main-pass |
| `shell::workers::review_tests::workers_restart_outcome_unknown_retry_keeps_one_steer` | F | F | Pre-existing/environmental |
| `ui::o8d_read_tests::saved_history_surface_with_only_o8d` | F | F | Pre-existing/environmental |
| `terminal::tests::production_pty_flood_waits_for_delayed_tail` | P | P | Main-pass |
| `terminal::tests::production_pty_to_gpui_terminal` | F | P | Pre-existing/environmental |

The three baseline/environmental results were:

- `shell::workers::review_tests::workers_restart_outcome_unknown_retry_keeps_one_steer`:
  null response status instead of 409, also reproduced on the original header.
- `ui::o8d_read_tests::saved_history_surface_with_only_o8d`: the control daemon
  lacked its `experimental-http` feature, so no HTTP readiness receipt existed.
  The original supplied run had no daemon binary. Subsequent verification builds
  the HTTP daemon with that feature and passes its explicit binary path.
- `terminal::tests::production_pty_to_gpui_terminal`: the main control reached
  45,070,000 of 50,000,012 bytes before its unchanged 90-second bound. It passed
  in the unchanged-header rerun. No terminal budget or assertion was relaxed.

## Updated tests and new coverage

Nineteen existing top-level tests now use the intended destinations. The ignored
appearance child follows the same header change. Workspace tests click header
Search and filter to the workspace commands, retaining selection, scrolling,
compact/wide layout, draft, restart and offline checks. The fifteen-workspace
check asserts exactly fifteen commands, all workspace entries; this avoids
mistaking a stale removed debug selector for a live command.

Inbox tests inspect the current workspace's panel-owned content, require no
Inbox tab in the main strip, retain the active main tab across decisions, and
exercise both persisted restoration and the empty global Inbox. Closing the
empty Inbox uses the panel shortcut and checks its saved open state before and
after reopening. Decision inputs, durable status/audit checks, disabled-button
checks, keyboard activation and viewport assertions remain intact. The Projects
test still requires Inbox navigation to leave its overlay. The existing
registration-removal compile test is unchanged.

Four test names change to describe the new UI, in both `shell_tests.rs` and
`shell_look_tests.rs`:

- `shell_chrome_fifteen_workspaces_keeps_one_switcher` becomes
  `shell_chrome_fifteen_workspaces_use_one_palette`.
- `chrome_switcher_cancel_restores_composer_with_platform_shortcut` becomes
  `chrome_workspace_palette_cancel_restores_composer_with_platform_shortcut`.

`src/shell_header_tests.rs` adds seven tests through the real shell and owned
fixture server:

- `header_back_forward_follow_visits_and_disable_at_the_ends`
- `header_sidebar_toggle_stays_at_desktop_x_open_and_hidden`
- `header_cmd_w_and_close_mark_keep_the_neighbour_active`
- `header_right_panel_toggle_shortcut_launcher_and_inbox`
- `header_inbox_panel_restores_without_becoming_a_main_tab`
- `header_saved_inbox_tab_migrates_to_the_panel`
- `header_workspace_tools_show_fixture_branch_path_changes_and_pull_request`

`src/theme_tests.rs` gives the existing TS-constant parsing assertions their own
`workspace_glass_veil_stops_match_the_desktop_constant` test. All offsets and
RGBA stops remain checked against `src/lib/theme/glass-material.ts`.
The original glass override parity test remains. This is eight additional tests.

The Workspace tools fixture serves `/api/review/workspace`, checks workspace
selection, distinguishes fast changes-only reads, supplies two changed files
(+17/-4), and offers an unrelated PR before the matching branch's PR #73. The
shell test checks painted text bounds for branch, path, counts and the matching
PR, and copies the actual path through the card control. These are headless GPUI
layout/CPU-scene checks, not compositor or raster captures.

## Product corrections exposed by the tests

- Workspace tools resolves Pull Requests through its registration, preserving
  the optional-surface boundary. On original header code the unchanged compile
  test failed with E0599 after removing that single registration; on main it
  passed. The fixed focused run also passes, including proving that removing the
  registration removes both request adapter methods.
- Inbox commands perform the existing overlay teardown hooks while keeping the
  active main tab. Inbox panel visibility is persisted in Inbox's own workspace
  slice; legacy Inbox tabs migrate into that slice and reopen as panel content.
  Closing the panel clears the saved flag. False values are omitted, retaining
  the existing default workspace JSON shape.
- The panel body excludes the outer column's one-pixel divider from its width.
  The original compact Inbox viewport assertion is retained and passes after this
  correction. The tools card gains diagnostic selectors for its rendered values.

Cmd+W already passed on unchanged product code, so its implementation is retained.
Rustfmt also adjusts existing wrapping in `motion.rs` and `startup_tests.rs`.

The two Inbox panel-state tests were added to the original product code and
ran with the production tick after initial readiness. They check the current
content owner and readiness rather than relying on stale removed selectors.

Red tail on original product code:

```text
assertion `left == right` failed: one loaded Inbox owned by the current workspace panel
  left: []
 right: [true]
test shell::tests::header::header_saved_inbox_tab_migrates_to_the_panel ... FAILED
test shell::tests::header::header_inbox_panel_restores_without_becoming_a_main_tab ... FAILED
test result: FAILED. 0 passed; 2 failed; 0 ignored
```

Green tail on the fixed source:

```text
test shell::tests::header::header_saved_inbox_tab_migrates_to_the_panel ... ok
test shell::tests::header::header_inbox_panel_restores_without_becoming_a_main_tab ... ok
test result: ok. 30 passed; 0 failed; 0 ignored
```

Earlier fixture-setup attempts stopped before these assertions and are not
regression evidence. The final controls use the workspace from session inventory
and the normal shell lifecycle after initial paint.

## Completed checks

Focused checks: **30 passed, 0 failed, 0 ignored**, covering all 20 reproduced
failures, seven new shell tests, two theme parity tests and the unchanged default
workspace JSON-shape test.
`npm run typecheck:fast` passed. The hermetic `npm test` completed with
**9,897 passed, 0 failed, 5 skipped**. No Vitest test references `glass-material`
or `WORKSPACE_GLASS_VEIL`; the native parity tests parse that desktop constant.

An initial broad run found that serializing the false panel flag added a field
to default workspace JSON. That run was stopped, the false value was omitted,
and the unchanged JSON-shape assertion passed in the expanded focused run.
The final complete native run starts from that corrected source.

ESLint on the desktop glass material and the new fixture passed. The repository
rule check against the pinned main commit and `cargo fmt --check` passed.

## Final complete native run

The prior engine session ended during the regular harness, so recovery preserved
that partial log and repeated the complete native run on the unchanged final
source. The final run discovered and retained all **370 cases**, with no missing
results: **361 passed, 1 failed, 8 ignored** across all harnesses. The application
harness alone was **349 passed, 1 failed, 8 ignored**, directly comparable with
the brief's original 307/35/8. The five other harnesses contributed 12 passes.

The sole failure was the established baseline failure
`shell::workers::review_tests::workers_restart_outcome_unknown_retry_keeps_one_steer`,
with the same null-versus-409 assertion as pinned main and the unchanged header
control. No worker code or assertion changed. Both fixed-rate terminal probes
passed in isolated invocations (33.00s and 31.55s), and the daemon history test
passed with the HTTP-enabled daemon. Their existing budgets were retained.

All **32 introduced/main-pass cases** now pass, including the four renamed
workspace tests. All seven new shell tests and the dedicated veil parity test
pass. The eight ignored cases remain ignored under the existing harness rules;
the appearance probe is exercised by its passing parent test.

Raw control, focused, desktop and full-suite receipts remain in
`~/scratch/hdr-ticket13-receipts`. The final native inventory and results are
`suite-inventory.json`, `suite-results.json`, and `suite-counts.json`; the worker
failure makes `full-native.exit` equal 1. This is a completed run with a known
baseline failure, not an interrupted or clean run.

Decision: commit on the existing local branch and hold. No push, pull request,
rebase, squash, version change or release was performed. No requested work is
outstanding; the worker failure remains outside this ticket's introduced scope.
