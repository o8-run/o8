# Worker steer retry, fix round 2

Starting head: `1f614a8f4122c62489fc39e737b1537f0027c2e1`.
Merged main: `af25fc155d7393f6970c09b01a56266d7ffdc7cb`.

The native client only recognized the outcome header. A restart-orphaned
reservation instead returns HTTP 409 with `error.code = outcome_unknown` and
no such header. Treating that response as a terminal refusal discarded the
pending request, allowing the next click to create a different key and deliver
the same steer again.

The response adapter now recognizes the structured `outcome_unknown` and
`steer_outcome_unknown` codes as well as the existing header. Both pending body
and key stay in memory and in the existing draft store. Other refusal handling
is unchanged; no route, schema or authentication behavior is modified.

## Real action regression

`workers_restart_outcome_unknown_retry_keeps_one_steer` opens the production
Workers card and submits through its composer/action. Its owned HTTP route
process runs the production steer handler against the same persisted database.
The external runtime boundary records the effect and exits before its delivery
or idempotency receipt finalizes. The replacement process runs the production
restart wake and replays the request. The response is the real headerless 409
`outcome_unknown`, not an authored error body.

The test verifies distinct route PIDs, one actual restart, the response status,
code and missing header, then clicks Retry. It checks one delivery, identical
request bodies and key, retained pending state and the persisted draft/key.
Runtime discovery is isolated to fixture sessions and child processes are owned
and retired with the fixture.

On the starting head the regression is red at the delivery assertion:
**2 deliveries rather than 1** (`red.txt`). The same action path passes after
the fix; all 20 Workers cases pass (`green.txt`). Main and head both pass their
locked all-target check. The clean four-shard reference results are main
**320 passed / 0 failed / 8 ignored** and head **331 / 0 / 8**. No typecheck,
hermetic or other build/test job ran alongside either reference run.

All 328 main cases and outcomes remain, the head has 339 cases, and the ignored
identities match. Neither tree has a failing test. `comparison.json` and
`failures.md` record the per-case comparison, including every failing test with
its main result if any fail. The concurrent CI native run has the same
331 / 0 / 8 result and all 339 case outcomes match the clean head run.
There is no failing native test in any reference or CI run.

Fast/full typecheck, touched/full lint, Rust formatting, rule check, classification,
bundle size, governance and security pass. The new helper is included in the
native input closure. Local `verify:ci` is 7/9: route assertions pass 1/1 but its
process-tree shutdown cannot be confirmed, and the unchanged credential fixture
cannot create its home data directory. Both residuals reproduce on current main;
see `failures.md`. Full hermetic counts are 9,805 passed, 1 failed, 5 skipped.
No functional test was ignored and no timeout was changed.
