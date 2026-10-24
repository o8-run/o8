# Local speed baseline

This harness is deliberately outside CI. Run from the worktree with an existing
dependency installation. It never installs packages, controls an installed app,
uses its ports or socket, or writes to its o8 data directory. Evidence, synthetic
repositories, profiles, and credential copies stay under the selected worktree
output directory. Keep raw evidence private: heaps and runtime logs can contain
credentials, transcripts, and local paths.

Build the web application with a disposable data root. Clear any inherited
database override before building:

```sh
mkdir -p tmp/speed-evidence/build-data
env -u CORTEX_IDE_DB_PATH O8_DATA_DIR="$PWD/tmp/speed-evidence/build-data" CORTEX_IDE_DATA_DIR="$PWD/tmp/speed-evidence/build-data" npm run build
node scripts/speed/run.mjs --output=tmp/speed-evidence/baseline.json > tmp/speed-evidence/stdout.json
```

The default is three server/browser runs with a one-hour soak per run. Soaks
overlap to bound elapsed time; record that contention when comparing results.
`--workers` adds three real Codex and three real Claude Code dispatches using
the existing sign-ins, explicitly pinned models and medium effort. This consumes
normal provider allowance. Each worker receives a local fixture and an immediate
reply task; the harness interrupts only its own returned session. Codex mutable
state uses a selected throwaway identity with a private copy of the sign-in.
Claude Code uses the adapter's normal isolated worker configuration.

Use `--soak-ms=0` for a smoke run. It reports `complete:false` and does not count
as an hour-long baseline. `--build-mode=next-dev` measures development compilation
overhead instead of the optimized source build. Do not run competing builds or
test suites while collecting comparable latency samples. Headless Chromium is
launched with its own profile; existing browser windows are not used.

Each sample records server spawn to the first fully read successful health
response, navigation to an editable composer, browser paint entries, three
alternating one/four-stream rendering windows, frame gaps, Long Tasks, CDP task,
script and layout time, and trusted composer keydown to a subsequent frame.
The fixed 300-entry histories use simulated provider snapshots at 20 Hz during
stress and 1 Hz during the soak. They travel through the real dashboard history
consumer and renderer. This is a lab workload, not a claim about natural provider
cadence or a replay of an operator's private history. All four tabs remain open
in both arms. Receipts record the actual subscribers: when hidden chat tabs
unsubscribe, four producers do not imply four delivered streams. Such a result
cannot measure the cost of rendering hidden streams.

Ten read-only MCP operations run over `/api/mcp`, with 30 interleaved samples
per operation. The first call is separate from the warm distribution. HTTP,
JSON-RPC, and tool-level errors fail collection; they cannot become fast samples.
All durations use milliseconds. Median averages the middle two samples for even
counts; p95 uses the nearest rank. Empty observations are null, never zero.

The process hook records command basenames, bounded Git operation names, spawn,
exit and first-output timestamps. It records no arguments or output. Worker
JSONL observation runs every 50 ms. A full assistant message is an upper bound
on the first model token and is labeled as such. A dependency-free fixture does
not establish production repository provisioning time.

Separate lanes are available. `ui-run.mjs` collects three browser runs with
three repetitions of each streaming arm. `ui-run.mjs --boot-only` collects
three server/browser launches. Input uses an observer-ready handshake before
the trusted key; a fixed sleep is not a readiness signal. `worker-run.mjs
--runtime=codex` and `--runtime=claude-code` collect three dispatches and their
persisted admission and worktree-stage events. The worker fixture requires no
dependency install. The component calibrations below compare the production
workspace guard with direct Git, and the production APFS clone with this
worktree's real dependencies. Only the receipted cloned copies are removed.

```sh
node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/speed/guard-cost.mjs
node --import ./scripts/register-server-only-stub.mjs --import tsx scripts/speed/dependency-clone.mjs
node scripts/speed/self-check.mjs
```

The self-check exercises real local HTTP failures and a child process, including
the multi-result promisified `execFile` contract. A 120 ms injected delay must
fail an 80 ms calibration budget. These controls validate the instrument without
adding a CI ratchet.

The Next and WebSocket processes expose inspectors only on ephemeral loopback
ports. The default takes a private Next heap snapshot after recording hour RSS,
and samples post-GC heap usage. `--paired-heaps` adds a before snapshot for graph
comparison, at the cost of perturbing subsequent RSS: the baseline control
measured roughly 277 MiB added RSS from taking a snapshot alone. The published
baseline used paired snapshots; do not subtract that separate control from an
individual process's RSS. Heap summaries contain shallow
bytes by type/constructor, not retained sizes. Inspect raw retaining paths in
DevTools before naming a retaining cache or declaring a leak. RSS includes
allocator retention and shared mappings; RSS growth alone is not a leak verdict.

For a separate native measurement, first export this worktree's web resources
and build its custom-protocol debug binary with `dev-mcp-plugin`. The native
test contract requires private data, ports outside the runtime-reserved ranges,
and a private socket, and skips production cleanup, hotkeys, saved window state
and autostart. Optional speech sidecars can be excluded from this local build:

```sh
node scripts/speed/build-native.mjs
```

This uses ad hoc dependency signatures and a separate native application
identifier, so native plugin stores cannot use the installed app's namespace.
It attests the binary hash and makes `out/server` available beside it. Then:

```sh
node scripts/speed/native.mjs --binary=src-tauri/target/debug/o8 --output=tmp/speed-evidence/native.json > tmp/speed-evidence/native-stdout.json
```

Use `--startup-only` for three sequential startup samples, closing each owned
instance before the next. It skips memory workloads and cannot complete the
hour-long acceptance check. Keep this population separate from overlapping soaks.

Only a binary and socket inside this worktree are accepted. The native runner
launches three disposable instances, checks input acceptance in their WebKit
windows, and records process RSS and private `vmmap` summaries. It persists
bounded synthetic provider logs, then requests history through the authenticated
WS bridge. The real log parser, HTTP history endpoint, WS transport and WebKit
renderer consume those logs. The bridge limits a snapshot to 200 entries.
Fixture metadata receives an activity heartbeat so the idle reaper does not
retire the workload. Per-minute receipts check visible transcript progress.
Inspectors collect post-GC heap usage and private Next snapshots under this same
native workload. The build helper adds a Paint Timing observer to the generated
loader, with a two-rAF acknowledgement fallback. A private loopback listener
receives its FCP epoch timestamp even before dashboard navigation. This measures
WebKit FCP, not the OS compositor's presentation. Native health probes run from
launch; accepted composer input remains a polling upper bound. A 150 ms stall
calibrates the browser input instrument in every UI run.

Do not export resources while a native run is active. `--reuse-export` on the
build helper keeps existing server resources when only rebuilding the loader
probe and binary. It is for a previously exported build from the same source.

`native-allocations.mjs` uses a separate attested diagnostic instance with malloc
stack logging enabled at launch. Its measurements are excluded from latency and
soak comparisons. It never enables logging on an installed application.
`allocation-summary.mjs <owned-malloc-history>` streams an existing private dump
and emits only numeric matcher/regex allocation groups. `snapshot-cost.mjs`
measures the heap profiler's own RSS perturbation in three disposable servers.
`heap-paths.mjs <owned-snapshot>` computes shortest strong retaining paths offline;
it omits string contents and does not claim dominator-retained sizes.
`summarize.mjs` combines explicitly selected receipts into JSON distributions.

On macOS, `ws-cpu-idle.mjs` measures the CPU sampler's idle cost in six disposable standalone
WS servers, three with sampling on and three with `cpuSampler: false`. It builds
one implementation bundle using the standalone esbuild settings and injects only
the sampler selection for the two arms. All six runs overlap, sharing host
contention. Each has a private home, data directory and empty repository, with
loopback-only networking, no Next sibling and no clients. After a 60-second
warmup, it records process CPU-time deltas and RSS every five seconds for ten
minutes. CPU percentages use one core as 100%; settled RSS is the median of the
last five minutes. No external inspector, heap snapshot or forced GC perturbs
the measurement. Use a fresh output directory and keep raw logs private:

```sh
node scripts/speed/ws-cpu-idle.mjs --output=tmp/speed-evidence/ws-cpu-idle
```

The receipt includes all observations, per-run median CPU, whole-window mean
CPU, settled RSS, the executing bundle hash and the median-of-runs differences.
The idle budget permits default-on sampling only below 0.5 CPU percentage points
and 5 MiB added RSS. Its `complete` field requires all six ten-minute runs.
Do not run builds or tests during collection.

Normal servers keep CPU profiling off. Set `O8_WS_CPU_EVIDENCE=1` before starting
the WS server to enable sampled lag call-site evidence. Timer-based lag and
wedge counters remain active with profiling off.

Review the JSON's failures, sample counts, calibration, and workload limitations
before comparing medians or worst cases. The main baseline's `complete` requires three full soaks;
it does not assert that every original #2887 acceptance criterion is complete.

## WS replay memory

With Node 22, `node scripts/speed/ws-replay-memory.mjs --check` builds the
standalone WS entry point and drives its internal realtime publisher with 3,600
large synthetic events. It owns disposable data, repository, profile and API
fixtures. The default accelerates one hour of event timestamps; the receipt
records actual elapsed time. Use `--interval-ms=1000` for a wall-clock hour.
`--output=work/ws-replay-memory` selects the private evidence directory.

Collect RSS and heap evidence in separate runs. `--snapshots --settle-ms=2000`
adds idle/loaded heap snapshots and sanitized retaining paths; those RSS values
are marked incomparable because snapshot allocation changes residency. Ordinary
runs settle for 45 seconds before each measurement and record memory both before
and after explicit collection. The 150 MB check uses settled idle RSS before collection and loaded RSS after
collection; the receipt also retains the raw loaded RSS. `--entry=<bundle>` can measure an already-built baseline artifact.
Keep the raw snapshots private, as with the other speed probes above.

The streaming acceptance check runs the real dashboard with the same 300-entry,
20 Hz fixture and three alternating windows for each producer count:

```sh
node scripts/speed/streaming-check.mjs --output=work/streaming-check --trace
```

It rejects main-thread medians of 100 ms/s or more, input p95 of 50 ms or more,
censored inputs, stalled visible text, changed message order or scroll pinning,
and a missing 150 ms input calibration. `--trace` adds separate CDP timeline and
V8 profiles after the untraced latency windows. Keep these raw artifacts private.
The fixture now uses a native loopback WebSocket through the runtime port
resolver; DevTools frame injection added renderer work to the earlier probe.
The composer probe acknowledges the first frame after its changed value was
painted, without an additional wait frame. Compare revisions using the same
probe version, and retain the original probe results separately.

## Account-free worker dispatch

Run the existing scheduler launch-budget fixture three times with its real owned
runtime, persisted lane events and stdout observation. The fixture installer and
runtime executables never contact a provider. The same `persistedWorkerStages`
observer used by `worker-run.mjs` records admission, workspace preparation,
dependency preparation and the persisted run-start boundary. Fixture stdout is
verified before recording the result; the fixture's adjacent timestamp is an
upper bound on its first output. `spawnToOutputMs` uses the persisted run-start
timestamp, not a kernel spawn timestamp.

```sh
node scripts/speed/dispatch-fixture.mjs --output=work/worker-launch
```

For the Linux ws-event-loop regression, run:

```sh
node scripts/speed/dispatch-fixture.mjs --soak --output=work/ws-work-soak
```

This repeats the real delegate-route fixture three times. Each repetition launches
three owned fixture workers, reviews and merges their commits into a local Git
origin, and runs the worktree reaper alongside the merges. A symbol-rich skeleton
cache uses the scanner's 2,000-file ceiling. No accounts or network are needed.
The receipt includes max delay, p99 delay, wedge count and bounded CPU summaries.
At 10ms sampling resolution, each measured phase must stay below 250ms max and
50ms p99 with zero wedges. The summary reports the worst phase p99, so a quieter
phase cannot hide a slow merge. Run this timing fixture separately from expensive
checks. The ordinary fixture mode above continues to measure scheduler launch.


To include a private copy of this checkout's installed dependency payload in
each measured dispatch, add `--payload=node_modules`. The fixture copies those
files without preserving external hardlinks and audits the resulting tree.
These runs cover the Linux native-install fallback, with fixture package-manager
execution; they do not establish physical block sharing, reference macOS timing,
real package-manager installation time or provider first-token latency. Private
logs and numeric receipts stay in the selected evidence directory. Any failed
regression or incomplete sample makes the harness exit nonzero. Compare the same
payload and run the before and after arms without competing builds or tests.


## Account-free warm packet dispatch

Warm preparation is currently eligible only on Linux linked Git worktrees when
the entire workspace filesystem reports a capacity of at most four GiB. Larger
filesystems and APFS clones use cold provisioning. This conservative gate does
not provision a per-directory quota; dependency-cache accounting remains
separate. The fixture models the bounded-filesystem capability for its controlled
repositories. Its latency receipts do not prove a physical quota or that warming
is enabled on the host filesystem.

`dispatch-fixture.mjs` drives `runDispatchTick` with a fixture installer and owned
runtime executable. It verifies persisted worker stdout, lane preparation events,
private dependency writes, the consumed directory inode and shutdown cleanup.
The fixture emits immediately and stays alive until its returned session is
interrupted through the runtime router; cleanup checks that no process remains
inside its owned repository. It never uses a provider account. Freeze one payload
outside the source checkout before comparing arms: test caches can change an
active installation, and source scanners can traverse a copied payload inside
the checkout. Run both arms sequentially without competing builds or tests:

```sh
node -e "require('node:fs').cpSync('node_modules', '../work/launch-payload', { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false })"
node scripts/speed/dispatch-fixture.mjs --payload=../work/launch-payload --cold --output=work/launch-cold
node scripts/speed/dispatch-fixture.mjs --payload=../work/launch-payload --samples=5 --output=work/launch-warm
```

Each arm defaults to three disposable fixture repositories; `--samples=5` checks
five consecutive launches. Large-payload timing uses
one configured entry, which the measured packet consumes. The small lifecycle
variants use the default two entries and verify unused-entry shutdown retirement. The optional installed
payload is copied privately; the fixture manifest is synthetic. A warm dispatch
must record zero dependency preparation and reach fixture output in under three
seconds. Cold dispatch retains the existing provisioning path. Numeric receipts
and private logs stay under the selected output directory. These measurements do
not establish provider startup, real package installation, macOS volume sharing
or the mission CLI wait-window contract.

The pool reserves at most two durable global slots before creation, reconciles every
authoritative metadata root at restart, and keeps failed or uncertain cleanup
charged. Unreserved legacy trees block new preparation. Preparation uses normal
storage admission and refuses an unbounded workspace filesystem before starting
an installer. Entries contain private native dependencies and verified internal
link chains. Mounted images and private Git/APFS clones are ineligible.
Main, lockfile, setup contract, platform and runtime ABI select a
generation. Entries are consumed once; dispatched worktrees never return to the
pool. Refills run asynchronously, with installation outside the shared Git
provision queue. New background preparation waits five seconds after foreground
workspace creation to reduce child-helper contention during worker startup.
WS shutdown awaits active transfers and preparation, then uses
the existing exact retirement path for unused entries.

A successful, quiescent preparation receives one immutable byte/content and
identity seal covering ignored/untracked files and linked Git administration.
Binding rechecks that seal, the expected Git transition and fresh process state.
Only the original pristine seal authorizes retirement; claims retain that proof
through rename, purge capture and replay. Unsealed, edited or uncertain trees
remain retained. Full inventory verification adds latency; keep failed speed
samples when evaluating the three-second target.

Additional hermetic variants use the same test entry point:
`O8_SPEED_INVALIDATION=main` or `lock`, `O8_SPEED_BINDING_FAULT=1`,
`O8_SPEED_INODE_SWAP=1`, `O8_SPEED_ABSOLUTE_LINK=1`,
`O8_SPEED_REMOTE_MAIN=1`, `O8_SPEED_HOOKS_FAULT=inode` or `content`,
`O8_SPEED_CONCURRENT=1`, and `O8_SPEED_COLD_DURING_REFILL=1`.
`O8_SPEED_POLICY_CONTENTION=1` checks the moved Git/index/HEAD binding, bin and
runtime paths, settings inode/environment and refill ordering, then holds the
real credential-policy coordination lock for 200 ms during child startup.
The child must acquire the lock and revalidate policy before producing output;
the fixture's stdout deadline is unchanged.

`O8_SPEED_WARM_ADVERSARY` selects preservation and lifecycle probes:
`dirty-shutdown`, `dirty-invalidation`, `dirty-purge`, `unsealed`, `git-admin`,
`live`, `live-purge`, `live-purge-paused`, `dependency-link`, `dependency-bytes`,
`env`, `moved-head`, `installer-chain`, `apfs-exclude`, `budget`, `restart`,
`disabled`, `disabled-registry`, or `metadata-revoked`. `O8_SPEED_MAC_ASSERTIONS=1` exercises the
portable cold-selection assertions; it does not validate macOS filesystem behavior.
