# Main shortcut contracts through the keymap module

The integration absorbs main `2c80b0c7674b434f20369bd145f49e1c69538f3f`
into the existing branch at `a28a9102e6d9e29149ff3fb61e84af56a43f6747`.
Main's shortcut behavior is the specification. This changes dispatch, not the
reference's modal ownership or Settings commands.

## Dispatch and merge resolution

Main's shell feature registries, retained chrome group and first-paint readiness
remain. Focused action/root bindings and palette observation register through
`src/shell_features/keymap.rs`; the shared root only composes module hooks.
The keymap module tags the root context with active reference/overlay ownership.
Tab bindings exclude owned overlays; the reference excludes underlying global
commands. GPUI resolves bound actions before raw key listeners, so a listener
alone cannot provide that isolation. Unbound modal keys reuse the registered
handler and its existing chord classification. Projects retains main's dismiss-
then-Ctrl+Tab behavior. Normal named actions still use focused contexts. Cmd+/
opens the registered reference; Cmd+, remains available from a text field and excluded from terminals.

The merge also carries main's standalone launch contract and the held-answer
Brain fixture. No new native feature is introduced. Main's shortcut test files
are unchanged.

## Assertions reconciled with main

All paths below are under `native/o8-next/src/`:

- `keymap_review_tests.rs::review_reference_command_alias` now checks the
  registered reference entity rather than the older inline flag.
- `review_reference_escape_closes` checks that entity opens and closes with
  Escape, instead of inspecting the inline flag.
- `review_reference_dismissal_restores_selected_surface_focus` becomes
  `review_reference_modal_keeps_tabs_and_restores_focus`. The prior expectation
  that the inline reference permits a Grid-click/Escape sequence is removed.
  Main's registered reference and its keyboard isolation are now the spec. The
  replacement checks tab-chord isolation, Cmd+/ and Escape focus return, then
  surface switching after dismissal and exact focus restoration on return.
  This test no longer specifies pointer behavior for the reference.
- `shell_tests.rs::keymap_reference_is_reachable_and_field_question_mark_is_text`
  looks for the registered reference and dismisses it with Escape. A second
  question mark no longer assumes the inline toggle behavior; the assertion that
  a field owns its typed question mark remains.
- `keymap_tests.rs::keymap_every_binding_dispatches_only_on_its_focus_path`
  permits the Settings action from text focus, matching main's Cmd+, contract.
  Terminal exclusion and every other action's ownership expectations remain.

No main assertion was changed or dropped. No functional test was ignored.
The extra ignored case relative to main is the branch's existing
`shell::keymap_review_tests::review_palette_release_cpu_frame_budget`, which
requires an optimized build and is intentionally separate from the debug suite.
Its prior explicit release receipt remains in `round2/`; this round does not
claim a new release timing measurement.

## Verification

The predecision local merge had five main-only shortcut failures. Their exact
tails remain in `integration-red.txt`; the original full comparison against main
`120163cc1` remains in `predecision-comparison.json`. Both contracts were then
resolved in favor of main before this fix. The earlier omitted-binding diagnostic
and shared-root listener guard remain in `red.txt`.

Fresh main at the merged commit passes its locked all-target check and full
four-shard native suite: 316 passed, 0 failed, 8 ignored. The changed branch
assertions fail against the old dispatch: 0 passed, 3 failed (`contracts-red.txt`).
The fix passes 31 focused cases, with 0 failures and the existing release-only
benchmark ignored (`contracts-green.txt`). All five formerly failing main
shortcut cases, loaded typing, both fifteen-workspace chrome cases and cache
invalidation pass. Head's locked all-target check, fast typecheck, touched lint
and the rule check pass. The final full native result is 335 passed, 0 failed,
9 ignored. Every main case and outcome is retained; the branch adds 19 passing
functional cases and its existing release-only benchmark. There are no head-only
native failures (`comparison.json`, `native-summary.txt`). The independent module
probe passes in all six merge orders with identical trees (`order.txt`).

Required local `verify:ci` is 8/9: the native gate passes, along with typecheck,
lint, classification, changed-file integration selection, bundle size, governance
and security. Hermetic units have 9,769 passes, one unchanged credential-fixture
failure creating its home data directory in this sandbox, and five skips. No app
data permission outside the workspace was requested or granted. The fixture's
source is unchanged from main. Headless scenes do not establish desktop
presentation timing.
