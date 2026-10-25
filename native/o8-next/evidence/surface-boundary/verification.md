# Surface boundary verification

Issue: #4705. Baseline: `160576643` on main. Linux, Node 22.23.4, Rust stable.
No app, real account, native UI session or external application was used.

The issue and merged #4689/#4696 establish one shell inventory entry and
surface-owned request adapters. The open PR patches inspected before implementation
covered these shared seams:

| PR | Shared edit patterns |
| --- | --- |
| #4658 | Shell registration, surface registry, shared composer renderer |
| #4660 | Shell registration and registry extensions |
| #4661 | Shell registration, surface registry, shared composer renderer |
| #4665 | Shell registration and shared shell tests |
| #4670 | Shell registration, registry extensions, shared composer key context |
| #4700 | Shell lifecycle/view/tests/helpers and dev-server dispatch |
| #4702 | Shell palette/view/tests/helpers and registry extensions |
| #4704 | Shell state loading and shared test module registration |

## Red and green

`tests/next-surface-boundary-real-path.test.ts` was written before the CLI. The
initial executable test run failed because the entry point did not exist:

```text
Error: Cannot find module '<repo>/scripts/next/check-surface-boundary.mjs'
Test Files  1 failed (1)
Tests       7 failed | 1 passed (8)
```

The first sandboxed attempts could not spawn child processes. The retained result
above is the subsequent run with process execution enabled and the implementation
withheld. The rejection-only lookalike case passed even without an entry point;
its final assertions also require the shared-file diagnostic.

Hostile review found the missing composer seam. Its new case was run red before
adding `composer*` to the shared inventory:

```text
rejects replacements, deletions and renames of every protected shared seam
AssertionError: expected 0 to be 1
Test Files  1 failed (1)
Tests       1 failed | 7 skipped (8)
```

Final focused run, including the existing `tests/workflow-policy.test.ts`:

```text
Test Files  2 passed (2)
Tests       15 passed (15)
Duration    1.62s
```

The boundary file has **8 passing tests**, up from **7 failures and 1 passing
rejection-only case**. Its fixtures use actual Git branches/worktrees and the
actual Cargo CLI, offline, with a tiny dependency-free Rust crate. They verify
one registration, shared edits, the exact shell-work label, a second entry,
unrelated changes, cleanup and wall-time reporting. Temporary roots are
canonicalized with `realpath` for macOS's temp-directory alias.

## Hostile review

The three most likely false passes/failures and their executable regressions:

1. **Net line counts or rename detection hide shared changes.** The replacements,
   deletions and renames test checks additions plus deletions for shell state,
   view, registry, client, retained renderer and composer, plus dev-server removal.
2. **A registration-shaped line outside the inventory passes.** The lookalike
   test rejects an entry outside the macro and one with a trailing statement,
   and requires a one-line path/count refusal.
3. **Building HEAD hides excluded support; diffing two tips erases newer main.**
   The advanced-main test adds a new registration and a caller that requires it,
   then applies the older PR. It passes without erasing main. A surface depending
   on an excluded manifest feature fails the isolated Cargo check. Cleanup is
   asserted on both paths.

## Native entry point and timing

In addition to the small test crate, a disposable branch from main added a real
`BoundaryProbe` command and its own `impl Client` through the production registry.
The complete check staged that module and one registration on main and passed:

```text
o8 next surface boundary: 1 surface files on main; cargo check --all-targets --locked
o8 next surface boundary: isolated cargo check passed
o8 next surface boundary wall=11.292 s
```

A second warm run under concurrent verification took **15.321 s**. The initial
native `cargo check --all-targets --locked` took **66 s** with cold dependencies.
The real probe was then made dependent on an excluded manifest feature:

```text
error: surface needs excluded shared support
error: could not compile `o8-next` (bin "o8-next") due to 1 previous error
o8 next surface boundary wall=16.222 s
```

CI uses the same entry point, checks shared edits before restoring a build cache,
and prints each invocation's wall time to its log and job summary. It triggers
only for the two requested directories and reruns on label changes.

## Completion gates

- `npx tsc --noEmit` with `NODE_OPTIONS=--max-old-space-size=8192`: passed.
- `npm run typecheck:fast`: passed (the supported Linux TypeScript fallback).
- ESLint on the new CLI and test: passed.
- `npm run rule-check -- --base=origin/main`: passed; the repository filter
  excludes test files and `.mjs`, so there are zero eligible source files.
- `npm run test:classify` and `npm run test:classification:check`: passed.
- Workflow YAML parsed and the existing workflow policy tests passed.
- The first full `npm test` found the new Rust action's mutable tag: **1 failed,
  9,056 passed, 5 skipped**. The action now uses the existing full commit pin.
- Final full `npm test`: **1,242 files passed, 3 skipped; 9,057 tests passed,
  5 skipped, 0 failed**, in **175.13 s**. Before/after the action pin:
  **1 failure / 9,056 passes → 0 failures / 9,057 passes**.

No release, version, deployment or publishing files changed.
