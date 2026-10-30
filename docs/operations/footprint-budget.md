# Packaged-app footprint budget

The packaged application has a versioned, repeatable resource receipt. The real WebView boot gate launches the built application with isolated ports and an isolated data directory, waits for the dashboard to hydrate, hides and verifies the main native window, allows a one-minute startup cooldown, observes the stable process set for fifteen seconds, and records physical memory, interval CPU, process churn, bundle size, and isolated state size.

The receipt is written beside the tested application as `footprint-receipt.json`. An authoritative release also stores the summary in the existing pre-ship audit record.

## Budget v4

Targets express the product goal. Regression ceilings are hard stops for the approved release policy. A build may remain above a target while cleanup proceeds, but it may not become materially worse.

| Metric | Target | Regression ceiling |
|---|---:|---:|
| Installed application | 250 MiB | 350 MiB |
| Update archive | 75 MiB | 110 MiB |
| Idle physical footprint | 1 GiB | 1.5 GiB |
| Idle interval CPU, whole tree | 5% | 15% |
| Native host idle CPU | 2% | 5% |
| Application server idle CPU | 5% | 12% |
| Realtime server idle CPU | 5% | 8% |
| New WebKit helpers idle CPU | 1% | 10% |
| Idle process churn | 0 | 0 |
| Native host physical footprint | tracked within total | 640 MiB |
| Application server physical footprint | tracked within total | 512 MiB |
| Realtime server physical footprint | tracked within total | 256 MiB |
| New WebKit helpers physical footprint | tracked within total | 512 MiB |
| Persistent operator data | 1 GiB | reported separately |

The hard memory ceiling is deliberately above the product target because long-running measurements can exceed the target. Lowering the ceiling before the implementation is lighter would turn the gate into a permanent bypass request instead of a regression check. CPU is budgeted both per component and across the whole tree; the earlier 2% target describes the native host, not the sum of every application and WebKit process.

The shared package ceilings are 350 MiB installed and 110 MiB compressed, approved while dependency and export reduction continues under #3545. The compressed ceiling rose from 100 MiB in 0.1.815, when o8 next (a universal binary of about 52 MB) became the packaged app's window and the archive measured 100.25 MiB. Signing and native footprint checks use the same limits for all versions and release channels. Version-specific package allowances are no longer needed.

The 250 MiB installed-app and 75 MiB archive targets remain unchanged. Runtime dependencies, both macOS architectures, native prebuilds and license files remain included. Memory, CPU, ownership, integrity, signing and notarization checks are unchanged. Packages above the shared ceilings still fail before signing or publication.

## Metric contract

- Physical memory comes from the macOS `footprint` tool, not RSS. The native host and its process descendants are included.
- WebKit helpers are reparented by the operating system. The gate snapshots WebKit helper process identities immediately before launch and attributes only helpers created afterward during the isolated run.
- CPU is the change in process CPU time divided by the fifteen-second wall-clock observation after the main window is hidden and the startup cooldown completes. It is not the lifetime average reported by `ps %cpu`.
- Process churn is any owned process identity that appears or disappears during the observation. The normalized spawns and exits per minute remain in the receipt.
- Churn diagnostics report component counts plus a retained sanitized identity for every spawned and exited child. An identity carries the component, a descriptor drawn from a closed vocabulary, the depth from the native host, and the parent component — nothing else. Raw commands, home paths, tokens, machine names, and pids never enter the receipt, and no field is *derived* from the command either: a digest of a secret-bearing argv is still derived from the secret, and any fingerprint the sanitized fields could justify is already determined by those fields. An unrecognized command becomes `unclassified`, which means two different unknown children are deliberately indistinguishable; the vocabulary is the resolution limit. The list is content-sorted and capped at 64 entries with `truncatedIdentityCount` recording the remainder.
- A child that exits between the final process-table snapshot and its `footprint` probe is excluded from the live memory total and increments `physicalMeasurementSkippedProcessCount`. A probe error for a process that remains live still fails the gate.
- Installed size uses allocated filesystem bytes. The update archive uses its file size.
- The gate's data-directory number describes a fresh isolated launch. It must not be presented as a long-lived operator-data measurement.

## Repeated idle samples

One reading is an anecdote. `O8_FOOTPRINT_IDLE_SAMPLES` takes consecutive hidden-idle observations of the same already-running application, so the receipt carries a distribution instead of a single lucky number.

- Default `1`; bounded at `5`. A non-integer, zero, negative, or over-bound value fails the gate rather than being clamped, because a silently reduced sample count would misreport how much evidence exists.
- Every sample observes the same launch of the same binary. Each receipt carries a 16-character `artifactDigest` over the packaged Mach-O's **actual bytes** plus the build identity, read in bounded chunks so a large binary never lands in memory at once. Size and modification time are not enough: a rebuild landing the same length, or a touched file, would let two different binaries share one digest and let a series claim one artifact when it measured two. The series refuses to aggregate samples whose digest, version, git SHA, or scenario differ.
- The series receipt is `schemaVersion` 2: `samples[]` holds per-sample metrics, verdict, and checks; `aggregate` holds min/max/mean/median per metric plus the worst check per metric. For backward compatibility, `metrics` retains the highest-memory single sample; it is not mislabeled as worst for metrics that may peak in another sample. The gate reads the per-metric aggregate checks, so an averaged spike cannot pass.

## Loaded N-lane scenario

The loaded number requires real lanes: real worker processes, real worktrees, real listeners. The gate will only produce one under explicit opt-in against a disposable repo, and never approximates it.

| Variable | Meaning |
|---|---|
| `O8_FOOTPRINT_LOAD_LANES` | Lane count, `1`–`4`. Unset or `0` means the loaded number is not measured. |
| `O8_FOOTPRINT_LOAD_REPO` | Disposable repository the lanes run against. Refused when it resolves inside the live `~/.o8` profile. |
| `O8_FOOTPRINT_LOAD_RUNTIME` | Worker runtime id, default `codex`. |

A runtime id is not an executable name — `claude-code` runs `claude`, `cursor` runs `cursor-agent`. The scenario supports an explicit subset (`codex`, `claude-code`, `gemini`, `cursor`, `grok`) and probes the mapped binary; `tests/footprint-load-route-path.test.ts` binds every row to the product's own `ORCHESTRATOR_RUNTIMES` capability table, so a `binaryName` change in the app fails the test instead of silently probing the wrong executable. Any other runtime id is refused with `runtime-not-supported-by-load-scenario`.

When any prerequisite is missing, the receipt records `loadScenario.available: false` with one explicit reason — `not-requested`, `load-repo-not-configured`, `load-repo-missing`, `load-repo-not-isolated`, `runtime-not-supported-by-load-scenario`, `worker-runtime-unavailable`, `api-token-unavailable`, `pre-existing-lanes`, `lanes-did-not-reach-active`, or `residual-state-preserved`. There is no substitute measurement and no synthetic load. An absent loaded number stays absent.

### What the run does, and what it refuses to do

The scenario creates one mission carrying N read-only lanes through `/api/orchestrator/create-mission`, captures the returned mission id and packet ids **before** dispatching, and gives each worker a bounded five-minute read-only hold so sequential worktree materialization cannot finish lane one before lane two starts. The harness waits until those packets have both active lane records and live runtime processes in their scoped worktrees, samples the loaded footprint with the same sample count as the idle series, and then stops exactly those packets. A stale `running` row without its worker process does not count as load.

- **Scoped teardown.** Release is one `/api/orchestrator/stop-packet` call per captured `packetId`. The scenario never calls the `all: true` form, so a lane it did not create is never stopped — not even inside an isolated stack. Because stop acknowledges confirmed worker death before its archive/prune phase finishes, the harness waits within its drain budget for that exact packet to leave the active set.
- **Never a direct delete.** Worktree cleanup stays inside the existing stop/reset control plane, which preserves recoverable branch state before cleanup. The harness never invokes Git worktree removal itself and never follows stop with a racing close request.
- **Preserved state is reported, not erased.** After lane archival, the harness waits within the drain budget for owned child processes, worktrees, and listening ports to return to the pre-run baseline. Anything still surviving is reported as `residual-state-preserved` with bounded, sanitized identities: a truncated digest per worktree and lane, a closed process descriptor, and a fixed listener descriptor. Raw paths, packet ids, commands, ports, machine names, and credentials never enter the receipt. The gate fails *after* the receipt is written, so the evidence survives the failure. A leaked lane invalidates the measurement; deleting someone's work to make the gate green is not a remedy.
- **Lane liveness follows the product.** A lane counts as load until it reaches the app's own lane-terminal set (`failed`, `completed`, `archived`), asserted against `LANE_TERMINAL_STATUSES`.

Every route response is read from the `{ ok, result }` envelope the operator routes actually serve, and that contract is exercised through the real handlers with real persisted state in `tests/footprint-load-route-path.test.ts` — creation, scoping, per-packet teardown, residual sweep, and the real `not_found` status response before any mission exists.

Loaded metrics are recorded, not gated. Budget v3 has no loaded ceiling because no loaded baseline exists yet; inventing one from the first run would be a number chosen to pass rather than a measurement.

### Shortest executable acceptance lane

```bash
# 1. a disposable clone, never the live profile
git clone --local . /tmp/o8-footprint-load && (cd /tmp/o8-footprint-load && git worktree list)

# 2. idle distribution + a two-lane loaded run against the built app
O8_FOOTPRINT_IDLE_SAMPLES=3 \
O8_FOOTPRINT_LOAD_LANES=2 \
O8_FOOTPRINT_LOAD_REPO=/tmp/o8-footprint-load \
O8_FOOTPRINT_RECEIPT_PATH=/tmp/footprint-receipt.json \
  npm run gate:webview

# 3. read the receipt: three idle samples, a loaded block, and the teardown report
node -e "const r=require('/tmp/footprint-receipt.json');const l=r.loadScenario;console.log(r.sampleCount, r.verdict, l.available ? JSON.stringify(l.teardown.residuals.counts) : l.reason)"

# 4. remove the disposable repo ONLY when nothing was preserved inside it
node -e "const l=require('/tmp/footprint-receipt.json').loadScenario;const p=l.teardown?.residuals?.preservedWorktrees??[];if(p.length)throw new Error('preserved worktrees remain; inspect before deleting');" \
  && rm -rf /tmp/o8-footprint-load
```

Expected: `3 PASS {"lanes":0,"childProcesses":0,"worktrees":0,"listeners":0}`. A `reason` string in step 3 means the loaded number was not measured, and names why. If step 4 throws, the run preserved state on purpose — inspect it; do not delete it to clear the error.

Run the real gate against an existing release build:

```bash
npm run gate:webview
```

The release workflow retains its existing opt-in policy for this WebView gate. When enabled, a footprint regression fails the same real packaged-app launch before upload.

## Long-lived state

The 1 GiB persistent-data target applies to a live operator profile, not the isolated release fixture. Managed worktrees already have count and total-size retention controls. Orchestrator session homes contain recoverable caches as well as conversation history, so cleanup must distinguish the two before deleting anything. Until that recovery contract is implemented, the footprint receipt reports state size without pretending a destructive sweep is safe.
