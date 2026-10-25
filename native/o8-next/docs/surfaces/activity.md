# Activity

The opt-in shell registers Activity through `src/surfaces/activity.rs` and one
entry in the shell inventory. Its `activity/` directory owns the feed, GPUI view,
transport and tests. The stateless workspace slice preserves the existing
`Activity` tab discriminator and workspace JSON shape. The command stays after
Grid and before Diff. Worker links reuse the selected workspace's session view.
Polling and CI cooldown recovery run only for the active Activity view.

The surface includes `activity/transport.rs`, whose inherent `impl Client` uses
the shared URL, authenticated-request and bounded-response helpers. The shell's
single Activity registration compiles the adapter; `client.rs` matches main.
Routes, auth, HTTP refusals and receipt replay retain their existing behavior.

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
main exactly. The historical extraction also included the private transport module
from `client.rs`; the final round removes that shared-file exception.

The final rebase onto `c9acfe4b2` changes no native or fixture-host source trees.
Activity passes all 9 tests again; the native saved-history test passes against a
rebuilt `o8d`. Both typechecks and Clippy pass again. The repeated TypeScript
batch passes 26 tests and hits one transient 400 in the unchanged composer worker
test; its isolated rerun passes. The same failure and isolated recovery are
recorded in [main's registration evidence](../../evidence/surface-registration/verification.md).
The worker host returns before surface discovery; its source is unchanged.

## Correction round 2: repository-qualified row controls

GPUI row IDs and selectors now use the existing repository-qualified row key.
Expansion, selected controls and keyboard focus therefore address the same
repository/row pair. Keyboard focus stores a control ID and resolves its current
position when moving, so closing the first fork's detail cannot move focus onto
the second fork's commit link. Clicking a row also selects its control ID.

Two new fixture-server GPUI regressions cover independent fork controls, clicking
each fork's commit and link, and Tab/Enter/Space navigation while details change
the control order. Red: one distinct control for two repositories, and Space
leaves the second fork expanded. Green: all 11 Activity tests pass, including the
existing repository-owned CI badge regression. Captured tails are in
[review-2-red.txt](../../evidence/activity/review-2-red.txt) and
[review-2-green.txt](../../evidence/activity/review-2-green.txt).

Correction round 2 retained the `Client::activity_request` include in `client.rs`.
The final round moves it into Activity after rebasing onto #4696.

Completion gates for correction round 2 pass: full native 90 unit/GPUI and 7 CLI
tests (3 existing measurement workloads ignored); full npm 1,242 files and 9,056
tests (3 files and 5 tests skipped); typecheck fast and tsc with an 8 GiB heap;
Clippy with no Activity diagnostics; touched-file ESLint, rule-check, Rust
formatting and classification (1,238 hermetic / 899 resource-owning).

After rebasing onto `eb715fd1c`, all 11 Activity tests pass again. The latest full
native run has 89 passed and one failure in the unchanged Issues paint-wait test
`round1_repository_switch_survives_a_frame_between_mouse_events`; its isolated
rerun passes without source changes. All 7 CLI tests pass separately. The latest
full npm suite passes 1,242 files and 9,057 tests, with 3 files / 5 tests skipped.
Both typechecks, Clippy, ESLint, rule-check and classification pass again;
classification also passes all 78 isolated date-fixture tests introduced by main.

## Final local identity correction

Remote rows retain their normalized GitHub repository identity. Local-only rows
use `local:` plus the canonical registered root instead of the shared `local`
placeholder. Row controls, expansion, details, click selection and keyboard focus
all derive from the same key. Commit deduplication uses that identity too.
Separate clones and registered local worktrees remain separate; aliases and
repeated registrations of the same root yield one row.

The four-case [matrix](../../evidence/activity/final-matrix.md) was written first
in `activity/identity_tests.rs`. It uses real Git topology and the production
registry/commit handlers through the headless shell. The saved
[red output](../../evidence/activity/final-red.txt) has two passing cases and two
failures: local clones and linked worktrees reproduce ignored clicks, shared
expansion and trapped Tab focus. This is macOS headless GPUI evidence, not an
installed-app, GPU or compositor measurement.

The same [green matrix](../../evidence/activity/final-green.txt) passes all four
cases. All 15 Activity tests also pass in both complete native runs. The 7 native
CLI tests and 7 related TypeScript tests pass. Typecheck fast with an 8 GiB heap,
Clippy (zero touched-file diagnostics), touched-file ESLint, rule-check, formatting
and classification pass, including all 78 isolated date-fixture checks.

The complete native gate remains red outside Activity. The first full run has
95 passed, 1 failed and 3 ignored: an unchanged Issues paint wait fails, then
passes in isolation. The serial run also has 95 passed, 1 failed and 3 ignored:
Issues passes, but the unchanged terminal flood test receives 41,450,556 of
50,000,012 bytes. Its isolated rerun also fails at 46,945,612 bytes. The terminal
test passed in the first full run. Both failures and rerun results are retained
in [first-run evidence](../../evidence/activity/final-native-first.txt) and
[serial-run evidence](../../evidence/activity/final-native-serial.txt).

After rebasing onto #4696, Activity loads its request adapter through its own
module using the shared transport helpers. Outside Activity's source, fixture,
documentation and evidence files, the PR adds only one shell registration line.
