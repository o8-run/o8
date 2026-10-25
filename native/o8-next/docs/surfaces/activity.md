# Activity

The opt-in shell registers Activity through `src/surfaces/activity.rs` and one
entry in the shell inventory. Its `activity/` directory owns the feed, GPUI view,
transport and tests. The stateless workspace slice preserves the existing
`Activity` tab discriminator and workspace JSON shape. The command stays after
Grid and before Diff. Worker links reuse the selected workspace's session view.
Polling and CI cooldown recovery run only for the active Activity view.

The transport is a child of `Client` so it can use the existing private operator
credential, loopback agent and bounded response reader. `client.rs` contains only
its module include; request handling lives in `surfaces/activity/transport.rs`.
Routes, auth, HTTP refusals, receipt replay and row grouping are unchanged.

The development host discovers `scripts/next/surfaces/90-activity.surface.ts`.
It supplies Activity's production routes, body admission and lost mission-stop
response hook without editing the shared dispatcher. Its authored upstream and
disposable Git/SQLite state remain in the adjacent `activity-fixture.ts`.

All nine existing headless GPUI test function names are retained in
`src/surfaces/activity/tests.rs`, using `shell::test_support`. They cover the
same actions and refusals, including repository-scoped commit/CI grouping and
lost-stop receipt replay. Existing [parity](../../evidence/activity/parity.md),
[verification](../../evidence/activity/verification.md) and timing receipts remain
under Activity's evidence directory. This extraction does not complete the
missing parity items or change the installed app's opt-in behavior.

## Extraction verification

The real GPUI Hold/Release/Stop mission test failed before the discovered fixture
entry was registered: 0 passed, 1 failed. After registration all 9 Activity tests
pass, including the fork/CI regression and lost-stop receipt replay. Their
function names are unchanged; the palette test also checks command ordering.

Full native verification passes 88 unit/GPUI tests and 7 CLI tests, with 3 existing
measurement workloads ignored. The affected TypeScript host tests pass 27 tests
across 10 files. Full `npm test` passes 1,242 files and 9,056 tests, with 3 files
and 5 tests skipped. Typecheck fast, tsc with an 8 GiB heap, touched-file ESLint,
rule-check, Rust formatting, classification and classification check pass.
Clippy exits zero with no Activity diagnostics; the existing `Client::decorate`
lint at `src/client.rs:53` remains unchanged from main. Classification reports
1,238 hermetic and 899 resource-owning tests.

Captured tails: [red](../../evidence/activity/registration-red.txt) and
[green](../../evidence/activity/registration-green.txt). Shared shell state, view,
tests and test support, the root module list, and the development dispatcher match
main exactly. The only shared-file exception beyond the shell inventory line is
the private transport module include in `client.rs`.

The final rebase onto `c9acfe4b2` changes no native or fixture-host source trees.
Activity passes all 9 tests again; the native saved-history test passes against a
rebuilt `o8d`. Both typechecks and Clippy pass again. The repeated TypeScript
batch passes 26 tests and hits one transient 400 in the unchanged composer worker
test; its isolated rerun passes. The same failure and isolated recovery are
recorded in [main's registration evidence](../../evidence/surface-registration/verification.md).
The worker host returns before surface discovery; its source is unchanged.
