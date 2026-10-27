# Startup integration fix round

Source head: `d881f95a922a76d444de844b67f14501370f5d1a`.
Integrated main: `9642df32d550ddf14e852a04cae6b8d73fd68935`.

Startup tests require a painted window that reports ready once, retains a failed
load and Retry, and completes retry in the original shell. The connection surface
owns the displayed error label. Named request failures and deadlines remain
separately checked through the production client.

The original startup suite passes on its own, but fails when combined with the
connection branch after removing that branch's incompatible load-time readiness
call. Its actual failed-load label is `Server down`:

```text
test shell::startup_tests::failed_first_load_keeps_retry ... FAILED
first load state: (false, false, "Server down")
test result: FAILED. 0 passed; 1 failed
```

After updating the startup assertion and checking the single readiness signal:

```text
test shell::startup_tests::fast_first_load_keeps_the_painted_window ... ok
test shell::startup_tests::failed_first_load_keeps_retry ... ok
test shell::startup_tests::failed_project_load_keeps_retry ... ok
test shell::startup_tests::thirty_second_first_load_keeps_the_painted_window ... ok
test shell::startup_tests::client_startup_requests_have_named_bounded_failures ... ok
test result: ok. 5 passed; 0 failed; 1 ignored
```

Commands from the repository root:

```sh
cargo check --locked --all-targets --manifest-path native/o8-next/Cargo.toml
cargo test --locked --manifest-path native/o8-next/Cargo.toml startup
cargo test --locked --manifest-path native/o8-next/Cargo.toml
```

The first command passes on the combined tree. Full native checks also run on the
two final heads in scratch merge orders before push. HTTP 421 parity capture
failures belong to #4882 and are outside this correction.

## Verification limits

The stable combined native run passes reconnect and all five startup cases.
Its unit receipt is 296 passed, five failed and 11 ignored, plus 11 passing CLI
integration tests. Four failures reproduce in a control without this startup
correction: Settings defaults, worker archive, issue delivery and worker
streaming. Building the missing daemon fixture with `experimental-http` and
setting `O8D_HTTP_TEST_BINARY` resolves the fifth failure in a focused rerun (one
passed, zero failed). Four control failures remain. The connection branch's
verification note lists their exact names.

The required CI command passed Type Check, Test Classification, Server Bundle
Size, Security Audit and Governance Smoke. Lint passed separately after its
initial timeout (zero errors, 53 warnings). A credential-store unit test is blocked
by its process-home lock-directory write. All launcher assertions pass (14 passed,
four skipped); its integration gate still cannot confirm fixture-process teardown.
The aggregate CI command remains red.
