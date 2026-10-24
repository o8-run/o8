# Settings review correction round 1

Rebased on `origin/main` at `6892d7c1c4c4c0ee0b47a8999ab7d00b9dbf0431`. The resolutions in `shell_tests.rs`, `shell_view.rs` and `scripts/next/dev-server.ts` retain main's Brain paths and this branch's Settings paths. The shipped entry point still requires explicit opt-in to launch o8 next.

The native client requests the existing operator-defaults route's native projection. It receives declared TOML values and an additional-entry presence flag. Unknown tables, nested fields, comments, stored file paths and raw parser messages stay on the server. Native saves preserve hidden entries; provider replacement remains write-only. An older server that returns the raw TOML shape fails native deserialization. Parser/recovery logs use fixed diagnostics.

Field Edit reloads before opening the input. The draft holds that read's revision; Save checks it inside the same write lock and before rename. HTTP 409 preserves the desktop value. Refreshing the list does not silently give an old draft a new revision. Reload setting opens the current value.

The running desktop's existing `watchQuietMode` entry point reads only presentation values on focus and at a one-second interval. It applies changed preferences through `presentation_quiet_mode_set` and `set_review_notifications_enabled`, publishes the React store, and retries failed reads or native calls. Temporary native recording overrides survive unchanged persisted preferences. Tests replace only the browser/Tauri boundary; they invoke the production watcher after real GPUI actions and HTTP writes. AppKit overlay visibility and real OS notification delivery were not measured.

## Red and green

| Real entry point | Before correction | After correction |
| --- | --- | --- |
| `native/o8-next/src/settings_review_tests.rs`: shell controls, TOML clipboard/log canary, desktop live flags, fresh Edit, stale Save | 0 passed / 4 failed | 4 passed / 0 failed |
| `src/lib/settings/toml.test.ts`: native read of a malformed file and async/sync last-good recovery logging | Selected regression failed | Passed within the 61-test HTTP/settings run |
| `native/o8-next/src/shell_tests.rs`, including main's Brain cases and original Settings controls | Rebase conflicts in three files | 16 passed / 0 failed |
| HTTP/settings and notice-policy suite, seven files | Added projection/concurrency/recovery coverage | 61 passed / 0 failed |
| `tests/o8-next-shell-real-path.test.ts` | Existing launcher boundaries retained | 6 passed / 0 failed |

Raw excerpts: [four red regressions](review-red-tail.txt), [red recovery log](review-red-recovery-tail.txt), [green regressions](review-green-tail.txt), [green HTTP/settings](review-green-http-tail.txt), and [green shell integration](review-green-shell-tail.txt).

The HTTP/settings run covers `tests/next-settings-real-path.test.ts`, `tests/quiet-mode-settings-real-path.test.ts`, `tests/quiet-mode-policy-parity.test.ts`, `tests/operator-concurrency-settings-real-path.test.ts`, `tests/operator-defaults-runtime-inventory.test.ts`, `tests/operator-defaults-values-invalidation-real-path.test.ts`, and `src/lib/settings/toml.test.ts`. The canaries are synthetic. Assertions report only whether they leaked. Fixture paths use realpath/canonicalize; no account, operator desktop, or macOS execution is claimed.

## Measurements

Linux, Node 22, Rust stable, debug profile, GPUI TestAppContext and the test text system. Three fresh fixtures; the endpoint and 41 actions match the initial receipts. Open starts at Enter on the shell Settings command; interaction starts at the control action and ends at its acknowledged loaded CPU paint revision. Field Save samples exclude preparing the draft; Edit now performs an additional fresh read. No heavy checks ran alongside these measurements. GPU, compositor, OS notification delivery and macOS latency remain unmeasured.

| Run | Open to first CPU frame (ms) | Interaction p50 (ms) | Interaction p95 (ms) | Writes |
| --- | --- | --- | --- | --- |
| 1 | 89.27 | 109.17 | 231.99 | 41 |
| 2 | 94.28 | 110.60 | 162.93 | 41 |
| 3 | 95.76 | 101.70 | 151.57 | 41 |

Before correction, runs 1/2/3 measured open 185.27/63.70/54.92 ms, interaction p50 103.61/82.83/82.47 ms and p95 321.60/134.32/148.94 ms. The after-correction receipts are `review-run-1.json`, `review-run-2.json` and `review-run-3.json`. The before/after figures span the rebase and correctness changes.

## Completion checks

- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit`: passed.
- `npm run typecheck:fast`: passed (Linux uses the repository's TypeScript fallback).
- ESLint on all 11 touched TypeScript files: passed.
- `npm run rule-check -- --base=origin/main`: nine eligible files, zero violations.
- `npm run test:classify`: 1233 hermetic / 884 resource-owning files.
- `cargo fmt --check`: passed. No crates or dependencies added.
- Bare `npm test` failed before collection with an experimental Vitest file-cache `ENOENT`. Retried as `npm test -- --experimental.fsModuleCache=false` with the same test selection and assertions: **1 failed / 1236 passed / 3 skipped files; 4 failed / 8947 passed / 5 skipped tests**, in 785.41 seconds. All four failures are in `tests/pi-sdk-live-contract.test.ts`: the existing contract expired at **2026-10-25 00:00 UTC**. The same four failures reproduce on untouched `origin/main` in a detached worktree; the test and `src/lib/pi/sdk/` are unchanged. The expired billing contract remains outside this Settings correction. See `review-full-test-tail.txt`.

The [parity table](parity.md) still lists missing desktop controls. This correction resolves the three reported review findings; it does not complete the larger Settings port. Keep `Refs #4548`.
