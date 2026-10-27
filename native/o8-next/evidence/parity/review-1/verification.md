# Review round 1 verification

The branch was rebased onto `origin/main` at `3484fb018` before this correction.
The Activity test conflict retains the upstream test unchanged. The original
[verification history](../verification.md) remains available; the clean full
native run below supersedes its incomplete full-suite result.

The fail-first regression opens the session fixture through the capture CLI in
a real headless browser, confirms its post-hydration surface action ran, then
injects an uncaught render exception. Before the fix, the CLI returned 0 with
zero crashes: [red tail](red-render.txt). After the fix, each injected failure
returns 1 and names the surface and exact failure class in the JSON report.
The [green tail](green-render.txt) covers uncaught exceptions, app-bundle console
errors, error boundaries and immediate resets, surface-route 404/500 responses,
post-hydration navigation and fetch failures, blank native pixels, native error
text, native error receipts and a healthy browser surface. The browser test uses
bounded native process/PNG fixtures. The real GPUI shell separately injects a
settings-route 503 and verifies its error frame enters the fatal receipt.

The stricter console check found a missing entitlement read in the parity host.
It now loads the existing production GET handler through the same fixture route
registration mechanism. No alternate data implementation was added.

| Check | Result |
| --- | --- |
| Capture CLI, failure injections and production-route tests | 16 passed |
| Accepted report recomputation through `--compare` | All 52 numeric gaps match |
| Full real Xvfb/native/Next capture | 28 cases, zero crashes |
| Original report snapshot, checklist rows and paired PNGs | Preserved |
| Full native `cargo test --locked` | 165 passed, four ignored; seven CLI tests passed |
| Real GPUI parity tests | Both passed, also included in the full suite |
| Native `cargo clippy --all-targets --locked` | Passed, existing warnings |
| `npm test` | 9,099 passed, five skipped |
| Linux runner and surface boundary regression tests | 26 passed |
| `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` | Passed |
| `npm run typecheck:fast` | Passed |
| `npm run test:classify` | Passed; 1,239 hermetic, 925 resource-owning |
| Touched-file ESLint and rule check | Passed |

See the [completion tails](green-checks.txt). The full native suite uses the
existing sibling server prerequisite built with
`cargo build --locked --manifest-path crates/o8d/Cargo.toml --features experimental-http`.
The four ignored tests are explicit measurement workloads. The accepted
[report](../report.json) and all 52 gaps are unchanged; the stricter fresh run
was used to check capture health, without replacing the reviewed measurements.

The [checklist](../../../../../docs/internals/o8-next-parity.md) still owns the
remaining visual acceptance. Render errors are fatal; numeric visual differences
and unmeasured geometry remain informational.
