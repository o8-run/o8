# Native saved-session read optimization

Refs #5422 and #5243. This evidence covers saved-session projections only. It
does not complete Phase B, move a writer, or justify enabling the default-off
`O8D_NATIVE_SESSION_READS` flag. See the
[ownership audit](../../../../docs/operations/o8d-phase-b-ownership.md) for the
remaining domains and protected routes.

## Change and regression evidence

- Sidebar reads resolve Git metadata after pagination, once per repository per
  request. The regression fixture has 20 conversations in one repository: the
  original implementation failed with 20 Git invocations instead of one.
- One lazy, guarded read-only SQLite connection and one prepared inbox query are
  shared inside a request. The connection is reopened for each subsequent
  request; committed WAL updates and atomic database replacement remain visible.
- Checkout metadata now includes `isWorktree` and `worktreePath`, including linked
  checkout roots and nested directories. The unmodified baseline failed the
  current TypeScript oracle at `$/body/threads/0/isWorktree: missing from candidate`.
- Tests also cover pagination, saved-remote fallback, changed Git metadata,
  deleted directories, malformed checkout markers and ordinary `.git` directories
  containing a stray `commondir` file.

The existing profile/file guards, bearer checks, native admission preflight,
listener restrictions and TypeScript implementation files are unchanged.

## Parity and performance

`scripts/o8d/parity.ts` recorded TypeScript responses on the owned
`scripts/next/seed-o8d.ts --linked-checkout` fixture and replayed them through the
real WebSocket server HTTP entry with the Next listener closed. All 20 responses
matched after the existing normalization, and every candidate response carried
the native marker. The corpus includes opaque TypeScript-generated cursors.

[corpus.json](corpus.json) contains the recorded oracle. Only the random fixture
directory and its URL-encoded form were replaced with `$FIXTURE_DIR` and
`$FIXTURE_DIR_URI` for publication, **after** the actual parity comparison. Status,
array order, missing/null distinctions and semantic fields remain significant.

Measurements use a release binary, Node 22.23.4, Rust 1.99.1, 10 warmups and 100
samples per route, sequentially with other test/build processes paused. RSS is
the sum of the backend WS process and descendants after 20 seconds idle; the Next
listener is closed. This is backend process-tree RSS, not standalone Rust or
whole-application memory. Both modes had two processes.

| Measurement | TypeScript | Rust |
| --- | ---: | ---: |
| Idle backend RSS, MiB | 301.07 | 194.78 |
| Threads p50, ms | 2.55 | 9.89 |
| Transcript/history p50, ms | 13.72 | 5.82 |
| Chat context p50, ms | 17.69 | 6.60 |
| Composer queue GET p50, ms | 2.26 | 5.15 |

[metrics.json](metrics.json) contains the unrounded results. Threads and queue
remain slower than TypeScript; the performance enabling gate is **not met**.
The historical 19/134 ms result is from a different run and is not a controlled
before/after comparison with this environment.

A separate latency-only comparison used the original three-session fixture for
both Rust revisions: threads improved from 14.84 ms to 5.96 ms p50. See
[baseline-latency.json](baseline-latency.json) and
[candidate-latency.json](candidate-latency.json). Baseline schema parity failed as
described above; these diagnostic timings are not a baseline parity pass.

## Validation

- `cargo test --release --locked --manifest-path crates/o8d/Cargo.toml --all-features`:
  13 passed, zero failed.
- `tests/o8d-parity-real-path.test.ts` and `tests/o8d-next-http-real-path.test.ts`:
  13 passed, one optional benchmark skipped. The CI integration gate also passed
  all five parity tests with an external orphan-reaping launcher.
- Fast/full type checks, lint, dependency security audit, test classification,
  server bundle-size checks and governance smoke passed.
- Full `npm test -- --maxWorkers=2`: 10,178 passed, one failed, five skipped.
  The unchanged Linux credential round-trip test attempts to create the global
  credential lock directory outside the writable workspace. Its `getDataDir({})`
  call ignores the fixture's data-directory override. Credential code and the
  user's home directory were left unchanged.
- `npm run verify:ci` did not pass. Its integration assertions passed, but initial
  cleanup detected orphaned esbuild zombies under a non-reaping container init;
  the reaping-launcher rerun above passed. The unrelated native UI build lacked
  development linker names for installed X11 libraries. After those failures,
  the aggregate run was stopped rather than repeatedly compiling the same failed
  native targets. A workspace-only native recheck is tracked separately in the PR.

Only touched Rust files were formatted with `rustfmt --edition 2024`; no whole
crate formatting, version bump, release or merge is part of this change.
