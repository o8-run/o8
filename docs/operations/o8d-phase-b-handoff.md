# Phase B checkpoint for local agents

Refs #5422 and #5243. The user requested this checkpoint so local agents can
continue in the same draft PR. The whole Rust server port is unfinished.

## Implemented checkpoint

Two commits, in requested domain order:

1. Saved-session read batching, request-local SQLite reuse, linked-checkout
   response parity and regression tests. `O8D_NATIVE_SESSION_READS` stays off.
2. Branch GET projection with a separate loopback client, supported-configuration
   checks, bounded snapshot refresh and parent/child cleanup.
   `O8D_NATIVE_REPOSITORY_READS` stays off.

Neither commit transfers persisted writers. The protected TypeScript handlers,
auth/Host/loopback checks and environment allowlists retain their implementations.
The only TypeScript production changes are registry wiring and the new client.
The repository/git domain remains partial. No whole domain completion is claimed.

## Evidence and known limits

- [Session receipt](../../crates/o8d/evidence/session-reads-b2/verification.md):
  20 recorded responses, zero normalized differences; native marker mandatory.
- [Repository receipt](../../crates/o8d/evidence/repository-reads-b1/verification.md):
  12 recorded responses, zero differences, including bare/linked/symlink cases.
- Rust all-features release tests: 17 passed. Includes WAL/replacement freshness,
  Git call batching, helper/promisor/ref refusal and active-child EOF cleanup.
- Focused TypeScript HTTP checks: 19 passed, two optional benchmarks skipped.
  Changed-file cleanup gate: three files passed, nine tests passed, one benchmark
  skipped. An external orphan-reaping launcher was needed for container cleanup.
- After rebasing onto `a1613de91`, the focused suite passed 20 tests across five
  files (two optional benchmarks skipped), including both parity corpora, the
  actual client lifecycle test, standalone HTTP tests and route inventory.
  Fast typecheck passed again. Rust crate sources/dependencies were unchanged
  upstream, so the 17-test Rust result still covers this implementation.
- Full unit suite before the repository wiring/rebase: 10,178 passed, one failed,
  five skipped. The unchanged Linux credential round-trip test writes its global
  lock outside the workspace because `getDataDir({})` ignores fixture overrides.
  Credential implementation and home directory were left unchanged.
- Aggregate `verify:ci` was not green. Lint, security audit, classification,
  bundle size, type checks and governance smoke passed. Native UI retry passed
  shards 1–3 and completed shard 4 regular; the remaining phases were not verified.
  Real-window tooling/lavapipe are unavailable in this executor.
- Measurements are seeded backend process-tree figures, not whole-app figures.
  Session threads and queue remain slower than TypeScript. The session enabling
  performance gate is unmet; keep flags off.

## Continue from here

First check the PR body for post-rebase results. The checkpoint was rebased onto
`a1613de91`; main added read/write splits, mission-card transcripts and a
comparison-diff ref guard after the original audit. Preserve these upstream edits.

Finish session performance/fallback coverage before declaring that domain done.
Then re-evaluate repository candidates against current main. Keep credential-aware
viewers and contained filesystem handlers on TypeScript under the user's boundary.
The initial [ownership audit](o8d-phase-b-ownership.md) records shared writer
families; it is an inventory, not proof of writer closure on newer main.

Composer queue/chat writes, cortex, lanes/worktrees/supervisor, runtime adapters,
orchestrator/governance and domain-following MCP tools remain unfinished. Before
moving a writer, enumerate background, recovery and synchronous callback callers;
all remaining TypeScript callers must use loopback and no store may have two
writers. Add stateful parity and each domain's default-off flag. Keep one commit
per domain and continue this PR. Skip mobile/relay/encryption and retain all
protected boundaries from the original user request. Do not version, release,
merge or enable flags as part of the handoff.

## B2: session read speed

Box phase timing of one native read (p50, parity fixture): admission round trip
2–3 ms, SQLite open 0.1 ms, first query on a fresh connection 3.25 ms (the
whole schema is parsed), and for the sidebar list 6.3 ms to read and parse
every chat-history file.

- B2a (#5699) reuses one admission backhaul.
- B2c keeps per-file thread summaries, with the same bounds and key as the TS
  cache plus the inode (`crates/o8d/src/http/thread_summary.rs`).
- **A held read connection is ruled out.** Keeping a read-only connection open
  between requests means the writer is no longer the last connection to close,
  so the old `-wal` and `-shm` outlive a replacement of the database file, and
  the new file is then read through the old WAL: stale pages, a known SQLite
  corruption pattern. The replacement step in
  `crates/o8d/tests/session_reads.rs` (writer closes, main file renamed over,
  next read must see the new file) fails with any held connection; a short
  idle reaper only narrows the window. Each read opens its own connection and
  pays the schema parse.

## Reproduction

Use Node 22, the npm version from `packageManager`, stable Rust and the existing
dependency setup. Format touched Rust files only with edition 2024 rustfmt.

```sh
export CARGO_TARGET_DIR=/tmp/o8d-phase-b-target
cargo test --release --locked --manifest-path crates/o8d/Cargo.toml --all-features
cargo build --release --locked --manifest-path crates/o8d/Cargo.toml --features experimental-session-reads
export O8D_BINARY="$CARGO_TARGET_DIR/release/o8d"
node --import=tsx scripts/o8d/parity.ts --report=/tmp/session-metrics.json --corpus=/tmp/session-corpus.json
node --import=tsx scripts/o8d/parity.ts --domain=repository --report=/tmp/repository-metrics.json --corpus=/tmp/repository-corpus.json
npm run typecheck:fast
npm test
npm run verify:ci
```

The parity runner measures ten warmups, 100 samples and RSS after 20 idle seconds.
Use a quiet machine. Each replay requires its native response marker so fallback
cannot conceal a missing Rust projection. Corpus path substitutions in checked-in
artifacts happen only after the runtime comparison.
