# PR #4652 registration migration

Rebased on the per-surface registration contract from #4689 (`506ea06a1`).
The model, renderers and client method bodies match the previous pushed head
`a57dbcdf4`, apart from child-module filenames. Independent review found no
blockers and confirmed both corrected P2 protocols remain intact.

The surface owns its route, empty persisted slice, workspace view cache, factory,
focus, readiness and tests in `src/surfaces/pull_requests.rs` and its directory.
The cache retains the same entity across tab close/reopen, matching the old shell.
There are no new navigation controls or keyboard bindings. The existing shared
shell shortcuts and `PullRequests` persisted tab discriminator are preserved.

Main's dispatchers, state, shell tests, native README and TypeScript dev host are
unchanged. The shared shell has one inventory line. The two shared exceptions
are the private module include in `src/client.rs` (credential fields remain
private; transport methods are unchanged) and the required generated
`tests/test-classification.json` entry. Documentation and receipts live in
`docs/surfaces/pull-requests.md` and `docs/surfaces/pull-requests/`.

The disposable fixture now registers through
`scripts/next/surfaces/55-pull-requests.surface.ts`. Tests launch the existing
`dev-server.ts --pull-requests` entry point. Production PR handlers, middleware,
operator bearer, canonical fixture repository, authored GitHub transport,
response-loss behavior and merge-preview refusals remain in use. Other fixture
modes do not activate the PR entry.

## Red receipts

The existing palette test ran after keeping main's shared dispatcher and before
adding the surface registration:

```text
shell_pull_requests_opens_from_palette
the shell command palette must expose the repository pull request surface
left: 0; right: 1
test result: FAILED. 0 passed; 1 failed
```

The production HTTP test first ran through the common host without its PR entry:

```text
next-pull-requests-real-path.test.ts
AssertionError: expected 404 to be 200
Test Files 1 failed (1)
Tests      1 failed (1)
```

The moved palette test now also types notes, closes the tab and reopens it. It
failed before the workspace view cache was moved into the surface runtime:

```text
shell_pull_requests_opens_from_palette
closing and reopening must retain the PR view
left: EntityId(7v1)
right: EntityId(3v3)
test result: FAILED. 0 passed; 1 failed
```

## Green receipts

```text
native PR filter: 11 passed; 0 failed
TypeScript fixture regressions: 8 files passed; 20 tests passed
```

Native tests retain every existing function name in
`src/surfaces/pull_requests/tests.rs` and `shell_tests.rs`, including the draft
ownership and cross-worktree uncertain-delivery regressions. The TypeScript run
covered `tests/next-pull-requests-real-path.test.ts`,
`next-surface-registration-real-path.test.ts`, `o8-next-shell-real-path.test.ts`,
`next-settings-real-path.test.ts`, `next-brain-real-path.test.ts`,
`next-diff-review-real-path.test.ts`, `next-terminal-real-path.test.ts` and
`next-history-real-path.test.ts` (all under `tests/`).

Before/after: native shared registration edits fall from six files to one shell
inventory entry; the private transport include is the declared exception.
Unsent notes and shared delivery holds retain their previously corrected
behavior. View identity across close/reopen is retained by the surface runtime.

Clippy with `--all-targets` exits zero, with no diagnostics in the surface files
or changed lines. Its existing `Session::decorate` collapsible-if warning in
unchanged client code remains. Both TypeScript checks pass with the required
8 GiB heap, along with scoped ESLint, rule-check, classification and its check.
Classification reports 1,238 hermetic and 900 resource-owning tests.

The existing [parity table](../pull-requests.md) still identifies the unported
controls. This migration enables no additional PR actions. macOS/display
validation and the documented parity gaps remain open.

Full native completion: **90 passed, 0 failed, 3 explicit benchmarks ignored**,
plus **7/7 CLI tests passed** (97 passed overall). Full `npm test`: **1,242 files
passed, 3 skipped; 9,056 tests passed, 5 skipped; zero failures**.

The [test inventory comparison](test-inventory.json) confirms that all 83 tests
from the prior pushed head retain their names and pass/ignore statuses. The new
main baseline adds 17 tests; the resulting inventory is 100 tests including the
three ignored benchmarks. PR model, rendering and transport code remain unchanged.

Main advanced during verification to `c9acfe4b2` (the unrelated SQLite MCP fix).
The final rebase applied cleanly and changed no native surface, shared shell or
fixture files. After that refresh, the PR filter passed **11/11**, the production
HTTP fixture passed **1/1**, and Clippy, heap-bounded fast typecheck,
classification and rule-check passed again. Full-suite counts above precede this
unrelated base refresh; surface source and tests are identical across it.
