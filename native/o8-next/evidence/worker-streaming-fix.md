# Worker streaming race

Fixes #4929. The measured base is `af25506e6fbf386e8b8c159b26365ebc21cb820d`.
The final branch rebases onto `e0766ea9d93ce6127540e8edea000bd56c0e70e3`
and removes the quarantine added by #4930. That base adds only the ignore
attribute; removing it preserves the implementation and test source measured
after the fix.

## Cause and change

The native fixture's HTTP host and streaming worker share a database through
separate connections. Queue mutations used deferred transactions: they read
before reserving the writer lock. A concurrent worker write can make that
read-to-write upgrade fail immediately with `database is locked`. The initial
message then never reaches the worker. Later enqueue and promotion requests
can fail for the same reason.

Enqueue, next-message claim and promotion now reserve the writer before reading
with immediate transactions. Routing, message identities, admission checks,
queue order and timeout values keep their existing behavior.

Failure diagnostics now include the fixture host's exit status, its bounded
stderr tail, the owned worker log and rejected HTTP response details. The
fixture runtime also retains its exception instead of replacing it with a
generic failure. In the captured reproduction below, the host was still
running; its rejected initial POST explains the missing transcript.

## Before

The original test, with diagnostics only, ran 20 times on CI shard `3/4`:
16 passed, four failed at queue operations with HTTP 400. A follow-up diagnostic
batch exposed `database is locked` in the rejected response.

The complete native shard then reproduced the reported initial-transcript
failure through the same production route:

```text
fixture timed out: first worker transcript; ("", Some(1), 1, Some([]))
fixture host: still running
Fixture request rejected: POST /api/orchestrator/composer-queue 400 {"error":"database is locked"}
test result: FAILED. 80 passed; 1 failed; 1 ignored
```

## After

| Filtered runs | Passed | Failed |
| --- | ---: | ---: |
| Before | 16 | 4 |
| After | 20 | 0 |

Both comparisons use four concurrent attempts, each selecting the original test
with the production CI runner, `O8_NATIVE_TEST_SHARD=3/4`,
`O8_NATIVE_TEST_PHASE=regular`, `CI=true`, locked Cargo dependencies and four
test threads. Every counted run reports one selected and one executed test.
Runner setup failures and preliminary probes are excluded from these counts.

From the repository root, repeat this command 20 times in batches of four:

```sh
worker_runner="$(node -p 'JSON.stringify([process.execPath, require("node:path").resolve("scripts/ci/native-test-shard.mjs")])')"
O8_NATIVE_TEST_SHARD=3/4 O8_NATIVE_TEST_PHASE=regular CI=true \
cargo --config "target.x86_64-unknown-linux-gnu.runner=$worker_runner" \
  test --locked --offline --manifest-path native/o8-next/Cargo.toml --bin o8-next \
  ui::tests::worker_tests::worker_send_steer_queue_promote_remove_and_streaming_latency \
  -- --test-threads=4 --nocapture
```

The 35-second wait, stream progression checks, first-transcript paint assertion
and per-key paint revision assertions are unchanged. All 20 successful runs
retain all 30 measured keystrokes while the worker stream advances.

The three existing queue API suites also pass: 35 tests covering real route
handlers and persisted routing, promotion, admission, cancellation and retry.

## Completion checks

The aggregate CI command passes the complete native check: all four shards
and the isolated terminal probes report 314 passed, zero failed and eight
owned or opt-in cases ignored. The streaming test executes and passes in
shard 3 (81 passed, zero failed, one owned child ignored).

Type Check (including the full check), Lint, Test Classification, Server
Bundle Size, Integration Tests (no changed resource-owning test files),
Governance Smoke and Security Audit pass. The fast type check, scoped lint,
formatting and the rule check against main also pass.

The local aggregate remains red on one unchanged credential-store fixture:
creating its lock directory under the process home returns `ENOENT`.
Hermetic totals are 9,726 passed, one failed and five skipped. Its store and
test sources match main; no credential or home-directory change is included.
