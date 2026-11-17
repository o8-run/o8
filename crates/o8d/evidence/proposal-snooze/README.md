# Real proposal snooze write candidate

The native activity caller dismisses automatic proposals with POST /api/cortex/proposals and action/id/filePattern/fixPattern. This candidate mutates the populated saved snooze ledger. It does not add a native empty/no-op route. Ranking is the existing static top-50 order, not measured traffic.

The frozen synthetic TypeScript oracle contains 100 generated requests and responses plus the persisted JSON snapshot after every request. The first request is a valid nonempty update of an existing id; later requests cover replacement, append, duplicate ids, malformed saved entries and Unicode trimming. The independent Rust store-engine test exercises 37 actual mutations and compares all 100 stored states. Its test adapter models the remaining 63 validation refusals; the production HTTP adapter is not yet implemented. Final snapshots are retained separately as typescript-store.json and rust-store.json.

The public-socket test has a recorded red failure at the missing native marker. The core writer is NOT registered on this branch. The bounded write-dispatch prerequisite must merge before production adapter integration, public-socket green proof, auth matrix, store-owner exclusivity/crash proof and release-only latency. No completed port is claimed. Observation-proposal writes remain a separate TypeScript-owned domain.

The fixture clock is test-only. Production must use its actual clock, never a public caller-supplied time. Unsupported persisted encodings must not be erased or handed to an independent writer while Rust owns the domain. Resolve that ownership/refusal behavior before publication.
