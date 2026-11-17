# Repository and project store ownership

All Rust SQLite connections are READ_ONLY, profile-bounded and WAL-visible. No immutable flag, migration, credential decryption or Rust store writer is introduced. Private admission attests process/cache state and a registry byte fingerprint; public client headers cannot supply that context. Caller peer attestation is unchanged.

| GET | Reads | Original write/live owner retained in TS |
| --- | --- | --- |
| panel/repos | repos.json normalized cached registry; existence; saved icon app_state | GitHub discovery, selected readiness/restore validation, stale/mismatched registry cache, possible image discovery and live readiness/icon caches |
| panel/projects | projects.json metadata + projects/project_repos/app_state; canonical membership, color/order and merge policy | Missing/malformed sidecar, reconciliation/repair and unsupported identity/membership state |
| projects | projects/project_repos + projected JSON ledger | syncProjectStoreFromPanelLedger creates missing SQL projects, cleans imported descriptions and links missing repos; Rust defers any unsettled state |
| projects/[id] | projects/project_repos + merge-policy app_state and dogfood marker | Original authenticated handler remains fallback for unsupported cases; PATCH/DELETE remain TS |
| panel/repo-icon | attested registered repo; bounded saved identity/icon probes | Rooted image discovery/verification and response bytes/security headers stay with the original handler; native missing-repo/no-icon replies only |

The literal projects/context, projects/locks and projects/dismissed-suggestions paths precede [id]. Their private admission probes receive409 without running the GET; the canonical TS fallback handles them once. Corpus tests compare responses and observe that refusal.

panel/ssh-machines is excluded. The prepared real socket-peer pass-through is a caller-trust change requiring master security review, alongside the operator gate. panel/workspaces stays on TS because syncWorkspaceLifecycleRecords writes even for an empty fleet and inventory can reconcile lanes.

The fixture seeds both stores and their caches explicitly, snapshots durable content around every native reply, and permits only normal SQLite SHM coordination outside that content snapshot. It controls clock and SVG mtime inputs. Its deterministic repair states use existing fixed SQL IDs; a separate real random-ID creation edge verifies TS fallback creates rows and every returned ID exists in SQL, without weakening ID comparisons in the frozen oracle. Owned gh/CLI stubs and a system-only PATH prevent external services.
