# Linux voice fix round

Base: `62017d91f90fa332354cfee6afbb66b5f5690378` (#4829).

Startup and locale changes use installed models only. Loading verifies the pinned
checksum, including when a cache file retains the expected size. Installation
requires an explicit command acknowledging the advertised byte count. Missing or
corrupt models remain untouched until that action.

X11 holds observe focus, active-window changes and raw chord-key releases,
independently of the shortcut callback. Audio effects are ordered and fenced by
hold generation. A stalled monitor releases capture; an unready monitor cannot
start it. Idle events are drained, and old window subscriptions are removed.

## Red tails before production changes

`cargo test --locked --manifest-path crates/o8-linux-voice/Cargo.toml --test model_policy`

```text
test same_size_corrupt_cache_is_rejected_without_download ... FAILED
same-size replacement must be rehashed before load
test startup_and_locale_do_not_download_models ... FAILED
boot and locale changes are not download approval
  left: 1
 right: 0
test result: FAILED. 0 passed; 2 failed
```

`cargo test --locked --manifest-path crates/o8-linux-voice/Cargo.toml --test linux_ptt_path ptt_ -- --include-ignored --test-threads=1`

```text
test ptt_focus_loss_and_foreign_keyup_stop_recording ... FAILED
window change while held must stop recording before key-up
  left: 0
 right: 1
test ptt_released_preparation_cannot_start_a_later_hold ... FAILED
released A must never acquire B's held state
  left: [1, 0]
 right: [1]
test result: FAILED. 0 passed; 2 failed
```

## Green receipts

`cargo test --locked --manifest-path crates/o8-linux-voice/Cargo.toml --features whisper`

```text
library: 36 passed; 0 failed
daemon_protocol: 7 passed; 0 failed
helper_binary: 2 passed; 0 failed
helper_model_policy: 3 passed; 0 failed
linux_ptt_path: 3 passed; 0 failed; 6 ignored
model_policy: 3 passed; 0 failed
```

The three helper-policy tests run the actual helper executable. They verify no
fetch at boot or locale change, refusal before size approval, successful reach
of the downloader only after matching approval, and checksum rejection of a
sparse corrupt file with the full catalog model size. Transfers use a refusing
test downloader; no model download is needed.

Run the opt-in X11 command above with Xvfb and xdotool installed:

```text
test ptt_brief_focus_and_key_changes_end_hold ... ok
test ptt_configured_chord_keeps_release_monitoring ... ok
test ptt_focus_loss_and_foreign_keyup_stop_recording ... ok
test ptt_released_preparation_cannot_start_a_later_hold ... ok
test ptt_stalled_x_server_ends_recording ... ok
test result: ok. 5 passed; 0 failed
```

The X11 probe includes the production registration and hold modules, registers
the actual shortcut backend on a private X server, forwards genuine shortcut
events, changes real window focus, and sends key input from another process.
It also checks a configured CapsLock chord, brief focus-away-and-back and
modifier-release-and-repress edges, and a stopped X server. The desktop host
interfaces and audio engine are test doubles; no microphone is opened.

Other gates: `npm run typecheck:fast` and `npm run typecheck` passed.
`npm test -- --experimental.fsModuleCache=false` passed: 1,258 files and 9,454
tests; 3 files and 5 tests skipped. `cargo metadata --locked --no-deps` passed
for the desktop manifest. The offline desktop check stopped before compilation
because `chrono` was not cached. Full desktop hosting, microphone capture and
transcript delivery were not exercised. Focus release uses existing ordinary
finalization. No macOS or Windows implementation was changed.

Decision: retain the existing branch and submit one fix commit for review.
