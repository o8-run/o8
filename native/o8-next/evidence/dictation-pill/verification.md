# WIP verification

Part of #6130. Implementation is held after the two-attempt test stop rule.

- macOS cargo check: passed. Final receipt:
  Finished dev profile [optimized + debuginfo] target(s) in 4m 48s.
- Linux fast type checking: passed.
- Linux focused tests: 23 passed across three files. The route controller test
  covers recording, transcribing, polishing, success, error and the retained
  edit/revert control. Its first expanded version used the wrong STT event for
  transcribing; corrected to the existing final -> transcribing,
  audio_file -> polishing sequence before the passing run.
- First macOS targeted test build failed: a GPUI wildcard import shadowed the
  built-in test attribute and recursively expanded it. Replaced with explicit imports.
- Second macOS targeted run compiled, then passed five tests and failed one:

    Finished test profile [optimized + debuginfo] target(s) in 7m 09s
    native_pill::tests::dictation_event_reaches_pill_model_through_real_parent_pipe ... ok
    native_pill::tests::pill_feed_lease_and_idle_retire_drawing ... ok
    native_pill::tests::pill_pipe_fixture ... ok
    native_pill::tests::pill_placement_follows_primary_changes_and_notch_without_scaling ... ok
    native_pill::tests::pill_states_and_idle_visibility ... ok
    native_pill::tests::pill_states_draw_offscreen_without_input ... FAILED
    cannot update o8_next::native_pill::Pill while it is already being updated
    test result: FAILED. 5 passed; 1 failed; 1426 filtered out

The drawing test compiled the earlier body, which drew the root from inside
that root entity's update. The source now moves drawing outside that update.
This correction has NOT been rerun: the two-attempt stop rule applies.

Raster captures, full local CI verification, hosted checks, and macOS focus/
display acceptance remain outstanding. No visible desktop window, installed
app launch, simulated input, toolkit edit, release or merge was performed.
