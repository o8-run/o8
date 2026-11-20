# Store ownership

The original GET lives in src/app/api/lanes/route.ts. view=live deliberately skips reconcileLanesIfDue. listActiveLanes in src/lib/lane/registry.ts selects lanes whose status is neither archived nor completed, orders by created_at and projects the four occupancy fields. The actual seeded SQLite CREATE TABLE is recorded in gates.json; no TypeScript type is used as the database schema.

Rust opens the existing profile-bounded SQLite database READ_ONLY, observes WAL commits, and runs the same saved query. It introduces no migrations, immutable flag, writer, background reconciliation or snapshot cache. Unsupported schema/value types, a missing private caller attestation or more than10000 active rows defer to TypeScript.

TypeScript remains the writer: lane creation/status/event updates in registry.ts, heartbeat/reaper changes in reaper.ts, and reconciliation/retirement callers. Ordinary GETs run reconciliation and transcript/archive/diff/storage logic and remain TypeScript-owned. The shared original live principal predicate is evaluated by Node on every private admission, including persisted worker-token revocation. Rust receives one private boolean; client-supplied context is not authority.

CLI worker status in cli/src/commands/status.ts consumes id,packetId,status,worktreePath. The real bundled command is exercised by the socket fixture on both actual daemon flag settings. All four fields, nullable values and lane order are compared. No mobile response shape changes.

The strace inventory covers all201 seeded TypeScript oracle requests. It also includes database initialization, explicit row reseeding, fixture credential minting, CLI bundle creation and the local request-count recorder; trace-summary.json preserves the writable-file list and program names with no credential values. The fixture uses only its owned data directory. Separately, each native GET is checked against a hash of serialized SQLite before and after the request.
