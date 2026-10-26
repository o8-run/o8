# Correction round 1

Rebased onto current main, `417586b6b00e55f4759fc95a68091ffad7596213`.
No release, version, deployment or publishing files changed. This correction uses
the same branch and one push, with an explicit lease for the requested rebase.

## Red before the fixes

The CLI tests first reproduced shared transport/macros, build scripts and
manifests escaping the old inventory, checker/workflow edits escaping the label
guard, and the lack of a base-owned workflow:

```text
Test Files  1 failed (1)
Tests       7 failed | 8 passed (15)
```

After enabling the base-owned workflow, the existing metadata-only policy test
failed before the bounded exception was added. Only this read-only native lane
is exempt; all other target-event workflows retain the metadata-only rule.
The immutable bootstrap pin also had its own red regression before it was set.

Replaying the real ports exposed owned Python fixtures and already-landed surface
files/registrations. Both compatibility cases were written and run red before
the staging fix:

```text
Test Files  1 failed (1)
Tests       2 failed | 17 skipped (19)
```

## What the correction enforces

- Every scoped file is shared unless admitted by the surface-module directories,
  the documented data/documentation extensions, or the explicit two-file legacy
  fixture allowlist. Shared transport, macros, manifests, new core helpers and
  build scripts are refused. A build script remains shared inside a surface.
- The checker and this workflow require `shell-work`, including a PR changing
  only the workflow. Their contents are never loaded from the PR.
- A base-owned `pull_request_target` workflow checks out the base SHA with no
  persisted credentials and only `contents: read`. It reads PR objects but never
  checks out PR code, and it cannot save PR output in main's cache namespace.
- This first introduction has a bootstrap PR event restricted to the recorded
  pre-introduction base, loading the immutable checker at
  `c50d2933f71caa5d9c0b338b2e2310df730c2531`. Once main contains the workflow,
  target events use its base-owned checker. Bootstrap and trusted events have
  distinct check names and concurrency groups.
- Functional fixtures parse the real workflow and execute its actual shell run
  blocks with real Git/Cargo. One completes selection and isolation. Others
  replace both the PR checker and workflow with successful bypasses and change
  shared client/transport; the trusted checker refuses them. The bootstrap test
  imports the exact pinned objects, without fetching repository history.
- Main's identical, already-landed surface paths and registrations are retained;
  newer unrelated main changes cannot be erased by staging a PR delta.

## Green and real PR replay

`tests/next-surface-boundary-real-path.test.ts` and
`tests/workflow-policy.test.ts`:

```text
Test Files  2 passed (2)
Tests       27 passed (27)
```

The complete checker, including actual isolated Cargo checks for the accepted
ports, reproduces every reviewer outcome. Exact head SHAs and elapsed times are
in `real-pr-results.json`.

| Outcome | PRs |
| --- | --- |
| Pass | #4670, #4652, #4655, #4668 |
| Fail | #4658, #4660, #4661, #4665, #4700, #4702, #4704 |

Accepted ports took **9.933–16.235 s** with warm dependencies. Shared-file failures
took **0.047–0.074 s**. A cold native `cargo check --all-targets --locked` with the
CI profile settings took **74.392 s**, below the previous 86.8-second isolated
check. Debug information and incremental output are disabled for this compile-only
lane; removing cache save/restore avoids the previous job's archive overhead.
The workflow continues to report isolation wall time in its log and summary.

`npx tsc --noEmit` with the 8192 MiB heap, `npm run typecheck:fast`, touched-file
ESLint, `npm run rule-check -- --base=origin/main`, `npm run test:classify`, and
actionlint all pass. Rule-check has zero eligible files because production code
is `.mjs` and the TypeScript changes are tests.

Full `npm test`: **1,242 files passed, 3 skipped; 9,058 tests passed, 5 skipped,
0 failed**, in **210.78 s**. No tests moved. Fixture paths are canonicalized for
macOS's temporary-directory alias. No native packaged files were added.

This maintenance PR edits the guard itself and therefore requires `shell-work`;
the unlabelled attack paths are exercised independently by the tests above.
