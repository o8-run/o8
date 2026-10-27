# Reusing installed dependencies across source commits

On APFS, workspace preparation can make a private copy-on-write clone of an
existing installed npm tree. Equivalent package, lock, config and patch inputs
can match across different source commits. The donor's own committed tree stays
pinned throughout cloning; changing it during preparation refuses reuse.
Installed resolution, native bindings, directory identity and private writes
retain their existing checks. Recipe and cache identities still include the
packet's complete Git tree.

Root and dependency install scripts can mutate dependency payloads. An unchanged command string
alone does not establish equivalent output: its helper script may have changed.
Without an explicit declaration, enabled install lifecycle requires the same
source tree. A repository can declare its complete workspace read closure in
`package.json`:

```json
"o8DependencyClone": {
  "lifecycleInputs": ["scripts/postinstall.mjs"]
}
```

This is a repository-authored completeness assertion, not automatic dependency
analysis. Include every helper, config and data file read by root or dependency lifecycle
code, including presence-sensitive inputs. All entries must name tracked,
contained regular files. Existing package/config/patch inputs and locked
installed packages are covered separately. An empty list asserts that install
lifecycle reads no additional workspace files. Keep the declaration current
when scripts acquire new inputs. o8's current postinstall reads its own script,
locked dependency packages and the already tracked patch inputs.

Preparation persists a `worktree_preparation_timing` event with stage
`dependency_selection`, the selected `path` and a bounded `reason` before the
chosen operation starts. A refused directory clone records its reason with the
native-install or image selection. These events accompany the completion timing
for `dependency_materialization`.

## Ready directory pool

Worker preparation can consume a ready private dependency directory instead of
cloning it during dispatch. The pool identity includes the same dependency
inputs, runtime, install arguments and lifecycle declaration used above, plus
the donor directory identity and validated installed graph. Unbounded lifecycle
also retains the source-tree requirement. Recipe and cache keys remain unchanged.

The pool has two fixed slots with a maximum logical size of 3 GiB per tree.
Refill runs in the background, reserves storage through normal admission, clones
and validates each tree, probes native bindings and releases its reservation
before publishing readiness. The first cold dispatch and any unavailable or
held pool use the existing clone/install path. Consumption claims a slot
exclusively, then uses a descriptor-pinned, same-volume, no-replace rename.
Donor rechecks, target graph validation, root lifecycle replay and final native
checks still run during dispatch. Two workers never consume the same tree.

`dependency_selection` records `dependency-pool` for a hit, together with pool
limits, ready/occupied/held slot counts and retained logical bytes. The same
status is available from `dependencyDirectoryPoolStatus`. A background refill
failure cannot reject dispatch. Ready trees survive process restarts. Interrupted
slots with durable process receipts are reclaimed only after proving owner death;
expired storage reservations also require that proof. Unknown ownership, including
an interruption before the owner receipt is written, stays held. Such a slot
reduces available pool capacity and remains visible; cleanup never adopts or
deletes an unreceipted directory. Both slots held means the existing path remains
in use until that ownership is resolved.

Installed payload receipts seal the lockfile-derived graph and the SHA-256 digest
of every regular payload file, including hidden data. Names, file types, modes
and symlink targets are covered; inode metadata and directory link counts are
not content. Directory identities still fence ownership. Absolute, escaping,
cyclic and unresolved symlinks refuse reuse before lifecycle or worker execution.
A pool consumer validates this seal before publication and checks the resulting
clone before use. Missing, corrupt or older unsealed payloads force a full native
install, with a `payload-*` or `pool-payload-*` selection reason persisted by worker
preparation. A completed install establishes a fresh seal.
