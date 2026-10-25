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

## Correction round 2

Rebased on `0eeb65889` after first-run setup and the surface boundary gate landed. The real fixture host and production GPUI shell reproduced
rotation after a successful reconnect, before changing credential sharing:

```text
round2_rotation_child
the retained composer must send with the rotated credential
notice: "Queue rejected the request (HTTP 401). Draft retained."
left: String("message after rotation")
right: String("")
test result: FAILED. 0 passed; 1 failed
```

The built CLI and native shell separately reproduced split configuration:

```text
reloads a legacy token when the port is in the current profile directory
expected ordered token-file candidates; received null
Tests: 1 failed; 8 skipped

round2_legacy_child
reload must resolve the valid legacy candidate instead of reporting Token missing
test result: FAILED. 0 passed; 1 failed
```

A live PR metadata assertion also failed before adding the authorized label:

```text
FAIL: PR #4700 shared shell hooks require shell-work
Actual labels: size/L
```

The label is now present with its one-line reason in the PR body. Generic shared
hooks remain optional/defaulted. The connection-owned transport adapter is
selected by one root module path registration. It delegates the original
transport primitives and replaces a single shared transport snapshot on
reconnect. Existing retained views, workspace clones and subscriptions therefore
use the refreshed operator bearer for subsequent requests. Network I/O does not
hold the refresh lock. Independent clients keep separate authority; workspace
and opt-in desktop identity remain scoped to each clone. Shared `src/client.rs`
is byte-for-byte unchanged from main, and surface requests remain in their
modules.

Initial CLI resolution and native reload now share the same ordered current and
legacy candidates, independently of the port file's directory. Explicit data
directories have one candidate. Descriptors are absolute, bound to the selected
numeric loopback origin, and suppressed for worker, environment, explicit-native
and other-origin authority. Each reconnect reads at most two bounded files.

Hostile review covered the three likeliest macOS/race failures:

1. Rotation leaves retained request clients stale. The same composer entity sends
   successfully after an atomic source replacement. Its retained workspace clone
   can read the committed queue and reacquire WebSocket information. Separate
   client-source and server-token files prove missing and invalid source values
   revoke retained authority while the server still accepts the previous bearer.
   An independently authenticated old client remains unauthorized.
2. Port/token directory precedence diverges or a relative path is rejected on
   reload. The built CLI authenticates with a split current-port/legacy-token
   profile, and the actual native window resolves the legacy candidate. A further
   relative-path regression was reproduced before normalizing descriptors:
   `expected true; received false` for absolute candidate paths. Canonical-path
   assertions cover the alias and relative-directory cases.
3. Inherited descriptors override a test's source or promote worker authority.
   Single-file child processes remove inherited candidate lists. The built CLI
   checks worker, environment, explicit-native and other-origin suppression.
   Child parents require both successful exit and an explicit one-test passing
   receipt, preventing an empty filtered subprocess from counting as coverage.

Green tails:

```text
Connection module: 8 passed; 0 failed; 3 owned children listed as ignored
Rebased shell suite: 130 passed; 0 failed; 3 owned children listed as ignored
Other native unit tests: 29 passed; 0 failed; 3 manual measurements ignored
Native CLI tests: 7 passed; 0 failed
Built CLI/config tests: 12 passed; 0 failed
PASS: PR #4700 has shell-work and its one-line reason
```

All three owned child cases run through their parent tests; they are not skipped
coverage. Native unit coverage totals **159 passed**, with the unchanged Activity
ordering assertion excluded because current main inserts Pull Requests between
Activity and Diff. The missing o8d test binary from the prior broad probe is now
built with its existing HTTP feature: saved-history compatibility passes against
that real entry point. The final CLI tests were rebuilt for this branch to avoid
reusing another worktree's integration-test binary.

Files: `src/surfaces/connection_tests.rs`,
`src/surfaces/connection/client.rs` (delegated transport tests),
`tests/o8-next-shell-real-path.test.ts` and `tests/cli-config-isolation.test.ts`.
The existing native CLI, UI, fake-surface and desktop-identity tests also pass.
Before/after: retained-composer rotation **401 -> accepted queue receipt**;
split-profile reload **missing -> connected**; `shell-work` label **absent ->
present**. Both new native review regressions are green.

The 8192 MiB TypeScript check, fast typecheck, classification after test-module
registration, touched TypeScript ESLint/rule-check, explicit Rust formatting and
diff checks pass. Full `npm test` ran for this correction batch: **1242 files
passed, 3 skipped; 9057 tests passed, 5 skipped** (474.79 s). The final focused
CLI run includes the subsequent absolute-path normalization. No release, version,
deploy or publishing files changed. WebSocket rotation coverage verifies fresh
WebSocket-info acquisition; it does not claim a rotated-token handshake against
the fixture's existing socket listener.


Final rebase verification on `0eeb65889`:

```text
Shell suite including 22 new Setup cases: 130 passed; 0 failed
Remaining native unit cases: 29 passed; 0 failed
Native CLI: 7 passed; 0 failed
Combined server/window patches on updated main:
GPUI window tests 5 passed; geometry adapter 2 passed; native shell CLI 3 passed
Surface boundary: exempt (label shell-work)
```

Both Setup and Connection registrations were preserved. The combined patch was
applied only in a detached test checkout; no branches were merged. The window
branch kept its one published correction push. Its new boundary-policy label
and reason were verified from live PR metadata and the actual checker.

The final full npm rerun on the updated base reports **1241 files passed, 1
failed, 3 skipped; 9073 tests passed, 1 failed, 5 skipped** (677.12 s). The sole
failure is `tests/desktop-account-identity.test.ts`, provider provisioning expected
one entry and observed none. That file and its account-provider code are
unchanged by these patches. The same npm entry point filtered to that file then
passes **4 tests** (1.02 s). No account-provider changes are included, and the full
rerun is not reported as green. The earlier full run's 9057 passing tests remain
recorded above as an earlier checkpoint.

All required typechecks, touched-file lint/rules, classification and formatting
were rerun after the final rebase and passed. Shared `src/client.rs` remains
byte-for-byte main. Final native CLI artifacts were rebuilt in the standalone
server checkout after the combined check to avoid shared-target cache ambiguity.
