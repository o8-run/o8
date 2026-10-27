# Shell module verification

See [cached chrome integration](chrome-groups.md) for the current main/head
comparison, render groups and slot-state invalidation regression.

## Earlier verification

The primary regression was written before the registries. It opened the real
GPUI shell against the existing authenticated production-route fixture and failed
at the absent feature render slot. The unchanged test now passes rendering, key
handling, palette execution, ticks, observation and persisted window bounds.
See [red.txt](red.txt) and [green.txt](green.txt).

`node scripts/next/shell-feature-order.mjs` adds three independent module commits
from one base, each with one registration line and no shared edits. All six merge
orders are clean and have the same tree. The merged production GPUI test verifies
render order, competing key contexts and ticks, a palette command and a preference
global observer against the existing route fixture. See
[order-experiment.txt](order-experiment.txt). The experiment uses its own build
output, creates no branches and removes its temporary worktree.

The unmodified registration-isolation test passes. The discovery build script
lives inside `src` so its isolated source copy includes it; generated module
includes resolve against the compiling manifest directory. See
[registration-isolation.txt](registration-isolation.txt).

The branch is based on `d1bab39d7`, including the landed sidebar. The existing
surface inventory is byte-for-byte unchanged from that main. Sidebar initialization,
ticks and the content decorator are preserved through the adapters. All 35 new
sidebar tests passed unchanged in the full run. No existing native test was edited.

| Gate | Result |
| --- | --- |
| New GPUI registry regression | Pass |
| Independent-module merge orders | 6/6 clean; combined GPUI test passes |
| Surface boundary policy/isolation TS tests | 19 pass |
| Existing shell and surface-registration TS tests | 7 pass |
| Native CLI suites | 11 pass |
| `cargo clippy --all-targets --locked` | Pass with warnings |
| `npm run typecheck:fast` | Pass |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` | Pass |
| `npm test` | 1,246 files / 9,103 tests pass; 3 files / 5 tests skipped |
| `npm run test:classify` | Pass; all five dated-fixture groups; manifest unchanged |
| Touched Rust formatting | Pass |
| Boundary CLI with `shell-work` label | Pass, existing exemption |
| Complete native suite | 213 passed, 7 failed, 6 ignored |

The full native tail is in [native-tail.txt](native-tail.txt). Five failures also
reproduce in a clean detached `d1bab39d7` checkout, using unchanged tests:

- Activity retention: missing `workspace-1` ([baseline](activity-baseline.txt)).
- Issue worker: missing `session-refresh` ([baseline](issues-baseline.txt)).
- Glass probe: missing `workspace-1` ([baseline](glass-baseline.txt)).
- Compact rows: missing session row selector ([baseline](tabs-baseline.txt)).
- Fifteen-workspace chrome: connected notice contains hints ([baseline](chrome-baseline.txt)).

The other full-run failures were the immediate Brain `busy` assertion and a
settings connection refusal. Both unmodified tests passed isolated reruns on this
branch; both also passed isolated clean-main runs. See
[focused-reruns.txt](focused-reruns.txt). A completely green full suite is not
established. No delays or assertions were changed to hide these results.

The complete historical keymap and preference PR patches were not replayed. The
landed sidebar is integrated and tested; the independent-module experiment
exercises all five extension seams. Full historical patch replay remains unverified.
