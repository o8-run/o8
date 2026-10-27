# Review round 2 verification

Rebased onto `origin/main` at `8ceb02390`, including the Workers registration,
before making this correction. The branch and PR remain the same.

The [mapping red tail](red-mapping.txt) records three failures through the CLI:
Workers was absent, the registration mismatch hid its name, and comparison of an
existing report was blocked by unrelated inventory drift. The manifest now maps
Workers to the existing `--workers` fixture, saved native Workers tab and current
`/dashboard` route. Inventory/capture preflight names missing, stale or duplicate
surface IDs and the manifest to update. Report comparison remains available for
older captures. The disposable missing-mapping test copies the actual CLI source
and registration inventory without changing the working tree's registrations.

The [unknown-selection red tail](red-only.txt) shows both the CLI and web host
still alive after five seconds. The fixed CLI rejects an unknown `--only` with
exit 1 before starting children. Capture also validates selection before creating
its resources. Web startup now shares capture's `try/finally`; a separate test
starts a host, fails native test compilation, and verifies both processes exit.
The [preflight green tail](green-preflight.txt) includes both corrections, the
production-route check and all 52 accepted gap recomputations.

The real Workers capture also exposed a measurement deadline: forty executor
drains repeated its three-second live poll. The [capture red tail](red-workers-capture.txt)
records the failure. The geometry probe now measures Workers' initial snapshot
from the production routes and asserts the Workers pane, list and fixture card.
Its live polling behavior remains covered by the existing Workers tests.

Current main moved workspace choices into the switcher. The parity probe now
checks that real switcher, and the Activity retention test uses it to select the
same second workspace. The Issues symlink-retention test now invokes the existing
palette Refresh command instead of the removed permanent Refresh button. The
retention, route and send assertions remain unchanged. The glass appearance
probe also switches workspaces through the current picker, preserving its veil
hit-testing assertion:
[native rebase red](red-native-rebase.txt), [native rebase green](green-native-rebase.txt),
[native refresh red](red-native-refresh.txt), [native refresh green](green-native-refresh.txt),
[native appearance red](red-native-appearance.txt), [native appearance green](green-native-appearance.txt).

The latest matching-session pairs are [1024×720](session-1024x720.png) and
[1440×900](session-1440x900.png).

The [Workers report](workers-report.json) records two successful captures:
[1024×720 pair](workers-1024x720.png), [1440×900 pair](workers-1440x900.png).
The current-UI opener remains unavailable, so equivalent worker grouping and its
geometry are unverified. Those rows remain Partial/Missing under #4736. Image
paths inside the JSON refer to the complete CI artifact layout.

The original 28-case report, all 52 numeric gaps, the 154 existing checklist rows
and the original PNGs are unchanged. Workers adds eleven checklist rows. The
checklist generator accepts multiple reports so the new capture can be recorded
without replacing the accepted snapshot.

| Final check | Result |
| --- | --- |
| Capture/preflight/render/production-route tests | 21 passed |
| Final preflight and retained CLI/route rerun | Nine passed |
| Full real Xvfb/native/Next capture | 30 cases, zero crashes |
| Full native `cargo test --locked` | 186 passed, six ignored; seven CLI tests passed |
| Real GPUI parity tests | Both passed; also included in the full native suite |
| Linux runner and boundary regression tests | 26 passed |
| `npm test` | 9,111 passed, five skipped |
| `cargo clippy --all-targets --locked` | Passed with existing warnings |
| Full TypeScript check with the 8192 MiB heap and fast typecheck | Both passed |
| `npm run test:classify` | Passed; 1,242 hermetic, 928 resource-owning |
| Touched-file ESLint, Rust formatting and rule check | Passed |

See the [CLI green tail](green-cli.txt) and [completion tails](green-checks.txt).
The full native run uses the existing sibling server built with
`cargo build --locked --manifest-path crates/o8d/Cargo.toml --features experimental-http`.
The six ignored entries are four explicit measurement workloads and two isolated
probes; the appearance probe is invoked by its passing parent test. The complete
latest native run supersedes the diagnostic runs used to identify the stale
controls. The original submission and first-review history remain preserved.
