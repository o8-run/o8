# Correction round 2

Rebased only the first-run branch onto `3b99b20d6`, retaining Customize as merged
on main. No other PR branch or surface was edited. All 99 main native test
function names are preserved; see [inventory](preserved-tests.json).

The previous OpenCode test covered an explicit saved model. The fresh path left
the lead model empty, which the conversation route converted to `claude-code`.
Native-control tests now cover fresh OpenCode setup and an independent Codex
worker pool. The shared recommendation uses a saved OpenCode model, validated
OpenCode CLI configuration, then `MODEL_IDS.opencodeDefault`. No Rust model ID
is copied. Native conversation creation also refuses absent or blank models.

The registry callbacks are `Option<fn(...)>`, defaulting to `None`. Only setup
opts in. The load notification supplies the GPUI context after workspace loading;
the command veto preserves busy refusal before navigation changes state. Their
view state and policy remain in the first-run module. Unchanged modules keep
their existing constructors. The main registration probe opens and paints through
its existing authenticated fixture and native keyboard entry.

Tests were written before each fix:

| Contract | Red | Green |
| --- | --- | --- |
| Fresh OpenCode and independent workers | 0 passed / 2 failed | 2 passed |
| Missing-model refusal | 0 passed / 1 failed | 1 passed |
| Optional lifecycle defaults | E0599 for both non-optional function pointers | 1 passed; main probe unchanged |
| Recommendation null/blank/configuration cases | 7 passed / 4 failed | 11 passed |
| Full setup surface | 5 existing cases before this round | All 9 cases passed |

Red receipts: [model](model-red.txt), [missing model](missing-model-red.txt),
[hook contract](hooks-red.txt), [recommendation](recommendation-red.txt).
Focused green: [native](native-green.txt), [hook](hooks-green.txt),
[TypeScript](typescript-green.txt).

Native cases live in `src/surfaces/setup/tests.rs` and its included
`correction_2_tests.rs`. They drive production routes through the discovered
fixture, persist the first conversation and send through the production queue.
The missing-model fixture changes only the production GET payload to represent
an older peer; operator auth, conversation and queue routes remain production.
TypeScript coverage includes `src/lib/setup/runtime-recommendation.test.ts`,
`src/lib/setup/built-in-agent-server.test.ts`,
`tests/onboarding-runtime-picker-real-path.test.ts`,
`tests/operator-defaults-runtime-inventory.test.ts`,
`tests/agent-setup-real-path.test.ts`,
`tests/next-surface-registration-real-path.test.ts` and
`tests/o8-next-shell-real-path.test.ts`: **7 files / 43 tests passed**.

Latest focused CPU-scene timing: **67.49 ms open-to-first-frame**, **41.81 ms
interaction-to-frame**. See [run.json](run.json). Linux debug/headless GPUI; no
macOS, GPU/compositor or production latency claim. Prior timing receipts remain
under their original run conditions.

Final completion [gates](gates.json): both 8 GB TypeScript checks, ESLint,
rule-check, test classification (including the dated-fixture audit) and Clippy
passed. Clippy reports no diagnostics in touched Rust files. ESLint ignores six
Rust files; Clippy checks them.

The full native run reported **95 passed, 1 failed, 3 ignored** in the unit binary.
The unchanged worker fixture timed out waiting for its first transcript. Its
isolated retry passed **1/1**, and all **7 CLI integration cases passed** separately.
No worker code or tests changed. The initial broad run remains non-green;
[full result](native-full.txt), [retry](worker-retry.txt), [CLI](cli-green.txt).

Full `npm test -- --experimental.fsModuleCache=false --maxWorkers=2` passed
**1,242 files / 9,061 tests**, with **3 skipped files / 5 skipped tests**.
See [receipt](npm-full.txt).
Remaining partial-port controls and unmeasured platforms stay in the parent
parity inventory; this round does not claim completion of #4548.

Refs #4548
