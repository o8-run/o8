# o8 Benchmark Suite

This suite makes release claims measurable instead of anecdotal. It wraps the existing harnesses and writes version-stamped scorecards under `tests/bench/scorecards/`.

## Tracks

- Automatable: speed, interactions, memory, and governance.
- Operator-triggered: coding. It remains `automatable:false` because collection launches paid external workers and must be started deliberately.

## Release Run

Run against a running target build:

```sh
npm run bench:all
```

For the speed-only release preflight, run:

```sh
npm run bench:quick
```

`bench:quick` is the single command that generates the deterministic
interaction fixtures, runs the bounded quick suite, and writes the
machine-readable artifacts. The service-speed lane stays under two minutes; the
interaction lane adds up to four more because it boots its own isolated stack.

The quick run writes `tests/bench/results/<version>.json`,
and compares its speed metrics with the previous release. The local ship
preflight runs the same measurement in an ephemeral directory. A regression or
missing measurement prints a warning but does not block an otherwise valid
release.

The receipt keeps benchmark-source identity separate from the running target.
`version` and `gitSha` identify the checkout that ran the benchmark. For a
release observation, `target.buildGitSha` is the required full commit supplied
as explicit release provenance and included in the artifact digest;
`target.serverReportedBuildGitSha` preserves the live server claim separately.
A non-null mismatch invalidates the receipt. The benchmark never substitutes
the checkout SHA for the measured target build.

Then read:

```sh
tests/bench/scorecards/latest.md
```

`bench:all` runs speed, memory, the blind governance review, then scoring. Speed writes `tests/bench/latest/speed.json`; memory writes `tests/bench/latest/memory.json`; governance writes `tests/bench/latest/governance.json`; scoring writes `scorecard-<version>-<sha>.json`, a matching `.md`, and refreshes `latest.md`.

The speed track includes dashboard cold and warm HTTP timing, the desktop
workspace's splash and reveal boundaries, API request fan-out during boot, the
largest Resource Timing queue wait before an API request starts, and direct
latencies for `/api/panel/branches` and `/api/runtime/inventory`. Browser timing
uses a fresh headless Chrome profile against the running build. If Chrome, the
server, or a registered repository is unavailable, the scorecard records a
named missing measurement instead of substituting a number.

## Interaction Track

The interaction track measures the operator-visible interaction loop rather than
service latency: cold shell readiness, warm restored-state relaunch, first
accepted input, the fleet reveal and active-context reveal at fixture scale,
composer input, Design Mode (arm / hover / select / prompt-ready), the fleet
inventory data path, and a bounded idle soak for long tasks, process count,
memory growth and socket count.

```sh
npm run bench:interactions          # quick scale (50 repositories), source stack
npm run bench:interactions:full     # scales 50/250/1000, 15 samples, 60s soak, bounded 10m boot
npm run bench:interactions:release -- --archive-sha256=<64-hex> --release-git-sha=<40-hex>
```

`npm run bench:speed` does NOT run this harness — it prints a pointer to it.
The service-speed lane stays short on purpose; `bench:quick` is the command that
runs both and writes the combined artifacts.

It generates a deterministic fleet fixture (scale + seed → stable digest) plus a
seeded local fixture page for Design Mode, boots an isolated stack against them
on free ports, and drives the real `/dashboard` surface in headless Chrome. It
never reads or writes `~/.o8` and never touches the installed app's data.

Two target lanes:

- **source** (default) — builds the stack from this checkout.
- **release** — runs the exact packaged server out of a shipped `.app` bundle
  against an isolated data dir. This is the lane that produces per-release
  baselines; two source stacks from one checkout are not two releases. Release
  runs also require the release archive SHA-256 and full 40-hex commit SHA. The
  explicit commit is part of the target digest; any non-null server-reported
  commit is preserved separately and must match it.

Terminal keystroke-to-paint at N=1/4/12 and rapid tab/pane switching are NOT
re-derived here. The receipt **composes** the operator-locked terminal-workload
lane (`tests/bench/results/terminal-workload-phase2.json`), re-runs its locked
budget check, and reports the result with provenance — a weaker composer metric
must not stand in for it.

Three properties make the receipt trustworthy:

- **Phase attribution.** Server wait, input delay, main-thread work and
  presentation come from Navigation, Resource and Event Timing. React's commit
  phase is not separately exposed by the platform, so it is an explicit null
  with that reason rather than an invented split.
- **A falsification probe.** Every run replays the exact trusted keypress and
  paint observer on a harness-owned textarea with a deliberate main-thread
  stall injected, records how many times the injector executed, and requires
  the budget evaluator to reject it. A skipped probe, zero/missing execution
  proof, or a delay that changed nothing is `invalid` and cannot write a
  baseline.
- **Cleanup proof.** The receipt records that no processes, ports, fixture data
  dirs, owned tmux sessions or worktrees survived the run. Residue is `invalid`.

The scenario order is fixed and is part of the measurement contract — changing it
changes the numbers and invalidates comparison with earlier receipts.

Absolute budgets, the reasoning behind each threshold, the release-baseline
procedure, the artifact contract and the status ladder live in
[`docs/operations/interaction-performance-budgets.md`](../../docs/operations/interaction-performance-budgets.md).
Budgets are PROVISIONAL until two release baselines exist and the operator locks
them. Absolute budgets only apply to `production` and `packaged` builds; a
`next-dev` measurement is recorded with its value and an explicit unavailable
reason, never a pass.

Run governance alone with:

```sh
npm run bench:governance
```

The governance command preflights 20 committed patch fixtures through TypeScript and ESLint, shuffles and neutrally labels them, and sends only task, acceptance criteria, and diff to the active AI reviewer. It records planted defects caught, clean diffs blocked, clean diffs with any finding, and inconclusive reviews with explicit denominators. It then refreshes the version-stamped scorecard. The result measures the AI review tier, not the human approval gate above it.

## Thresholds

- Latency metrics in milliseconds use an absolute ±25ms unchanged band.
- Interaction metrics use per-metric noise bands (see the budget manifest); a
  keystroke moving 1ms is noise, a tab switch moving 90ms is not.
- Accuracy and rate metrics from 0 to 1 use an absolute ±0.05 unchanged band.
- Judge variance is roughly ±5pp, so the ±0.05 threshold suppresses normal noise.
- `socket_avg_conns` is informational and never receives a regression tag.

## Coding Track

The coding track runs paired raw and contract-first arms for the two initial
runtime families. Every arm receives the same task, base, repository rules, one
turn, and timeout. A task is scored only when all four arms pass the independent
mechanical gates and both blinded judges return complete verdicts.

The same collection also runs a separate shipped-output experiment on issues
#1676, #1678, and #1679. It compares two single-pass ad-hoc diffs with the diff
that survives real mission dispatch, auto-review, and up to three normal
refix-and-review attempts. The governed artifact is the diff whose current HEAD
has a durable approved review, including any required contract coverage. It is
review-approved output, not merged output. The exact `main` commit is recorded in the receipt, and judging aborts
if worktree, mission, packet, lane, branch, or review-artifact provenance survives
blinding. Collection requires the `always` approval posture so the real pipeline
cannot merge while the benchmark captures the reviewed diff; the runner never
approves a card or invokes merge preview.

Preflight without launching workers:

```sh
O8_BENCH_RUNTIME_CONFIG=/path/to/runtime-config.json npm run bench:coding
```

Collection and judging are separate so the paid phase is explicit and its raw
artifacts remain inspectable between phases:

```sh
O8_BENCH_RUNTIME_CONFIG=/path/to/runtime-config.json npm run bench:coding:collect
O8_BENCH_RUNTIME_CONFIG=/path/to/runtime-config.json npm run bench:coding:judge
npm run bench:score
```

The operator-supplied JSON file is required for paired preflight, collection,
judging, and `bench:coding:all`. It declares requested launcher settings without
embedding model names in the repository:

```json
{
  "schema": "o8/coding-runtime-config/v1",
  "arms": {
    "codex": { "model": "operator-selected-codex-arm", "effort": "high" },
    "claude": { "model": "operator-selected-claude-arm", "effort": "high" }
  },
  "judges": {
    "codex": { "model": "operator-selected-codex-judge", "effort": "high" },
    "claude": { "model": "operator-selected-claude-judge", "effort": "high" }
  }
}
```

Each runtime can use a different model or effort, but its raw and contract arms
always receive the same declared pair. The collection receipt snapshots all
requested settings before an arm starts. The judging receipt snapshots judge
settings before a judge starts and rejects a config that differs from the
collection snapshot. These are requested-setting receipts, not proof of the
effective backend model or usage.

The default run ID is `contract-v1`. Set `O8_BENCH_RUN_ID` before both commands
for later repetitions. Collection refuses to overwrite an existing run ID, so a
failed or unfavorable run remains in the receipts instead of disappearing.

`npm run bench:coding:all` runs collection and judging in one operator-triggered
command. The runner writes its receipts under the system temporary directory and
the decoded result to `tests/bench/latest/coding.json`. The fixed tasks and rubric
must not be edited after a run starts; record any deviation instead.

The shipped-output experiment can run independently with a fresh immutable run
ID, so a valid paired collection is not recollected or overwritten:

```sh
O8_BENCH_RUN_ID=<fresh-id> npm run bench:coding:e2e:preflight
O8_BENCH_RUN_ID=<fresh-id> npm run bench:coding:e2e
O8_BENCH_RUN_ID=<fresh-id> npm run bench:coding:e2e:judge
```

Standalone judging writes `tests/bench/latest/coding-end-to-end.json`, including
cost receipts, every invalid arm and its reasons, the three-attempt review bound,
and all recorded review findings. Collection and judging receipts under the run
directory remain immutable. The standalone shipped-output experiment retains its
versioned v1 launcher behavior and does not read the paired runtime config.

If governance is absent for a release, the scorecard records it as `automated — not run this release`. If coding is absent, the scorecard records it as `operator-triggered — not run this release`.

### Activity during transcript streaming

The focused interaction scenario reuses the isolated stack, fixture and browser lifecycle above. Run it against a production build with `node scripts/bench/interactions/activity-stream-refresh.mjs --samples=3 --ticks=12 --output=tests/bench/latest/activity-stream-refresh.json`. Add `--browser=/path/to/chromium` when discovery is unavailable. It records client list requests over first and warm streaming windows, preserves mounted message identities and the unsent draft, and verifies mixed review-batch refresh plus fresh transcript delivery and message identities after transport reconnect. Bind the production artifact to its source with sealed build receipts; a checkout HEAD alone does not identify an existing bundle. Provider histories and read responses are simulated; this is not a live model or installed-native measurement. The zero-extra-read gate is intentionally falsifiable: `--negative-control` reinstates the obsolete list reads in the disposable page and must exit nonzero. Preserve raw receipts and compare matching builds, workload and machine.

### Long transcript browser workload (#2163)

Use the existing transcript runner, loading the original production components
from the baseline commit without changing the worktree:

```sh
node scripts/bench/interactions/transcript-tab-reuse.mjs --long-history --samples=3 --source-ref=<baseline-commit> --label=before --output=work/2163/before.json
node scripts/bench/interactions/transcript-tab-reuse.mjs --long-history --samples=3 --label=after --baseline=work/2163/before.json --output=work/2163/after.json
```

`--source-ref` substitutes TranscriptNavigator, TranscriptTurns and ChatMessageList; keep the
checkout and dependencies identical for the paired run. `--check` exits nonzero for missing correctness evidence or a missed target.
The absolute limits are warm switch <100 ms, cold component mount <300 ms,
streaming input p95 <16 ms, and no scrolling long task >50 ms. Before judging a
candidate, also require no increase in p95 relative to the matching baseline;
receipts preserve every sample and ratio, including failures.

Each of two histories has 5,000 deterministic messages: 1,000 each of prose,
Markdown (including a table), TypeScript, unified diffs, and fenced tool output.
The fixture records JSON UTF-8 payload bytes, SHA-256 and content counts. Each run
collects one first-visit component switch, six retained switches, 239 frame
intervals traversing the entire history in both directions, and 30 trusted keys
per foreground/background 50 ms fixture stream. It uses the real ChatMessageList
and ComposerArea, the existing input-to-next-frame observer, browser ownership,
and distribution utilities. An injected 80 ms key handler must exceed the same
16 ms input limit. The runner retains drafts and selection and checks native text
selection, the production copy action, composer keyboard selection and prompt
jumping. Hidden stream tails are verified through reveal, outside the measured lane.
Add `--profile-input` for input CPU summaries. Raw samples stay in `work/`;
only the under-60-line [summary](receipts/2163/summary.md) is checked in.

These are **browser component receipts**. Cold means the first component mount
with history already in memory; server loading/transfer, persisted cold-state
restoration, full-dashboard subscriptions, native worker output, installed macOS
behavior, hardware/display qualification, and native lifecycle cleanup remain
separate acceptance items. A next-frame acknowledgement is a conservative browser
paint observation, not display scanout. Do not lower the requested input threshold
or silently replace this observer to make a 60 Hz run pass.
