# Final local verification

Main base: `a0b4f4f1084d291db00fbc1d4631240d1faeaf56`.

The displayed-chord finding and compile conflict are addressed. The native completion gate remains red beyond the known #4717 failure: standalone diff readiness (#4728) and paced PTY byte accounting (#4752) both fail serial retry. This receipt does not claim a green native suite.

## Displayed chords

The test was written first in `src/surfaces/shortcuts/binding_tests.rs`. It expands the exact rendered `ROWS` into all 16 chords, dispatches GPUI keystrokes through the real shell in the non-editing context, checks the named action, and reads persisted tab state. Escape is checked in the reference and palette. Every tab-selection assertion starts from a different index, including Cmd+1.

Negative control: change only the displayed palette chord from Cmd+K to Cmd+L, leaving handlers unchanged:

```text
displayed "⌘ L" (cmd-l) has no live Command palette binding in its focus context
test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 167 filtered out; finished in 23.67s
```

Restore the correct displayed chord:

```text
running 1 test
test shell::shortcuts::tests::bindings::shortcuts_every_displayed_chord_has_a_live_binding ... All 16 displayed chords dispatch live actions in their advertised focus contexts.
ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 178 filtered out; finished in 27.31s
```

All ten earlier shortcut test functions remain. The final complete native run passes all **11 shortcut tests**.

## Focus and fixture integration

Main's #4702 palette keeps Cmd/Ctrl+K with focused controls and uses Cmd/Ctrl+Shift+P globally. The field matrix now checks 29 protected chords and six permitted global chords. Existing PTY tests still verify `0b`, `17`, `09`, and `1b5b5a` received by the real owned peer.

The macOS PTY fixture now creates its host beneath a canonical temporary root. This prevents the inventory's `/var` spelling from differing from the native selected workspace. Its process guard owns startup failures and preserves diagnostics. Field tests use batches of four within the host's two-minute lifetime.

The PR-view integration test first proves a focused note editor retains Ctrl+W, then moves focus to the shell and proves the tab actually closes before reopening with the same view and unchanged notes. Its focused run and final complete native run both pass.

## Registration compatibility

#4718 was open when this round started. Its tested head `a7f9dfc2f167216f93f1fa4288985056b2f4e793` retains `Registration.key_down` as the focused-action fallback. The branch retains that existing registration, without a compatibility shim.

`registration_probe.py` archived each base, copied only the shortcuts surface and one inventory line, and ran the real binary compile entry. Both main `a0b4f4f1084d291db00fbc1d4631240d1faeaf56` and #4718 `a7f9dfc2f167216f93f1fa4288985056b2f4e793` passed:

```text
Surface files and one inventory line compile; shared registry and editors match the base.
```

Eight shared core files match the pinned main byte-for-byte. `shell.rs` differs by one added registration line. The existing PR-view integration test is the only changed test outside the shortcuts surface.

## Completion gates

The saved-history prerequisite was built locally before that case ran:

```sh
CARGO_TARGET_DIR="$PWD/crates/o8d/target" cargo build --locked --manifest-path crates/o8d/Cargo.toml --bin o8d --features experimental-http
CARGO_TARGET_DIR="$PWD/native/o8-next/target" cargo test --locked --manifest-path native/o8-next/Cargo.toml -- --nocapture --test-threads=2
```

```text
test result: FAILED. 171 passed; 5 failed; 3 ignored; 0 measured; 0 filtered out; finished in 1899.33s
```

Full-run failures: known #4717; standalone diff selected-file readiness; Brain's transient busy assertion; Issues' control-paint readiness; and the paced terminal flood. The saved-history case passed after its prerequisite build.

A serial rerun selected only the four failures other than #4717:

```text
test result: FAILED. 2 passed; 2 failed; 0 ignored; 0 measured; 175 filtered out; finished in 214.12s
```

Brain and Issues passed. Diff still reported `selected-file HTTP load must finish before paint timing ends` (#4728). Terminal reached its end marker but received 49,868,988 bytes instead of 50,000,012 (#4752); the complete run received 44,879,052. The affected standalone diff and terminal sources are unchanged from the pinned base. Fixture writes versus bridge/consumer loss has not been isolated.

| Check | Result |
| --- | --- |
| Displayed rows | 1 focused test passed; all 16 chords |
| Shortcut tests in complete native run | 11 passed |
| PR note close/reopen integration | Passed, focused and complete run |
| Native CLI tests | 7 passed |
| Cargo Clippy, all targets | Exit 0; no diagnostics in changed surface files; existing shared Palette warning remains |
| Fast typecheck, 8192 MiB heap | Passed |
| Relevant TypeScript integration tests | 2 files, 7 tests passed |
| Touched Rust formatting and diff whitespace | Passed |

TypeScript entry tests: `tests/next-surface-registration-real-path.test.ts` and `tests/o8-next-shell-real-path.test.ts`. No full TypeScript suite ran.

All Rust verification used owned Cargo targets inside this worktree. Both Cargo target directories are removed at close. No OS-level input was sent. The PR remains open and unmerged for the operator's decision.

Refs #4548
