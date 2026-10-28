# Generated build output lifecycle

Source `build`, `dev`, `start` and source `serve` launches register `.next` output when the containing workspace has current managed ownership. Registration precedes output creation, and native producer identity precedes compiler execution. Unmanaged checkouts keep the ordinary build retry behavior and do not acquire generated-output retirement authority.

Release prebuild additionally requires write-time ownership receipts before
scrubbing, normalizing, promoting or cleaning compiler output. Unknown or
replaced entries remain held; see [release build output ownership](release-output-ownership.md).

The maintenance script uses the selected lifecycle data profile. Run it from a trusted source checkout outside the workspace being maintained:

```sh
node scripts/generated-output.mjs register --workspace "$WORKSPACE"
node scripts/generated-output.mjs status --resource "$RESOURCE_ID"
```

`register` observes legacy output and its current revision. It does not assert an earlier successful compiler run. An active producer, uncertain process identity, conflicting exact claim or retention hold blocks maintenance.

To preserve legacy or terminal failed output, provide explicit intent and at least two external evidence files. The evidence files and selected data profile must survive containing-workspace retirement:

```sh
node scripts/generated-output.mjs adopt \
  --workspace "$WORKSPACE" --repository "$REPOSITORY" --worktree-id "$WORKTREE_ID" \
  --intent "Preserve this owned output before retirement" \
  --evidence "$SOURCE_EVIDENCE" --evidence "$STOP_EVIDENCE"
```

Adoption verifies current manager ownership, source revision, retention and native quiescence, then captures and reads back a complete compressed byte bank. A known terminal producer failure keeps its original birth and actual close receipts. Failed or partial banks remain held.

Recovery restores bank bytes into a newly registered root and records each native writer before it writes. Completion requires actual successful child close and full identity, content and mode verification:

```sh
node scripts/generated-output.mjs recover --resource "$RESOURCE_ID"
```

An ordinary recovery is retained. To create a copy specifically for disposable verification, choose its purpose at creation:

```sh
node scripts/generated-output.mjs recover-verification --resource "$RESOURCE_ID"
```

An existing ordinary recovery cannot be promoted to disposable verification. Purpose and operation history are immutable, and a new recovery operation is allowed only after the earlier disposable copy has a recorded retirement.

Source retirement requires explicit adoption, the complete bank, a successfully verified recovery, current provenance, clear retention and native quiescence:

```sh
node scripts/generated-output.mjs retire --resource "$RESOURCE_ID"
```

The dedicated exact claim owns its rename and deletion. Durable final-empty admission precedes the last directory removal; actual helper close and both namespaces being absent precede completion. Interrupted claims remain available for cold replay. The bank and recovery are retained.

Only a successful copy created as disposable verification is eligible for copy retirement, after source retirement has durable completion:

```sh
node scripts/generated-output.mjs retire-verification --resource "$RESOURCE_ID"
```

Copy retirement verifies the bank, restored inode and bytes, clear holds and absence of consumers. Changed, replaced, incomplete, ordinary, live or uncertain copies remain held. Successful copy retirement keeps the bank and immutable recovery history; a later ordinary recovery receives a new operation identity.

`status` reports durable creation and completion receipts. During an interrupted retirement, a prior recovery completion receipt does not prove that its original path still exists; the exact retirement claim and finalization journal determine replay authority. Refusals must be resolved through the supported lifecycle, without changing journals or inventing completion evidence.

Run native fixtures through `npm run test:integration -- generated-output`. Generated-output fixtures deliberately retain their banks, journals and expected failures under a unique integration wrapper parent. Preserve that parent; do not run them directly in the ordinary temporary parent or reuse their retained parent for a fixture sweep.
