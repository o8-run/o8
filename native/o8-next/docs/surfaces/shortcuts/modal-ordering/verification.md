# Modal shortcut ordering correction

The Settings Ctrl+W reproduction is fixed. The native port remains opt-in.

The red tests ran on the reviewed `ee8681e2665375d5f63b839be56860a89e53d1b0` head before changing production code. The branch was then rebased onto fetched main `27a53b527cb6b30602c1fcbf82103c030e9608f9`. Main advanced during verification to `737c988ff951cd33fb9914f1856df8a92e80ba08`; a merge-tree audit is clean and those additional commits change no native files.

## Mechanic

The registered shortcut handler ran before Settings. Closing a surface could instead remove the tab underneath and persist the removal. The module now checks modal ownership before close, selection and cycling. Settings may handle its own close key; otherwise the modal consumes the tab chord. Focused input retains its keys. Projects explicitly dismisses through its existing navigation hook before selection or cycling proceeds.

Main added a built-in `Shortcuts` command. The registered reference uses `ShortcutReference` to preserve both commands without changing the shared registry. Product changes remain in this surface plus one shell registration line. The already-reviewed PR-view test is preserved byte-for-byte from the reviewed head.

## Red and green

`src/surfaces/shortcuts/modal_tests.rs` drives real GPUI keystrokes through the fixture-backed shell. The first case opens Settings with Cmd+comma, presses Ctrl+W and compares live and saved tabs. Red: one tab becomes zero. Green: one remains one, including saved state.

`red-settings.txt` and `red-modal.txt` retain the original red tails: 0/2 new cases passing. `settings-red-test.txt` contains the first regression and its helpers without post-rebase API dependencies. To reproduce on the reviewed head, copy it to `src/surfaces/shortcuts/modal_tests.rs`, include that module from `shortcuts/tests.rs`, and run:

```sh
cargo test --locked --manifest-path native/o8-next/Cargo.toml shortcuts_settings_control_w_preserves_live_and_persisted_tabs -- --nocapture
```

The initial matrix was too strict about Projects navigation. The unchanged main Projects regression caught that assumption in an earlier candidate. `projects-red.txt` and `projects-green.txt` retain the failure and subsequent pass. The final matrix permits navigation only after Projects dismisses, while close never removes the hidden tab. It covers 25 chords across six surfaces, 150 cases, including main's built-in reference. The credential-field matrix covers 31 guarded and four permitted chords.

The older Brain focus test assumed a standalone Brain tab. Current main opens Brain in the session dock. Its updated assertion verifies actual text input, Brain focus, and both close chords retaining the session. All 11 original shortcut test functions remain; `shortcuts-green.txt` records all 13 passing, including both new regressions. The PR close/reopen and shell restart regressions passed in the full run.

The owned Grid host still uses the existing production Grid/PTY entry. A small adapter adds the production authenticated archive-list reader required by main's new sidebar. No shared fixture or application route changed. The real PTY checks retain Ctrl+K `0b`, Ctrl+W `17`, Tab `09` and BackTab `1b5b5a`.

## Completion gates and limits

Full Cargo test with `--no-fail-fast`: 225 unit passes, 7 failures, 6 ignored, plus 7 CLI and 4 frame-clock passes. That full snapshot predates the Brain test assertion alignment. The final 13-case shortcut run passes. Serial retry of the six other full-run failures passes Brain and leaves five failures in unchanged files:

- Activity requests removed `workspace-1`.
- The symlink-worker issue case requests removed `session-refresh`.
- The glass probe requests removed `workspace-1`.
- The compact-row layout case cannot find its old session-row selector.
- The fifteen-workspace chrome case rejects a nonempty notice.

The first three are tracked in #4764. Layout causes remain outside this correction; unchanged source alone is not independent baseline proof. The full native gate remains red. The earlier candidate run was stopped after its overbroad Projects guard was detected, then the complete run was restarted after the product fix.

Full npm: 1,246 files / 9,103 tests pass, 3 files / 5 tests skipped. Both 8 GiB typechecks, Cargo check, all-target Clippy, touched-file ESLint, rule-check and test classification pass. Clippy retains main's generated unused Palette warning; the surface has no diagnostics. The classification manifest is unchanged.

The two route files pass all seven assertions, but the integration runner exits 1 because process cleanup could not be confirmed. A retry after npm finished has the same result; the reported processes are absent on later recheck. This is not a green integration gate. Test files: `tests/next-surface-registration-real-path.test.ts`, `tests/o8-next-shell-real-path.test.ts`.

Both isolated compile entries pass: the surface archive probe and the repository boundary checker, including all targets. Seven shared core sources match main; shell differs by one registration line. `scope.json` records the preserved-test and file checks.

`cargo fmt --check` exits 1 on existing main formatting in diagnostics/macos_repaint.rs, src/conversation.rs, src/shell.rs module order, and src/ui.rs. No unrelated formatting changes are included. Touched-source formatting passes with module reordering disabled to retain the one-line shell boundary.

Final focused Linux debug/headless CPU measurement: 65.48 ms open-to-first-frame and 69.29 ms interaction-to-frame. No before latency was collected in this correction. These are CPU scene measurements, not macOS/GPU/compositor presentation measurements; those targets and missing desktop bindings remain unmet.

Refs #4548
