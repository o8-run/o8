# Release build output ownership

Release prebuild reserves `.next/.o8-release-build` before the compiler starts.
The reservation owns that directory inode; it does not grant ownership of every
name another writer might place inside it.

Compiler files receive write-time receipts from exclusive creation descriptors.
Rewrites reopen without truncating, compare the descriptor with the preceding
receipt, then write through that descriptor. Metadata changes use the same
descriptor rule. Copies preserve executable permissions. A fixed native creator
returns the directory or link inode it created in an identity-pinned parent;
the caller checks that original receipt before claiming it. Compiler workers
require native birth admission, and every admitted writer requires an observed
close before publication.

The final inventory compares against those receipts. It never adopts an unknown
file or refreshes a replacement's identity into ownership. Restored cache input
keeps its original verified inventory; only verified bytes are copied into new
compiler-owned descriptors. Unknown, changed or unsupported native output stops
publication and remains held. An empty compiler plugin list does not initialize
an otherwise unused native disk cache. Native plugin output without writer
receipts remains held.

Environment scrubbing captures each `standalone/.env` or
`standalone/.env.production` in a private directory before removal. It checks
the captured inode against the original writer receipt and its open descriptor.
A fixed native helper uses the platform's atomic no-replace rename with pinned
parent descriptors. It needs the release build's C toolchain and refuses if the
operation is unsupported; it never falls back to an overwriting rename.
A replacement at the shared filename is never unlinked. A mismatched captured
file is linked back exclusively when the original name is free; an occupied
name is preserved. The captured entry remains held and its recovery location
is reported. Interrupted private holders have no writer receipt, so later
compiler cleanup cannot adopt or delete them. Layout normalization checks
ownership again before each rewrite or move. An ordinary build caller without
a reservation preserves an environment file and reports that it cannot scrub
it without ownership proof.

Moves create destinations exclusively. Regular files keep their original inode
through an exclusive hard link; directories and links use new creator receipts.
The original source uses the same private capture before each unlink or
empty-directory removal. A foreign destination that appears during a move is retained and the
operation refuses. Publication persists transfer receipts rather than treating
a post-move scan as ownership.

Postship and rebuild cleanup still use the persisted inventory and native
per-entry checks. Postship selects matching owned files and directory ancestors
from that inventory. A replaced file or directory stays, while independent
owned output is still cleaned. Postship names each kept path and explains
whether it was outside the inventory or its ownership changed. The root stays
held until retained files are resolved; a retry cannot adopt those files.
Rebuild remains strict about changed owned files. Cache links, root substitutions,
occupied names, retention holds and uncertain consumers remain refusals. Inspect
the reported entry and the lifecycle state before recovery; see
[generated output lifecycle](generated-output-lifecycle.md). A later scan cannot
turn retained output into disposable output.
Inventories saved before write-time receipts existed remain unproven. Rebuild
and postship preserve those files and their existing state; they cannot gain
deletion authority by reading an old inventory with a new implementation.

## Fail-then-pass receipt

Before production edits, `tests/release-output-delete-ownership-real-path.test.ts`
failed both requested cases on `0100f0d05` through the real prebuild producer,
registered build and postship command. A separate writer replaced `BUILD_ID`
before the compiler exited or added `standalone/.env`.

```text
build and postship must preserve the unrelated inode: expected undefined to be defined
Test Files 1 failed (1)
Tests 2 failed (2)
```

The expanded baseline also covers identical bytes, a server-file replacement
before normalization, and the ordinary registered-build entry point:

```text
Tests 5 failed | 1 passed (6)
```

The fixed tests require the unrelated bytes and inode to remain, publication to
fail, and the entry to be reported. The worker control exercises delayed native
admission, promise and stream writers, executable copying, normalization, and
removal of owned environment copies. `tests/build-output-writer.test.ts` adds
descriptor metadata replacement, numeric open flags, per-delete replacement,
writer closure, creation-receipt substitution, and late destination collisions
during rotation and publication. All fixtures use temporary output; none signs,
notarizes or publishes a release.

`tests/release-output-legacy-inventory-real-path.test.ts` separately went red
through postship and rebuild before the compatibility guard was added: the
former deleted the retained file, and the latter replaced its inode. Both paths
must preserve inventories lacking the write-receipt proof marker.

Final green verification:

```text
Release matrix: 11 files, 83 passed (56 + 27 in two focused runs)
Artifact/cache/export checks: 4 files, 61 passed
Full npm test: 1268 files passed, 3 skipped; 9582 tests passed, 5 skipped
```

Both typechecks, test classification, touched-file lint, repository rules and
the native compile check passed. The full suite used an isolated execution cache
and throwaway test home; the native check used an environment-only empty resource
overlay for a source checkout without exported assets. These checks establish
temporary build/cleanup behavior, not an installed application acceptance run.

## Review round 1 receipt

`tests/release-output-round1-real-path.test.ts` was written before the fixes and
failed all three cases on `82d32058d`:

```text
registered scrub preserves a replacement at the native removal boundary
  the unlink must not delete the replacement inode: expected false to be true
postship clears owned output and names retained entries with replaced BUILD_ID=true
  owned cache/compiler.pack must still be cleaned: expected true to be false
postship clears owned output and names retained entries with replaced BUILD_ID=false
  .toMatch() expects to receive a string, but got undefined
Tests 3 failed (3)
```

The three cases pass after the fix. They use the real registered build and
postship cleanup commands with temporary repositories and artifacts. The kept
files retain their original device, inode and bytes. The scrub returns failure;
postship removes owned siblings and reports kept filenames with reasons.

`tests/build-output-writer.test.ts` adds the same removal substitution during
rotation and publication, a new occupant after capture, a restoration collision,
and process exit during capture. Rotation and publication both failed before
their source removals adopted the capture guard. These checks preserve held
entries without granting a later writer deletion authority.

Round 1 green verification:

```text
Release matrix: 13 files passed; 107 tests passed
Artifact/cache/export/preflight checks: 4 files passed; 60 tests passed
Full npm test: 1268 files passed, 3 skipped; 9582 tests passed, 5 skipped
```

The release matrix includes all 22 writer cases, all 12 native purge cases,
the real compiler build and rebuild, and the existing release preservation
controls. Both typechecks, classification, touched-file lint, repository rules,
native C compilation and `cargo check` passed. The native purge crash runner
loads the module through its supported namespace shape and injects its stop
marker at the test spawn edge; production environment filtering is unchanged.
