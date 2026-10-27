# Linux voice fix round 2

PR #4829, starting at `3495504d785340107381dff344d3d83c1ac0e46c`.
Merged main `e5abec8d2a76191151f4e514fe1dac80d43393f5` before the fix.
The platform-helper conflict retains both Linux voice and glass predicates.

Capture now waits for successful model preparation for the current locale.
Failure answers the session with “Voice is off” and the model approval
instructions, then completes without opening the audio source or writing a WAV.
Stopping a waiting start cancels it. Locale changes invalidate earlier results
and end any active session using its original language. A later explicit start
rechecks installed files, so a separately approved installation can enable voice
without restarting the helper. These checks never grant download approval.

## Red on the exact starting head

Only the new test files were copied into a detached copy of the starting head.

`cargo test --locked --offline --manifest-path crates/o8-linux-voice/Cargo.toml --features whisper --test helper_model_policy helper_declined_model_keeps_capture_disabled -- --exact`

```text
test helper_declined_model_keeps_capture_disabled ... FAILED
failures:
    helper_declined_model_keeps_capture_disabled
test result: FAILED. 0 passed; 1 failed
```

The actual helper received fixture audio with an empty model directory. The test
waited for the approval-required error before each start/stop, including after
a locale change. It observed listening, level and audio-file events and two
recorded files; the downloader marker and model directory remained absent.

`cargo test --locked --offline --manifest-path crates/o8-linux-voice/Cargo.toml --test daemon_protocol model_`

```text
test capture_waits_for_current_model_and_stop_cancels_pending_start ... FAILED
capture must wait for a usable model
test failed_model_preparation_refuses_a_waiting_start ... FAILED
no capture while preparation is pending
test result: FAILED. 0 passed; 2 failed
```

## Green after the fix

`cargo test --locked --offline --manifest-path crates/o8-linux-voice/Cargo.toml --features whisper`

Selected test lines:

```text
test capture_waits_for_current_model_and_stop_cancels_pending_start ... ok
test failed_model_preparation_refuses_a_waiting_start ... ok
test helper_declined_model_keeps_capture_disabled ... ok
```

Suite totals:

```text
library: 36 passed; 0 failed
daemon_protocol: 9 passed; 0 failed
helper_binary: 2 passed; 0 failed
helper_model_policy: 4 passed; 0 failed
linux_ptt_path: 3 passed; 0 failed; 6 ignored
model_policy: 3 passed; 0 failed
```

All three new tests pass. The real-helper test asserts the start's approval
message, zero listening/level/transcript/audio-file events, no recorded files
and no downloader calls. The daemon tests also check stale locale results,
stop cancellation and recovery after a failed preparation becomes successful.
The capture-refusal test waits for the audio-source attempt before stopping;
an immediate stop during preparation now correctly cancels that attempt.

The optional successful-transcription test returns early without a supplied
model. No model was downloaded for this run, so its reported pass does not
establish successful transcription. Four helper-policy cases and the explicit
missing-path helper test execute the real binary. Physical microphone and
desktop hosting remain outside this fixture evidence. This round changes no
implementation for other operating systems.

Additional checks passed: the helper's locked all-target compilation with the
model feature, formatting, `npm run typecheck:fast`, scoped lint, the rule check
against main, and all seven platform-helper assertions. The five private X11
hold/release probes were rerun and passed, with no failures.

`npm run verify:ci` finished with seven checks passing: Type Check, Lint,
Test Classification, Server Bundle Size, Integration Tests (no changed
resource-owning test files), Governance Smoke and Security Audit. This includes
the full `npm run typecheck`. Hermetic Unit Tests reported 9,681 passed,
1 failed and 5 skipped across all four shards. The failure is the unchanged
credential-store fixture: creating its lock directory under the process home
returns `ENOENT` in this workspace. Its test and store sources match merged
main. The voice tests above pass independently of that filesystem boundary.
