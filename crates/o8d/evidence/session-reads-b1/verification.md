# B1 saved session reads

Outcome: the Next-stopped WS entry records 18 deterministic status/body pairs through the production TS handlers, then a second o8d serves every corpus response natively with zero normalized JSON differences. `O8D_NATIVE_SESSION_READS=1` selects the native reads; the default remains TS.

| Path | Registry surfaces | Native method | Auth authority | Existing TS methods |
| --- | --- | --- | --- | --- |
| `/api/mobile/orchestrator/threads` | session, sidebar | GET | `panelGateMiddleware` bearer/principal gate | Other methods retain the adapter's existing refusal |
| `/api/mobile/history` | session | GET | `panelGateMiddleware` bearer/principal gate | Other methods retain the adapter's existing refusal |
| `/api/v2/chat-history` | session, sidebar | GET | `panelGateMiddleware` bearer/principal gate | POST, PATCH |
| `/api/orchestrator/composer-queue` | session | GET | `panelGateMiddleware` and `requirePanelAuth` | POST, PATCH, DELETE |

The private bridge credential authenticates the admission request, not its principal. Original credentials and host/origin headers still pass through the existing gates. The queue's in-handler gate receives an unverified proxy address, so a public peer/address header cannot grant local authority. Independent auth review found no bypass. The review's DB-only network fallback finding and whitespace normalization case were fixed and covered through the public socket.

Native threads include the current inbox subject, settlement/preferences, pin state, revision, run start, repository slug and branch. Saved transcript attribution fields are retained. Network projections, runtime-owned transcripts, lane overlays, parked-workspace receipt projections and dynamic steering capabilities still use TS when the persisted reader cannot own the projection. Those requests use the same Next-stopped backhaul; they do not require Next.

The corpus contains a held queue item, fixed saved timestamps and persisted inbox preferences. Holding the item through the production queue API prevents the WS startup drain from changing the fixture. Only `requestId`, `epoch` and `generatedAt` are excluded by explicit name. Persisted timestamps, IDs, revisions, missing/null values, computed fields and array order remain significant. Every replay requires `x-o8d-native-session-read: 1`; TS fallback cannot make the native corpus pass. Flagged TS responses close after completion so a keep-alive client cannot retain an earlier TS tunnel for a later native read.

## Evidence

[Red receipts](red.txt) retain three fail-before results:

- `records TS session reads and replays them natively with zero differences and Next stopped`: missing native dispatch.
- `defers DB-bound and JSON-only network threads to the TS projection owner`: missing DB-only fallback.
- `reclassifies native reads after a TS request on a keep-alive client`: subsequent read remained TS.

Green: all 5 tests in `tests/o8d-parity-real-path.test.ts` passed, including those three cases. The standalone `tests/o8d-next-http-real-path.test.ts` passed 8 tests with its opt-in benchmark skipped. Cargo tests with `experimental-ws,experimental-http` passed 6 tests.

Both `npm run typecheck` and `npm run typecheck:fast`, touched-file ESLint, classification and rule-check passed. The server bundle passed without changing its ceiling: 11,690,152 bytes before, 11,691,690 after (+1,538). The WS implementation changed from 348,417 to 348,742 bytes.

Surface test: 24 passed, 1 pre-existing inventory failure. `subagents/roster_actions.rs` calls `/api/orchestrator/stop-packet`, absent from both registration and `NEXT_ONLY_NATIVE_PATHS`. The native caller, registry and surface test are unchanged from HEAD, verified with an empty diff. This is a Phase A write registration gap outside B1. No Next-only inventory entries were added or removed here. Cold source startup needed a 60-second fixture allowance, and the existing registry walk used a 120-second test deadline on this shared executor; no response assertion was relaxed.

The resumed related run completed 10 files: 7 passed, 3 failed; 85 tests passed, 4 failed and 1 opt-in benchmark skipped. All 5 new parity tests and all 8 standalone saved-read tests passed. In addition to the surface inventory failure above, the unchanged queue-ledger file hit its fixed 120-second screenshot-test timeout and a delivered-steer media-size assertion (8,389,640 bytes versus less than 2,000). The unchanged queue-retry test expects applied payload bytes that the current queue compaction removes. The queue implementation and both failing queue test files have an empty diff from HEAD. These failures remain outside this slice; the related suite is not wholly green.

The original full unit run was interrupted by the host OOM and has no complete result. After recovery, the related and final full Vitest runs use `--maxWorkers=2`, Rust builds use `-j 4`, Rust tests use `--test-threads=4`, and suites run one at a time. The release rebuild and all 6 Rust tests passed again under these limits. `npm run typecheck` also passed its original single-file route-shape precheck (4 passed, 450 skipped); that wrapper invokes Vitest internally without a worker override.

The one final `npm test -- --maxWorkers=2` run completed: 1,319 files passed, 2 failed and 3 skipped (1,324 total); 10,158 tests passed, 5 failed and 5 skipped (10,168 total). Duration: 3,222.51 seconds. The five failures are exactly the known unrelated failures from the brief:

- `src/lib/providers/instances.test.ts`: `stores instances without secrets and keeps env encrypted in the ACP env store`; `deletes the instance env configuration row and its credentials`; `lets a runtime instance carry its own provider API keys as secrets only` — unavailable master-key configuration.
- `src/lib/acp/output-redaction.generated.test.ts`: `maps repeated base64 matches once in 4 MiB output`; `retains different literal escape depths locally and bounds benign mixed chains` — performance bounds.

No second full suite was started after recovery, and no build or test remained pending at handback.

## Measurements

[Machine-readable measurements](metrics.json): 18 requests, zero differences, 10 warmups and 100 samples per route and mode.

| Route | TS p50 (ms) | Rust p50 (ms) |
| --- | ---: | ---: |
| `/api/mobile/orchestrator/threads` | 18.97 | 134.36 |
| `/api/mobile/history` | 74.18 | 70.76 |
| `/api/v2/chat-history` | 38.42 | 50.67 |
| `/api/orchestrator/composer-queue` | 16.75 | 63.23 |

Backend RSS: flag off 487,476 KiB (476.05 MiB); flag on 322,192 KiB (314.64 MiB). Each snapshot contains four processes. RSS is the sum of the WS process and its descendants after warmed reads, with the fixture's Next listener stopped. Modes run sequentially against one owned profile on a shared Linux executor. The existing fixture runtime seam is used in both modes. Rust still performs per-request TS auth admission; this run shows lower RSS and slower median responses on three routes. These figures describe the seeded backend, not a production idle or whole-app memory claim.

## Files

- Rust feature/dispatch: `crates/o8d/Cargo.toml`, `crates/o8d/src/app.rs`, `crates/o8d/src/app/session_reads.rs`, `crates/o8d/src/http/mod.rs`.
- Saved projections: `crates/o8d/src/http/chat.rs`, `queue.rs`, `thread_context.rs`.
- TS admission/transport: `src/ws-server.ts`, `src/lib/ws-server/native-http-routes.ts`, `o8d-bridge.ts`.
- Harness/fixtures: `scripts/o8d/parity.ts`, `scripts/next/seed-o8d.ts`, `tests/fixtures/ws-parity-server.ts`, `tests/o8d-parity-real-path.test.ts`, `tests/test-classification.json`.
- Documentation/receipts: `crates/o8d/HTTP.md`, this file, `red.txt`, `metrics.json`.

Decision: local commit and hold. No push, PR, merge, version bump or release.
