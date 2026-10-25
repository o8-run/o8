# PR #4657, correction round 2

The branch was rebased onto main at
`89c1e733308a5ceb1b11ad6082ffce71ae47605d`, then refreshed onto
`f059b4f0658930ebeac87a199cdd1a504a348839` when main advanced during verification.
Settings, Brain, Inbox and Projects retain their shell controls, production client
methods, fixture routes and tests.

Project deletion now uses the same runtime-stop confirmation as repository
removal. Every exclusive repository is checked before any project, membership
or registration is deleted. An unconfirmed runtime returns
`repo_runtime_stop_unconfirmed` with HTTP 409 from both project DELETE routes.
Shared repositories are retained and local folders are preserved.

Legacy ledger rows acquire an explicit SQLite partner ID during read-time
reconciliation. Panel mutations resolve either ID to that pair, and rename and
ledger synchronization update the existing identity. Native Switch reads the
resolved pair in the response; Open still resolves the fresh repository path.
Existing stable IDs take precedence over the legacy bridge. Native duplicate
name rejection remains in place.

`native/o8-next/src/projects_review_tests.rs` exercises GPUI shell controls,
fixture HTTP, production middleware/routes and persisted state. Before the fixes,
the strengthened duplicate-delete test and four new tests failed: **3 passed /
5 failed** across the original eight review cases. A further desktop-rename
ordering test failed separately (**0 passed / 1 failed**, project count 3 instead
of 2). All nine then passed: **9 passed / 0 failed**. `red-tail.txt`,
`red-legacy-desktop-tail.txt` and `green-tail.txt` retain the outputs.

The strengthened delete test requires exactly the original Beta and its
repository to remain, checks memberships and canonical repository paths, and
rejects any Alpha resurrection under another ID. The runtime test first proves
that direct repository removal returns 409, then requires native project Delete
to preserve the project, its membership and its repository with the same error.
Legacy tests start on a different empty project so stale selection cannot mask
a failed Open or Switch; rename must change both stores without adding a project.
The desktop PATCH also resolves the pair before updating SQLite, preserving the
ledger alias even before native's first read. The additional test deletes that
renamed identity and requires only the bystander project and no repositories.

Runtime adapters load only when an actual removal requests confirmation, keeping
project reads out of worker initialization. Six existing unit suites covering
read-time imports, runtime discovery and saved sessions pass all 23 tests.

Final gates on the refreshed base:

- Full native suite: **66 unit tests and 7 CLI tests passed / 0 failed**;
  **3 ignored** measurement workloads.
- Full `npm test`: **8962 passed / 0 failed / 5 skipped**, across **1240 passed /
  0 failed / 3 skipped** files.
- The combined shell suite, including Projects, Settings, Brain and Inbox:
  **32 passed / 0 failed**, including all nine review regressions.
- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` and
  `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:fast`: passed.
- ESLint on the 11 touched TypeScript files: passed.
  `npm run rule-check -- --base=origin/main`: 11 files, zero violations.
- `npm run test:classify`: **1236 hermetic / 886 resource-owning**; no
  classification diff. Rust formatting and `git diff --check`: passed.
- Production route suites `tests/project-delete.test.ts`,
  `tests/projects-switcher-real-path.test.ts`,
  `tests/empty-project-projection-real-path.test.ts`,
  `tests/mission-project-capture-real-path.test.ts`,
  `tests/o8-next-shell-real-path.test.ts` and
  `tests/next-history-real-path.test.ts`: **33 passed / 0 failed**.

One earlier native run failed the existing worker steering assertion in
`native/o8-next/src/worker_tests.rs:133` (observed `send-next`, expected
`steer-now`). The final full rerun, including that test, passed. `suite-tail.txt`
retains this observation and the final suite results.

Reproduce the review cases with:

```sh
cargo test --locked --manifest-path native/o8-next/Cargo.toml --bin o8-next shell::tests::projects_tests::review -- --nocapture --test-threads=1
```
