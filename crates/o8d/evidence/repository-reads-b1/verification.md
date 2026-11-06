# Repository branch-read checkpoint

Refs #5422 and #5243. Repository/git remains partial. Only branch GET is
implemented behind `O8D_NATIVE_REPOSITORY_READS`, default off. All persisted
writers remain with their existing owners. See the [ownership audit](../../../../docs/operations/o8d-phase-b-ownership.md).

## Evidence

The session-only binary failed the new real-entry parity test at
`Native repository read was not reached: /api/panel/branches`.
The candidate passes all 12 recorded TypeScript responses with Next stopped;
every replay requires `x-o8d-native-repository-read: 1`. Cases include missing
and duplicate query parameters, missing/non-repositories, unborn/bare repositories,
Git directories, linked/nested checkouts and symlink paths.

[corpus.json](corpus.json) is the recorded oracle. Random fixture paths and their
URL-encoded forms were substituted with `$FIXTURE_DIR` / `$FIXTURE_DIR_URI`
only after exact runtime comparison. Normalization preserves semantic fields,
array order and missing/null distinctions.

`cargo test --release --locked --manifest-path crates/o8d/Cargo.toml --all-features`
passed 17 tests. Four new Rust tests cover flag-off behavior, helper/promisor/ref
refusals, ref refresh and idle/active EOF cancellation with child reaping.
The actual TypeScript client test proves concurrent startup coalescing and busy
shutdown. Focused HTTP integration passed 19 tests, two optional benchmarks
skipped; the separate cleanup gate passed all three changed files (nine tests,
one optional benchmark skipped). Final fast typecheck and changed-file lint passed.

## Measurements

Release binary, Node 22.23.4, 10 warmups, 100 samples and 20 seconds idle before
RSS. Modes run sequentially without competing tests/builds. RSS sums the backend
WS process and descendants, including the optional private reader; the fixture
Next listener is stopped. This is not whole-application memory.

| Measurement | TypeScript | Rust |
| --- | ---: | ---: |
| Idle backend RSS, MiB | 272.63 | 229.82 |
| Branch GET p50, ms | 8.64 | 4.32 |
| Observed descendant process count | 4 | 5 |

[metrics.json](metrics.json) retains exact values. The process count includes
all observed descendants, rather than asserting every descendant is idle.

## Limits and handoff

Configured diff helpers, partial/promisor clones and option-like default refs
use TypeScript. Native commands prohibit external diff/textconv/lazy fetch,
bound output and projection work, and cancel/reap on parent EOF. Existing auth,
Host, loopback and environment allowlist implementations were not edited.
The registry uses a new loopback client rather than extending protected admission.

Commits, files, status, comparison-diff and all writer domains remain unfinished
or excluded as described in the ownership audit. Full `npm test` had one failure
in unchanged Linux credential test isolation (global lock path outside workspace).
The aggregate `verify:ci` was not green. Initial integration cleanup passed after
using an external orphan-reaping launcher. The separate native UI retry completed
shards 1–3 and the regular phase of shard 4; remaining phases are unverified.
Real-window prerequisites (Xvfb/openbox/xdotool/lavapipe) are unavailable here.

These results were recorded before the final rebase; the PR/handoff identifies
post-rebase checks separately. No whole Phase B completion is claimed.
