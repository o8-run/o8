# Sidebar request ownership on current main

Rebased onto `9f44b02ea` (#4696), retaining the prior surface-registration work.
`client.rs` is byte-identical to main. Sidebar-owned discovery, search, archived
history, rename and worker archive use `Client::get`, `url`, `request` and `read`
from `src/surfaces/sidebar/thread_list_client.rs`. The shared session entry delegates
to this adapter so grids, workers and standalone sessions retain complete paging.

The real fixture-host regression was run red before migrating discovery:

```text
sidebar_message_between_pages_keeps_every_thread
assertion `left == right` failed: offset overlap must not skip a later row
  left: 500
 right: 2000
test result: FAILED. 0 passed; 1 failed; 92 filtered out
```

After migration the real message-between-pages test retains all 2,000 unique
records, including the promoted running chat and its three persisted messages.
The repeating-page regression still returns 500 available unique records without
aborting the sidebar. Group/order/state parity, message search, live updates,
rename/archive persistence, project retention, retained selection and drafts pass.

```text
cargo +1.97.1 test --release --locked --manifest-path native/o8-next/Cargo.toml -- --nocapture --test-threads=1
test result: ok. 90 passed; 0 failed; 3 ignored
CLI tests: 7 passed; 0 failed
```

Native before/after this request extraction: 90 passes and 3 ignored workloads
on both sides, plus 7 CLI passes. All 95 source test function names remain unchanged
(including platform-gated tests); see `test-inventory.json`.

```text
npx vitest run tests/mobile-orchestrator-threads-route.test.ts tests/next-sidebar-real-path.test.ts tests/o8-next-shell-real-path.test.ts tests/next-render-parity.test.ts tests/next-stream-parity.test.ts tests/o8-next-grid-terminal-real-path.test.ts tests/next-brain-real-path.test.ts tests/next-settings-real-path.test.ts tests/next-issues-real-path.test.ts tests/next-issues-account-real-path.test.ts tests/next-surface-registration-real-path.test.ts tests/next-diff-review-real-path.test.ts tests/next-terminal-real-path.test.ts tests/next-history-real-path.test.ts
Test Files 14 passed (14)
Tests 44 passed (44)
```

`cargo +1.97.1 clippy --release --locked --manifest-path native/o8-next/Cargo.toml
--all-targets --message-format=json` exits zero, with no diagnostics in the migrated
sidebar request or session adapter code. Existing unrelated warnings remain.

The 8 GB `npm run typecheck:fast` and `npx tsc --noEmit`, ESLint on all 10 touched
TypeScript files, rule-check against main and classification pass. Classification
reports 1,238 hermetic and 909 resource-owning files; all five future-clock probes pass.

The 2,000-thread release workload collected 10 first-paint samples and 500 scroll
frames, with at most 22 materialized rows. See `run-1.json` for raw samples:

| Endpoint | p50 | p95 |
| --- | ---: | ---: |
| First painted sidebar row | 326.957 ms | 909.505 ms |
| Scroll event through CPU scene paint | 3.203 ms | 6.269 ms |

These use the GPUI test text system, include HTTP bootstrap and shared-runner
contention, and exclude fixture-process startup, GPU presentation and compositor cadence.

The prior full npm run completed with 9,055 passed, 1 failed and 5 skipped. The
failure is the unchanged `tests/desktop-account-identity.test.ts` provisioning
fixture tracked in #4633. It reproduces on this branch and a clean detached
`9f44b02ea` main checkout: 3 passed, 1 failed, expected one receipt but got zero.
No account code is changed. The PR body records the final completion-gate result.

Every remaining shared file and its cross-surface reason is listed in
[the sidebar surface document](../../../docs/surfaces/sidebar.md#registration-and-shared-seams).
