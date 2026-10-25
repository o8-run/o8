# Shell server link (#4548, item 1)

Baseline: `3b99b20d6` from main. Linux, Node 22, stable Rust. The built CLI,
production shell window factory under GPUI TestAppContext, and disposable
`dev-server.ts` host use production middleware and session handlers.

Tests were added before implementation. Captured red tails:

```text
shell_connection_checks_are_single_flight_and_keep_current_view
assertion failed: s.loading

test result: FAILED. 0 passed; 1 failed

shell_recovers_from_down_and_restart_without_reopening
left: "Local server unavailable: Could not reach the selected server. Start the local o8 server, then Retry."
right: "Server down"

test result: FAILED. 0 passed; 1 failed

shell_names_missing_and_rejected_tokens_without_leaking_them
left: "Local server unavailable: Server returned HTTP 401. Start the local o8 server, then Retry."
right: "Token missing"

test result: FAILED. 0 passed; 1 failed
```

The host is actually killed, restarted at the same allocated loopback port,
stopped mid-session and started again. The shell instance is never reopened.
The test also retains the selected view/entity across the disconnect and blocks
closing hidden content with Ctrl+W. Existing token-file resolution and authority
stay in the CLI; shared `client.rs` is unchanged.

Hostile review identified three likely platform/race failures and added coverage:

1. Temporary-directory aliases differ on macOS. The built CLI launches through
   a symlinked configuration directory and compares canonical parent paths with
   `realpathSync`; the native fixture roots already use `fs::canonicalize`.
2. Retry and periodic refresh overlap. Twenty refresh ticks in one GPUI update
   start one in-flight load, retain current state and settle without a notice.
3. A restarted host destroys selection or lets keys mutate a hidden view. The
   actual stop/restart regression retains the entity and rejects offline Ctrl+W.

Green tails:

```text
test result: ok. 4 passed; 0 failed
projects_auth_refusal_and_retry ... ok
settings_fixture_unauthorized_and_close_restore_shell ... ok
Test Files  1 passed (1)
Tests       7 passed (7)
```

The broader native shell run initially passed 59 of 61 cases; two existing
management-authentication cases exposed an overbroad offline guard. Both were
fixed and rerun green, together with all four shell tests. Management overlays
remain reachable; disconnected work surfaces remain inert.

Files: `src/shell_tests.rs`, `src/projects_tests.rs`, `src/settings_tests.rs`,
and `tests/o8-next-shell-real-path.test.ts` at the repository root.
Behavior regressions: 3 failing -> 3 passing; launcher checks: 6 -> 7 passing.

The 8192 MiB `tsc --noEmit`, `typecheck:fast`, touched TypeScript ESLint,
rule-check, classification and native formatting checks pass. The full npm suite
is deferred to the end of the three-item batch, as requested.

Remaining for #4548: terminal/packet-diff palette integration, keyboard workspace
switching, measurements, and tolerant restart state. Supported-display native
process startup and compositor measurements are unavailable in this environment.


## Correction round 1

Rebased on current main at `160576643`. Tests were written first through the
existing fixture host and production GPUI window factory. The late-token case
runs an owned native test subprocess with isolated launcher metadata; no process
environment is mutated in a concurrent test.

Red receipts:

```text
round1_connection_is_a_registered_module: connection state must render through its registered module
round1_reconnect_keeps_composer_focus_draft_and_queue: retained draft != retained draft after reconnect
round1_token_file_created_after_launch_connects_on_retry: Retry must reread the newly created token file
Native: 3 new failures
CLI reload descriptor: 1 failed; 7 skipped
```

Green: the six connection tests pass, including the owned child which exercises
missing -> wrong -> corrected token files. The built CLI suite passes eight
checks, including missing files and suppression of file descriptors for workers,
explicit bearers and other origins. Reconnect preserves the actual composer
focus handle, draft and production queue response.

All connection policy, focus recovery and error rendering now live in
`src/surfaces/connection.rs`; its tests live in `connection_tests.rs`. One
registration line loads the module. Shared lifecycle/chrome dispatch is an
optional `ShellExtension` with defaults; existing surface registrations,
including Activity and the real-request probe, compile unchanged. Shared
`client.rs` is unchanged. The original server-link tests moved into their module,
retaining their test function names.

Correction gates: native shell suite **79 passed, 0 failed**, plus one ignored
child test executed by its owning parent; CLI **8 passed**. TypeScript (8192 MiB),
fast typecheck, classification, touched-file ESLint/rule-check, native formatting
and diff checks pass. Full npm verification is repeated at the end of this
correction round.
