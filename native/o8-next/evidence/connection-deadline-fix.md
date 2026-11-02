# Reconnect deadline alignment

Round 2 of #4700 starts at `c339d06c91be098f3023a42d961d503d99eb21b4`
and merges main `0fe67bae7a336d44b6e72c59c7803f53d04616a1`.

The connection test's settle loop now derives its deadline from
`client::LOAD_REQUEST_TIMEOUT`, the constant used by the production GET
transport. Its 45-second request budget receives five seconds for the shell
to apply the completion. The connection facade re-exports the constant only
for tests. Mutation deadlines and first-paint readiness keep their behavior.

The reconnect test still pauses and resumes its actual fixture host. It checks
the retained composer's focus, the exact draft after continued typing and the
unchanged persisted queue. None of those assertions changed.

## Baseline

The review reported an intermittent failure with the old 30-second guard.
The unfixed merged tree passed both a local focused run (1 passed) and its
connection suite (9 passed, 3 owned child tests ignored). These attempts did
not reproduce the review failure locally; they are not red receipts.

## Commands

```sh
cargo check --locked --offline --manifest-path native/o8-next/Cargo.toml --all-targets
cargo test --locked --offline --manifest-path native/o8-next/Cargo.toml --bin o8-next shell::connection::tests:: -- --test-threads=4
cargo test --locked --offline --manifest-path native/o8-next/Cargo.toml --bin o8-next shell::startup_tests:: -- --test-threads=4
```

The locked all-target check and `npm run typecheck:fast` pass. Each repetition
runs connection first, then startup, using the same four test threads as CI.

| Run | Connection passed | Startup passed | Failures |
| --- | ---: | ---: | ---: |
| 1 | 9 | 5 | 0 |
| 2 | 9 | 5 | 0 |
| 3 | 9 | 5 | 0 |
| 4 | 9 | 5 | 0 |
| 5 | 9 | 5 | 0 |

Totals: 45 connection and 25 startup tests passed. Each connection invocation
reports three owned child cases ignored; each startup invocation reports one.
The parent cases invoke those children with their isolated configuration.

## Aggregate checks

`npm run verify:ci` passes Type Check (including the full type check), Lint,
Test Classification, Server Bundle Size, Security Audit, Governance Smoke and
the complete native check. All four native shards and the isolated fixed-rate
terminal probes pass.

Two local boundaries keep the aggregate command red. Hermetic Unit Tests have
9,715 passed, one failed and five skipped: the unchanged credential-store
fixture cannot create its lock directory under the process home (`ENOENT`).
Launcher integration assertions pass 10/10, but the gate cannot confirm that
its fixture process tree has stopped. These are separate from the five
connection/startup repetitions and the passing native check.
