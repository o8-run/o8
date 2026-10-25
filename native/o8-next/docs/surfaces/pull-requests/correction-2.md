# Merge safety correction

Historical P1 correction receipt. The subsequent [final registration correction](final-registration.md)
removes the retained shared-client include without changing these merge gates.

Both reported P1s were reproduced through GPUI controls, the shared fixture host,
persisted packet state and the production PR handlers before implementing fixes.
Only the external GitHub boundary is authored. No account or installed app was
used. Existing draft ownership and cross-workspace uncertain-delivery tests remain.

## Red receipts

```text
pull_requests_confirm_rereads_new_packet_membership
Confirm must re-read packet membership and refuse the newly held packet before POST
left: 1; right: 0

pull_requests_merge_finds_blocked_packet_from_linked_worktree
worktree B must find worktree A's blocked packet for the same repository and PR
left: 1; right: 0

test result: FAILED. 0 passed; 2 failed
```

The parity regression initially found native allowed merging with failed checks
while the actual desktop control refused. Additional red fixtures found unavailable
packet ownership, corrupt stored snapshots and malformed explicit PR sources
incorrectly treated as absence. Independent review also caught a valid unrelated
unassigned draft being refused by strict validation:

```text
pull_requests_unrelated_unassigned_draft_allows_merge
left: 0; right: 1
test result: FAILED. 0 passed; 1 failed
```

## Resulting behavior

Preparation freezes an opaque snapshot of repository/PR identity, head/base,
methods, checks, complete review state, packet membership, previews and runtime
liveness. Confirm reads them again and refuses any change before POST. The server
also reads them immediately before provider publication, after the broker metadata
read; legacy callers without a snapshot still receive all current refusals.
Known pre-publication refusals release busy state without creating an uncertain
delivery hold or clearing editor notes.

Membership reads current and archived stored missions, immutable delivery links
and lanes across linked worktrees. Canonical Git common directories identify the
repository; packet workspace identity overrides an unrelated mission primary
repository. Explicit PR ownership takes precedence over branch fallback, and
fork branches do not collide. Missing ownership, incomplete reviews and corrupt
nonempty snapshots refuse merging. Legacy absent/empty mission snapshots and valid
drafts remain usable. Strict reads are opt-in; other store callers keep their
existing recovery behavior.

The shared server decision is consumed by desktop and native controls. The
launcher remains opt-in; shared merge safety now applies to both clients. The
second registration site in `native/o8-next/src/client.rs` is unchanged and tracked
by #4695. Main's surface transport changes are retained; the owned PR transport
module adds its explicit JSON type import after rebasing.

Packet-linked merge and auto-merge enable retain their existing refusal even
after passing previews. This correction does not implement the governed packet
publication protocol or claim an atomic cross-writer lease.

## Coverage

- `native/o8-next/src/surfaces/pull_requests/merge_tests.rs`: both P1s, linked
  worktrees in both directions, 12 changes between preparation and Confirm,
  unavailable identity/reviews/state, valid drafts and legacy empty state.
- The same file drives 14 gate fixtures through the real native control and a
  mounted desktop `PrPanelActions` via `scripts/next/pull-request-desktop-probe.ts`:
  failed, pending, neutral and unavailable checks; requested changes; held,
  blocked and archived packets; live and unknown runtimes; explicit PR ownership;
  fork collision; approved and ready positives.
- `tests/next-pull-requests-real-path.test.ts`: 16 production-route tests, including
  packet links after GET and after the broker metadata read, merge and auto-merge
  publication, callers without snapshots, and unchanged allowed snapshots.
- `native/o8-next/src/surfaces/pull_requests/tests.rs`: existing action, draft,
  delivery-hold, partial-close, check display and first-frame measurements.
- `src/app/api/panel/prs/[number]/route.test.ts`,
  `src/components/desktop/pr-panel/PrPanelActions.test.ts`,
  `src/components/desktop/pr-panel/PrDeliveryState.test.ts`,
  `src/lib/github-broker/pull-request-actions.test.ts` and
  `src/lib/github-broker/read.test.ts`: existing route and action regressions.

## Verification

Rebased on `origin/main` at `9f44b02ea`, retaining its surface transport changes.
The full native run started before the final draft regression was added; the final
26-test PR run includes that regression and all merge/draft/delivery tests.

```text
full native: 104 passed; 0 failed; 3 explicit benchmarks ignored
CLI integration: 7 passed; 0 failed
final native PR filter: 26 passed; 0 failed
production HTTP plus touched desktop/broker/route tests: 6 files passed; 54 tests passed
```

Both TypeScript checks passed with the required 8 GiB heap. Scoped ESLint,
rule-check (17 files, zero violations), formatting and classification
(1,238 hermetic / 909 resource-owning) passed. Clippy `--all-targets` exits zero;
baseline diagnostics and the retained unused PR preview helper warning remain.
The root client registration site is deliberately unchanged for #4695.

Full `npm test` on the rebased tree: **1242 passed | 3 skipped (1245)** files; **9057 passed | 5 skipped (9062)** tests; zero failures.

Fixture CPU frame measurements: open 18.91 ms; detail 34.29 ms; interactions median 16.82 ms, p95 18.04 ms, max 18.79 ms.
[Raw samples](correction-2-timing.json) contain 20 interaction frames.

Before/after: newly held membership POSTs **1 → 0**; blocked linked-worktree POSTs
**1 → 0**, with the actual packet resolved in both directions; unrelated valid
draft publication **0 → 1**. Linux headless timings do not establish a macOS,
GPU/compositor or physical display latency target. Full desktop parity, governed
packet publication and macOS/display verification remain open.
