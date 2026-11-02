# Lead picker Linux regression

Reviewed head: `ce420ae81ddc88722cc2a039cd781ef957ce9017`.
Stack base remains `ui/next-chat-panel` at `393d4797d`.

## Cause

The disposable composer host wrote one saved assistant reply. Its session list
returned `messageCount: 1`, and its mobile history returned that reply. A temporary
native diagnostic at the picker decision observed `rows=1`, `saved_messages=1`,
and `fresh=true`. The subsequent production history POST returned HTTP 404 because
the fixture did not register `POST /api/v2/chat-history`. The defaults POST had
already succeeded, but the failed history write correctly prevented selection
from changing. This run does not support the proposed explanation that the
original fixture had no retained rows at click time.

The fixture now registers the production history writer for owned composer
records and newly generated `thoughts-next-<digits>` records in its disposable
repository. Successful new records join its read-admission inventory, so the
normal session selection can load them. No production route or auth code changes.

The picker also uses the server's saved message count, alongside live retained
rows, to decide whether another runtime needs a fresh conversation. A missing
presentation cache cannot make saved history empty; a live reply can still be
recognized before the next session-list refresh. Empty threads keep their id.
A choice on the same runtime still uses the existing model-only path.

## Red on the reviewed head

The original test and application sources were unchanged for this control:

```text
test ui::conversation::card_tests::native_composer_lead_picker_moves_a_thread_with_history_to_a_fresh_conversation ...
panicked at src/composer/card_tests.rs:245:5:
thoughts-composer-first
test result: FAILED. 0 passed; 1 failed; 0 ignored
```

The temporary diagnostic was then added only to identify the decision and failed
request. It is removed from the committed code.

## Separate saved-history control

With the fixture route repaired but the old picker decision, the new
`native_composer_lead_picker_uses_saved_history_without_retained_rows` test failed:

```text
saved messages must start a fresh conversation even without retained rows
test result: FAILED. 0 passed; 1 failed; 0 ignored
```

This test verifies saved messages and the server's count, discards retained rows,
then clicks through the actual model picker and verifies the original saved
messages and runtime remain unchanged. It does not add a delay or await more paint
to determine whether a thread has history.

## Green

```text
test ui::conversation::card_tests::native_composer_lead_picker_moves_a_thread_with_history_to_a_fresh_conversation ... ok
test ui::conversation::card_tests::native_composer_lead_picker_uses_saved_history_without_retained_rows ... ok
test ui::conversation::card_tests::native_composer_lead_picker_switches_an_empty_thread_in_place ... ok
test ui::conversation::card_tests::native_composer_lead_picker_same_runtime_only_changes_the_model ... ok
test result: ok. 4 passed; 0 failed; 0 ignored
```

The empty-thread test provisions an empty record through the production writer,
checks both its zero saved count and empty retained rows, then verifies the click
changes its saved backend/model without adding a session. The same-runtime case
checks the selected id and effective model while preserving the entire saved
history record.

The original PR test is included from `composer/lead_picker_tests.rs` so its full
test identity stays unchanged and `card_tests.rs` stays under the file-size limit.
Existing assertions and inputs are preserved. Rustfmt also normalizes pre-existing
formatting in `shell_rail.rs`, `shell_view.rs`, `startup_tests.rs`,
`surface_tests.rs`, and `visualization_tests.rs`; those edits only change layout
and an optional trailing comma, preserving assertions and inputs.

## Completion checks

Focused lead-picker cases: 4 passed, 0 failed.
`card_tests`: 35 passed, 0 failed. `thread_list`: 24 passed, 0 failed.
`cargo fmt --all -- --check` and the included test file's rustfmt check: passed.
Fast TypeScript check, changed-file rule check, and changed-file ESLint: passed.
`cargo check --locked --all-targets --manifest-path native/o8-next/Cargo.toml`
with four build jobs: passed.

The required local `npm run verify:ci` was attempted. Lint, security audit, test
classification, changed-file integration checks, server bundle size, type checks
and governance smoke passed. The first native job exhausted its 20-minute CI
budget after a cold build and 61 passing native cases, with no recorded native
test failure. The remaining verifier work was stopped after that timeout; the
native and hermetic matrices are incomplete, and the verifier exited 130. This
is not a passing full-native or full-hermetic receipt. The independently completed
card and thread-list groups above are the requested focused results. Hosted CI
remains the final gate.
