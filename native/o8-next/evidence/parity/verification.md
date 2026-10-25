# Parity capture verification

The recorded run produced 28 capture pairs for 14 registrations at 1024×720 and
1440×900, with zero harness crashes. The images come from the real X11 native
window and the current Next `/dashboard` route. Both clients use the same
disposable production-route host for each surface. The rich-history case restores
the same persisted thread through the existing desktop tab-state route.

Native metric bounds are a separate GPUI TestAppContext receipt with its test
text system. They do not claim real-font or compositor geometry. Unavailable
measurements remain null. The [report](report.json) includes numeric gaps,
browser computed styles, route statuses, missing openers and selection limits.
Its image paths refer to the full CI artifact directory.

The regression was written first against the real GPUI shell and fixture routes.
It failed because the parity manifest did not exist after the shell had painted.
The CLI entry-point tests also failed before the runner existed. Receipts:
[native red](red-native.txt), [native green](green-native.txt),
[CLI red](red-cli.txt), [CLI green](green-cli.txt).

| Check | Result |
| --- | --- |
| Complete capture entry point | 28 pairs, zero crashes |
| Parity, Linux runner and boundary tests | 29 passed |
| New parity CLI and production-route fixture tests | 3 passed |
| Native parity test | 1 passed |
| Native CLI suites | 7 passed |
| `npm test` | 9,084 passed, five skipped |
| `npm run typecheck:fast` | Passed |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` | Passed after the repository's generated-type cleanup |
| Native `cargo clippy --all-targets --locked` | Passed with existing warnings |
| `npm run test:classify` | Passed; new test registered as resource-owning |
| Touched-file ESLint and rule check | Passed |

The full native suite was run twice and was **not green**. The first run had
162 passes, two failures and three ignored workloads. One failure was an outdated
Activity palette adjacency assertion after the existing pull-request command was
inserted. It now verifies unique registration and retains the real keyboard
navigation/paint assertion. That test passed in the second full run.

The second full run also had 162 passes, two failures and three ignored workloads:

- `shell::issues::tests::issues_errors_retry_stale_and_account_switch` failed at
  `issue-view-17` reaching CPU paint. It passed in the first full run and on an
  isolated retry. Its implementation and assertions are unchanged.
- `ui::o8d_read_tests::saved_history_surface_with_only_o8d` had no listener receipt
  because its sibling binary lacked the HTTP feature. After building with
  `cargo build --locked --manifest-path crates/o8d/Cargo.toml --features experimental-http`,
  its isolated real-route retry passed.

The complete native suite still needs a clean full run; isolated retries do not
replace that result.

Remaining acceptance is tracked in the [parity checklist](../../../../docs/internals/o8-next-parity.md):
native computed font/weight/padding measurements; sidebar, rail, top-bar,
transcript and files bounds; current-UI Brain/Activity/Issues openers; matching
grid composition; selected packet diff and attached fixture terminal captures;
and macOS system-glass acceptance. No screenshot or null measurement marks those
items Done.

The shared README and CI setup require the boundary's explicit `shell-work`
label. The production shell, renderer, client and registration inventory are
unchanged. The boundary regression tests pass, including a real isolated Cargo
check of a fixture surface with one registration line.
