# Final reconnect round for #4700

Starting branch head: `f244f80ef`. Merged main: `e0766ea9d`, the fetched main
at the start of this round. The merge and repair are recorded in one commit.

The failure is in the retained sidebar reconnect path, not the fixture. The
catalog generation fence discarded errors as well as stale successful snapshots.
A catalog change while a connection check was in flight therefore suppressed
`Event::Error`, leaving the shell loading and connected after the request timed
out. A later tick could start another full request while the fixture remained
paused. The test could not resume the host until the shell settled.

## Failing and passing traces before the fix

Temporary probes recorded GET start/result times, sidebar generation and retry
transitions, shell loading/connected/notice, fixture request/response/close and a
five-second server timer. These probes were removed after diagnosis.

Failing run:

```text
host STOP; sidebar load generation=4
GET /api/mobile/orchestrator/threads -> Request timed out (45.361 s)
sidebar result: error, request generation=4, current generation=5
shell: loading=true connected=true notice=Connecting to local o8 server…
GET /api/runtime/inventory -> Request timed out (48.869 s)
connection load must settle
FAILED: 0 passed; 1 failed
```

The fixture had returned HTTP 200 before STOP. Its timer and request log stopped
while paused. There was no response to the stopped-host check, as intended.
The failing shell never reached CONT before its assertion unwound.

A passing run with the old fence discarded its first failure at 49.091 s,
started a second catalog request, then accepted that failure at 98.754 s because
the generation now matched (7/7). Only then did it resume the fixture. The fixture
timer resumed, closed expired WebSocket-info requests, and served the fresh
catalog GET with HTTP 200 in 211 ms; the remaining catalog routes also succeeded.
The shell became connected after 559 ms. This pass depended on when the test
executor returned from blocking HTTP work relative to the deadline assertion.
A longer deadline would retain the underlying lost completion.

## Remedy and regression

Fence only successful catalog snapshots. Transport errors always reach the shell
through its existing Error event. The existing reconnect test explicitly advances
the catalog generation after starting the stopped-host load, making the race
repeatable. Its shared `LOAD_REQUEST_TIMEOUT + 5 seconds` deadline and its focus,
draft and queue assertions are unchanged.

With the fix and the same generation mismatch (2/3), the first timeout at
46.046 s emitted Error. The shell settled disconnected at 46.165 s, resumed the
host, received a successful catalog GET in 102 ms, and reconnected in 106 ms.
The fixture log confirmed HTTP 200 responses after resume. The retained draft,
queue and focused composer assertions passed.

## Final verification

Headless Linux, final source without diagnostic probes:

- Exact reconnect test: **10/10 consecutive passes**. Every run forces the
  generation change while the stopped-host request is in flight.
- `shell::connection::tests`: **9 passed, 0 failed**, plus three ignored child
  entries executed and checked by their parent cases.
- `shell::startup_tests`: **5 passed, 0 failed**, plus its owned child entry.
- `cargo check --locked --all-targets --manifest-path native/o8-next/Cargo.toml`:
  passed. Cargo test build used the locked manifest as well.
- `npm run typecheck:fast`: passed.
- Hermetic `npm test -- --maxWorkers=2`: **1,281 files passed**, 3 skipped;
  **9,727 tests passed**, 5 skipped. This recovered completion run covered the
  same application code; temporary diagnostic logging was subsequently removed.
- Rust formatting and `git diff --check`: passed.
- Dependency review against `origin/main`: passed, zero vulnerable added versions.

The first serial connection-suite command reached its outer 240-second process
limit while starting the late-token case under concurrent build load. The final
suite used CI's four test threads and completed all nine cases in 116.49 seconds.
The test's internal shared deadline was never increased.


## Broader-check residuals

`npm run verify:ci` was run with Node 22 and npm 11.21.1. Its Type Check,
Test Classification, changed integration tests, and Server Bundle Size passed.
The aggregate is **not green**: Lint reached its CI process timeout, and the
native run failed
`shell::brain::tests::brain_fixture_actions_sources_search_clear_and_refusals`.
An exact follow-up reproduced its immediate `b.busy` assertion at
`native/o8-next/src/brain_tests.rs:98` after Send. This round does not establish
a baseline comparison or fix that separate assertion. The broader run was
stopped after these failures; it is not evidence of a complete native or CI pass.

Its first dependency review also picked up the temporary npm installer lockfile
inside the build directory. After moving that tool outside the checkout, the
review passed with zero vulnerable added versions. The full npm audit at the
high threshold and the configured Cargo audit completed without blocking
findings; existing moderate npm findings and allowed Rust warnings remain.
No dependency changes were made by this reconnect fix.

The worker streaming quarantine from #4930 is inherited from main and unchanged.
No release or merge is performed by this round.
