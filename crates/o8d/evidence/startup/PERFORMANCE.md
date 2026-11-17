# Startup release profile

Optimized release only, 10 warmups and 100 measured requests per route and transport through the production public socket with Next stopped. All twelve auth decisions match the TypeScript reference.

| Route | TS end-to-end p50/p95 ms | Native end-to-end p50/p95 ms |
| --- | ---: | ---: |
| /api/panel/ws-info | 5.59/6.72 | 8.11/9.58 |
| /api/setup/identity | 6.11/6.97 | 9.07/14.24 |

| Route | TS admission | Exact reader | DB preflight | Dispatch/close | Transport residual |
| --- | ---: | ---: | ---: | ---: | ---: |
| /api/panel/ws-info | 2.34/2.81 | 0.16/0.25 | 3.41/3.90 | 0.68/0.82 | 1.47/1.83 |
| /api/setup/identity | 2.72/4.27 | 0.05/0.15 | 3.71/5.64 | 0.74/0.96 | 1.78/2.84 |

Component values are independent p50/p95 milliseconds; their percentiles must not be summed. The transport residual subtracts measured admission and the broad Rust read stage from client elapsed; it includes classification, connection handling, response transfer, client decode and diagnostic overhead. Dispatch/close is the remainder of the broad stage after exact reader and generic preflight. Exact reader measures settings::ws_info or settings::identity, not the shared SQLite preflight.

Across200 native samples, admission is 29.72% of aggregate client time, exact reader 1.28%, and database preflight 41.59%. The reader itself is small; generic database preflight and the per-request Node authorization hop dominate. No optimization or auth bypass is included. Read-only connection reuse is tracked in [#6373](https://github.com/o8-run/o8/issues/6373); the operator gate needs separate master/security review.

Native end-to-end remains slower than TypeScript here. This synthetic Linux fixture does not establish installed performance. All raw ordered samples and build/patch/source hashes are in gates.json. The production sources were restored byte-for-byte before verification/commit.

Reproduce in a clean checkout of the recorded source head:

```sh
git apply crates/o8d/evidence/startup/profile-instrumentation.patch
RUSTC_WRAPPER= cargo build --locked --release --manifest-path crates/o8d/Cargo.toml --features experimental-session-reads --bin o8d
cp "${CARGO_TARGET_DIR:-crates/o8d/target}/release/o8d" /tmp/o8d-startup-profile-release
git apply -R crates/o8d/evidence/startup/profile-instrumentation.patch
O8D_TEST_BINARY=/tmp/o8d-startup-profile-release O8D_PROFILE_OUTPUT=/tmp/ \
  node --import=./scripts/register-server-only-stub.mjs --import=tsx crates/o8d/evidence/startup/release-profile.mts
```

Run the complete shared integration module for every route-table PR, in addition to its route tests:

```sh
O8D_TEST_BINARY=/path/to/production-release/o8d npx vitest run \
  --config config/vitest/vitest.integration.config.ts tests/o8d-parity-real-path.test.ts
```
