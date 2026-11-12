# Symon WS recovery and startup evidence

Measured on 2026-11-12 for [PR #5986](https://github.com/o8-run/o8/pull/5986), following the store claim from [PR #5990](https://github.com/o8-run/o8/pull/5990).

## Recovery

The fixture loads the real managed-provider module and replaces only `createSymonManagedProvider` in the WS child's CommonJS loader. The real model constants are passed into the `pi-ai` faux provider. The ESM module redirection and constants re-export are removed. No production import or test seam is added.

`tests/o8d-symon-brain-owner-native-real-path.test.ts` leaves a durable model turn pending in a first process, kills that process, and opens the real brain in the real WS server. It checks recovery before resubmitting the request, verifies the provider log contains the WS PID rather than the test PID, and verifies exactly one provider invocation. A competing `SymonBrain.open` is refused by the store claim. Next's real forwarding wrapper returns the same completed request without creating a Next brain singleton. A second WS start opens the same store and leaves the invocation log at one line. Both immediate crash handover and refusal while an old owner remains alive are covered.

This proves one recovery invocation for this persisted turn in this controlled restart sequence. It does not promise transactional exactly-once external side effects after arbitrary crashes.

Negative control: temporarily removing `harness.resume()` produced **2 failed, 4 skipped**, both recovery cases observing an empty invocation log. Restoring it produced **2 passing recovery cases** within a file result of **5 passed, 1 failed**. The remaining native auth sweep lost the public listener with `ECONNREFUSED` while the WS child remained alive; it reproduced twice and is tracked in [#6002](https://github.com/o8-run/o8/issues/6002). The PR remains draft.

## Timing method

Main is pinned to `94a8c74189fa375a2e2a6067356f09d6fd0c2f3e`; the branch production source is pinned to `647c222f4`. Both use identical dependency lockfiles, Node 22.23.3, a clean `npm ci`, the real `src/ws-server.ts` entry point through tsx, and disposable data and Git directories. The matrix sets `O8_NEXT_O8D=1`, with the TypeScript WS listener (`O8_WS_O8D=0`) to isolate WS startup from a daemon restart. Timing runs use the production provider factory, with no provider stub. The empty brain store initializes it without running a model turn. Optional speech installation points at an unavailable fixture interpreter; no pip, account, or desktop is used.

Fresh source copies use `git archive` at the pinned revisions; the first branch pair uses the existing checkout. Review maintenance points at a disposable Git directory in all runs. Each cold sample is the first WS start from its own clean install, with fresh data and an empty task-local tsx cache. Its warm sample immediately restarts the same source, install, data, and tsx cache. Each cell has three samples. Independent installs are batched within the disk bound; timing runs are serial and wait for all owned installs and checks to finish. Other work on the shared host was not controlled, and these measurements do not assign causality to load.

Temporary monotonic timestamps mark process preload, completed static imports, each awaited bootstrap step, listener binding, brain opening, the macOS receiver guard, and full bootstrap readiness. The ready timestamp marks completion of the bootstrap gate. HTTP correctness is checked afterward (`/health` = 200 and `/` = 404); request handling and any lazy route import after that marker are not included in its duration. Main's brain-at-boot cell temporarily inserts the branch's brain/receiver block at the same point after listener binding. The branch's no-brain cell temporarily omits that block. These are diagnostic variants, not shipped behavior. All instrumentation and diagnostic source changes are removed. The listener and full-readiness milestones are distinguished because health alone does not wait for bootstrap.

## Focused verification and decision

- `npm run typecheck:fast`: passed.
- ESLint on the changed test and fixture files: passed.
- `npm run rule-check -- --base=origin/main`: passed, 24 files scanned and zero violations.
- `npm run test:classify`: passed, 1336 hermetic and 1221 resource-owning tests; no classification diff.
- `tests/o8d-symon-brain-owner-native-real-path.test.ts`: 5 passed, 1 failed on each of two correction rounds. Both recovery cases pass after restoring resume. The negative control is 2 failed, 4 skipped.
- `tests/o8d-messages-receiver-native-real-path.test.ts`: 4 passed, 2 failed with listener refusal.
- `tests/o8d-native-route-inventory-real-path.test.ts`: 9 passed.
- `tests/symon-voice-record-real-path.test.ts`: 3 passed.
- `tests/symon-text-say-loop.test.ts`: the uninstrumented run failed at the unchanged 20-second deadline, with 7 skipped. A subsequent run with temporary phase markers and child-output capture passed all 7 tests without changing the deadline or startup order. Its WS child reached readiness 12.687 seconds after the process preload: module load 10.640 seconds, brain open 0.961 seconds, Next readiness 0.046 seconds. The failed uninstrumented run has no phase trace, so its precise crossing remains unproven; the matrix identifies the crossing phases in measured runs.
- The o8d-only debug build passed with four build jobs. Vitest ran one file at a time with at most two workers.

Full local gate skipped on the master seat's instruction. No full suites or `verify:ci` ran. Actual macOS Messages startup, a real Messages database, real provider calls, the full Next application, packaged desktop behavior, and CI are not verified by this evidence. No startup work is moved, deferred, or reordered in production. The remaining native listener failures and cold deadline misses keep this PR draft and WIP; no merge or release is authorized.

## Phase measurements

All times are **median/max seconds**, three samples per cell. Durations are per phase except the explicitly cumulative rows. Phase statistics are independent and need not sum to total. The Messages receiver is skipped on Linux in every cell.

| Phase | main/boot/cold | main/boot/warm | main/no-boot/cold | main/no-boot/warm | branch/boot/cold | branch/boot/warm | branch/no-boot/cold | branch/no-boot/warm |
|---|---|---|---|---|---|---|---|---|
| Node process launch | 0.063/0.063 | 0.057/0.060 | 0.051/0.051 | 0.047/0.069 | 0.084/0.092 | 0.079/0.099 | 0.067/0.074 | 0.052/0.092 |
| Module load | 18.386/19.191 | 3.830/5.166 | 15.532/16.488 | 3.610/3.675 | 23.240/31.527 | 4.840/6.012 | 20.035/24.676 | 3.514/6.086 |
| Module setup | 0.008/0.009 | 0.008/0.013 | 0.009/0.009 | 0.007/0.007 | 0.010/0.012 | 0.013/0.016 | 0.012/0.013 | 0.007/0.011 |
| Project ledger | 0.805/1.023 | 0.081/0.129 | 0.743/1.091 | 0.065/0.084 | 1.076/1.080 | 0.113/0.285 | 0.775/1.574 | 0.106/0.191 |
| Packet credentials | 0.051/0.084 | 0.076/0.093 | 0.057/0.072 | 0.053/0.069 | 0.077/0.091 | 0.080/0.102 | 0.043/0.102 | 0.009/0.058 |
| Listener bind | 0.014/0.015 | 0.012/0.017 | 0.011/0.016 | 0.010/0.012 | 0.018/0.019 | 0.018/0.028 | 0.012/0.017 | 0.011/0.015 |
| Brain open | 1.853/1.905 | 1.164/1.301 | 0.000/0.000 | 0.000/0.000 | 2.210/2.349 | 1.638/1.826 | 0.000/0.000 | 0.000/0.000 |
| Next readiness | 0.000/0.000 | 0.000/0.000 | 0.000/0.000 | 0.000/0.000 | 0.000/0.000 | 0.000/0.000 | 0.000/0.000 | 0.000/0.000 |
| Terminal host | 0.000/0.000 | 0.000/0.000 | 0.001/0.001 | 0.000/0.000 | 0.000/0.001 | 0.001/0.001 | 0.000/0.001 | 0.000/0.001 |
| Approval expiry | 0.000/0.001 | 0.000/0.000 | 0.000/0.001 | 0.000/0.000 | 0.001/0.001 | 0.001/0.001 | 0.001/0.001 | 0.001/0.001 |
| Git prune | 0.105/0.141 | 0.075/0.079 | 0.113/0.128 | 0.065/0.083 | 0.152/0.154 | 0.112/0.143 | 0.099/0.162 | 0.079/0.101 |
| Worktree maintenance | 0.059/0.069 | 0.032/0.038 | 0.063/0.071 | 0.031/0.038 | 0.078/0.081 | 0.047/0.069 | 0.054/0.097 | 0.035/0.046 |
| Merged incidents | 0.022/0.040 | 0.008/0.009 | 0.024/0.026 | 0.007/0.009 | 0.029/0.030 | 0.012/0.013 | 0.027/0.051 | 0.008/0.011 |
| Launch-agent health | 0.041/0.087 | 0.014/0.017 | 0.041/0.054 | 0.014/0.018 | 0.061/0.064 | 0.022/0.024 | 0.052/0.078 | 0.015/0.022 |
| Merged ancestry | 0.061/0.094 | 0.011/0.014 | 0.063/0.083 | 0.012/0.016 | 0.104/0.107 | 0.017/0.023 | 0.060/0.085 | 0.015/0.017 |
| Session rehydration | 0.003/0.005 | 0.003/0.004 | 0.005/0.005 | 0.003/0.004 | 0.004/0.006 | 0.005/0.007 | 0.002/0.004 | 0.003/0.004 |
| Storage admission | 0.030/0.051 | 0.009/0.010 | 0.034/0.038 | 0.009/0.011 | 0.042/0.048 | 0.016/0.018 | 0.027/0.056 | 0.010/0.014 |
| Resource leases | 0.016/0.021 | 0.005/0.006 | 0.017/0.018 | 0.005/0.007 | 0.028/0.037 | 0.008/0.008 | 0.016/0.025 | 0.006/0.008 |
| Dependency images | 0.034/0.060 | 0.011/0.012 | 0.032/0.040 | 0.010/0.015 | 0.049/0.062 | 0.019/0.020 | 0.035/0.059 | 0.012/0.015 |
| Lane reconciliation | 0.096/0.121 | 0.022/0.024 | 0.084/0.086 | 0.021/0.024 | 0.113/0.208 | 0.044/0.044 | 0.084/0.124 | 0.022/0.031 |
| Timer setup | 0.000/0.000 | 0.000/0.000 | 0.000/0.000 | 0.000/0.000 | 0.000/0.000 | 0.000/0.001 | 0.000/0.000 | 0.000/0.000 |
| Remaining service setup | 0.068/0.083 | 0.063/0.077 | 0.068/0.077 | 0.058/0.072 | 0.103/0.142 | 0.123/0.134 | 0.066/0.094 | 0.066/0.091 |
| Listener bound, cumulative | 19.325/20.385 | 4.051/5.479 | 16.381/17.728 | 3.788/3.916 | 24.527/32.781 | 5.163/6.452 | 20.951/26.449 | 3.715/6.404 |
| Full readiness, cumulative | 21.016/23.063 | 5.505/7.034 | 16.927/18.356 | 4.025/4.215 | 27.500/36.056 | 7.245/8.767 | 21.474/27.288 | 3.989/6.765 |
| Messages receiver | skipped | skipped | skipped | skipped | skipped | skipped | skipped | skipped |

Compact handback table (`Other bootstrap` is bootstrap duration minus brain opening):

| Source | Brain at boot | Start | Module load | Brain open | Other bootstrap | Listener bound (cumulative) | Ready (cumulative) |
|---|---|---|---|---|---|---|---|
| main | yes | cold | 18.386/19.191 | 1.853/1.905 | 1.387/1.896 | 19.325/20.385 | 21.016/23.063 |
| main | yes | warm | 3.830/5.166 | 1.164/1.301 | 0.446/0.494 | 4.051/5.479 | 5.505/7.034 |
| main | no | cold | 15.532/16.488 | 0.000/0.000 | 1.335/1.808 | 16.381/17.728 | 16.927/18.356 |
| main | no | warm | 3.610/3.675 | 0.000/0.000 | 0.364/0.464 | 3.788/3.916 | 4.025/4.215 |
| branch | yes | cold | 23.240/31.527 | 2.210/2.349 | 1.949/2.098 | 24.527/32.781 | 27.500/36.056 |
| branch | yes | warm | 4.840/6.012 | 1.638/1.826 | 0.676/0.815 | 5.163/6.452 | 7.245/8.767 |
| branch | no | cold | 20.035/24.676 | 0.000/0.000 | 1.354/2.532 | 20.951/26.449 | 21.474/27.288 |
| branch | no | warm | 3.514/6.086 | 0.000/0.000 | 0.415/0.576 | 3.715/6.404 | 3.989/6.765 |

## Measured deadline crossings

The branch missed 20 seconds in **5 of 6 cold starts** and **0 of 6 warm starts**. The deadline was crossed during **module load in four cold starts**, and during **brain opening in one**. Brain opening is a measurable cost, but omitting it still missed the deadline in two of three cold branch starts. The largest measured cold cost is module loading through tsx, not Messages startup; the latter is skipped on Linux. These measurements do not establish which individual module, compiler operation, filesystem operation, or shared-host activity explains the variable module-load cost. Production scheduling is unchanged; the operator decides any next startup change.

The direct instrumented text/voice test passed 7/7 with the original deadline and reached readiness 12.687 s after process preload. Its Next readiness probe took 0.046 s, so it did not spend the 10-second readiness timeout in that run. The earlier failing uninstrumented test has no phase trace and cannot be assigned a precise crossing retrospectively.

| Sample | Phase crossing 20 s | Previous marker (s) | Phase end (s) | Ready (s) |
|---|---|---|---|---|
| branch-boot-1-cold | Brain open | 19.590 | 21.053 | 21.787 |
| branch-boot-2-cold | Module load | 0.308 | 23.332 | 27.500 |
| branch-boot-3-cold | Module load | 0.429 | 31.597 | 36.056 |
| branch-no-boot-1-cold | Module load | 0.321 | 24.743 | 27.288 |
| branch-no-boot-3-cold | Module load | 0.340 | 20.109 | 21.474 |
| main-boot-2-cold | Project ledger | 19.263 | 20.286 | 23.063 |
| main-boot-3-cold | Brain open | 19.325 | 20.498 | 21.016 |


### Recovery fail-then-pass receipt

```text
harness.resume removed:
  old owner alive: true   expected empty log to equal 'resume\n'  FAIL
  old owner alive: false  expected empty log to equal 'resume\n'  FAIL
  Tests: 2 failed | 4 skipped
harness.resume restored:
  old owner alive: true   PASS
  old owner alive: false  PASS
  Tests: 5 passed | 1 failed (native auth listener refusal, #6002)
```

## Rebase follow-up

Rebased onto `a2384dc76425312e02bda42db4a2cb6941f26da1`. Registry
conflicts retain both main's routes and the Symon routes. The forwarding wrapper
retains main's long-response, page-origin and header-forwarding behavior alongside
`alwaysForward`. Classification was regenerated (1344 hermetic, 1249 resource-owning).
The WS runtime owner context from main is retained.

Receiver controls now skip `markNativeCortexReader`, with a real-path assertion
before the authorization sweep. Startup logs a refused receiver claim once. The
brain recovery cases kill the old owner with SIGKILL and check resumption before
resubmission. The second-WS comment distinguishes port collision before receiver
startup from the shared claim used by a process on another port.

### Listener investigation limit

The first diagnostic attempt used a copied dependency tree and failed before the
auth sweep: Pi Durable was missing (2 failed, 4 skipped). After a clean lockfile
install and a fresh experimental-WS daemon build, the original PR head passed the
complete brain-owner file (6/6). Thus #6002 did not reproduce in that run. This is
not causal proof of a fix. No product fix for #6002 or separate PR is claimed.

A test-only `O8_TEST_DAEMON_TRACE=1` hook captures daemon stderr, stdout lifecycle
messages and spawn/exit events. It synchronizes builtin ESM exports so the real
spawn boundary sees the hook. A focused process smoke check confirmed spawn,
stdout and normal exit capture. The production bridge and startup order are unchanged.

The diagnostic attempts reached the two-round limit without a failing listener
control and passing causal repair. The PR remains draft WIP. The next investigation
needs a reproducing daemon lifecycle receipt before choosing a product remedy.

The fixture startup deadlines are unchanged. The #6016 cold-start measurements
remain the timing reference; this follow-up does not claim a new CI deadline failure.

### Rebased verification

- Fast typecheck passed on both supported verification hosts after aligning the
  copied dependencies with the lockfile.
- Receiver owner lifecycle: 3/3 passed. Native route inventory: 9/9 passed.
- Rebased default-mode brain matrix and forwarding: 2/2 passed independently.
- Rebased complete brain-owner file: 4 passed, 2 skipped; the o8d=true suite failed
  before the sweep at `tests/fixtures/ws-parity-server.ts:161`:
  `reference WS health timed out` with zero stdout/stderr bytes, no child exit,
  signal or process error. This is the unchanged 60-second parity-fixture readiness
  deadline, not the separate 20-second text/voice startup deadline and not a CI log.
  Both killed-owner recovery cases passed. No timeout was raised.
- Touched-file ESLint, diff whitespace checks and rule-check passed (24 files,
  zero violations). Diagnostic ESM spawn/stdout/exit smoke passed.

The full local gate was skipped on the master seat's instruction. Packaged behavior,
real providers, actual Messages access, the separate 20-second text/voice startup
suite and complete CI remain unverified. No merge or release.
