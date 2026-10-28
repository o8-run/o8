# Connection readiness integration

Base: `379135fff2210255947d3509330ba22f920fc7ee` (#4700).

Remove the connection extension's load-time readiness report. The startup
correction owns readiness at first paint; connection success and failure keep
their existing status and retry behavior.

Before this change, combining main, this branch and the startup branch fails:

```text
error[E0061]: this function takes 0 arguments but 1 argument was supplied
186 |             report_startup(s.connected);
 20 | fn report_startup() {
error: could not compile `o8-next`
```

After deleting the entire call, the combined tree passes
`cargo check --locked --all-targets --manifest-path native/o8-next/Cargo.toml`.
With the startup test contract correction, all five startup cases pass, including
the slow first load and failed-load Retry. Each owned child checks that first
paint emits exactly one readiness signal, including after retry.

Final-head integration checks use scratch copies in both merge orders:

```sh
cargo check --locked --all-targets --manifest-path native/o8-next/Cargo.toml
cargo test --locked --manifest-path native/o8-next/Cargo.toml
```

The parity mapping remains as previously corrected. HTTP 421 capture failures
tracked in #4882 are outside this change.

## Verification limits

Both merge orders pass the all-targets locked check and produce identical native
source trees. The five focused startup tests pass. The branch's fast type check
and hermetic suite pass: 9,457 tests, with five skipped.

A control containing main at `9642df32d` and this connection correction, without
the startup correction, reproduces four native failures:

- `shell::issues::tests::issues_worker_receives_linked_context_through_stream`
- `shell::settings::tests1::settings_fixture_all_default_controls_persist_and_refresh`
- `shell::sidebar::tests::sidebar_worker_archive_real_path`
- `ui::tests::worker_tests::worker_send_steer_queue_promote_remove_and_streaming_latency`

The Settings fixture lacks `productTelemetryEnabled`. Worker delivery is held by
the unsupported `medium` effort pin; the archive case retains its running row.

The final stable serial run passes reconnect and all five startup tests. Its unit
receipt is 296 passed, five failed and 11 ignored; all 11 CLI integration tests
pass. Four failures are the control failures above. The fifth is
`ui::o8d_read_tests::saved_history_surface_with_only_o8d`, whose daemon fixture
binary was not built at its default location. Building `crates/o8d` with
`--features experimental-http --bin o8d`, then pointing `O8D_HTTP_TEST_BINARY` at
that binary, makes its focused rerun pass (one passed, zero failed). The four
control failures above remain; full native validation is not green.

The merged-tree CI command passed Type Check, Test Classification, Server Bundle
Size, Security Audit and Governance Smoke. Lint timed out in that run, then passed
separately with zero errors and 53 warnings. One credential-store test cannot
create its lock directory in the process home under this workspace's filesystem
policy. Launcher integration assertions pass (14 passed, four skipped), but its
fixture-process teardown cannot confirm that every process has stopped. These
failures keep the aggregate CI command red.
