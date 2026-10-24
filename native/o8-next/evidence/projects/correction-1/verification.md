# PR #4657, correction round 1

P1: all native mutations bind stable project IDs. Native create/rename checks a
fresh snapshot and rejects duplicate display names. Rename uses the existing
panel PATCH by ID, keeping the ledger and project store aligned; description
updates retain that ID. Existing duplicate labels retain their distinct slugs,
and deleting one never selects another by its name.

P2: both Open controls carry repository IDs. After activation and a fresh
inventory load, Open resolves the current folder by ID, refusing a missing or
unregistered repository. A repointed path evicts the old workspace/view entries.

`native/o8-next/src/projects_review_tests.rs` drives the actual shell controls
against production middleware/routes and persisted fixture data. The four tests
were written first: both P1 cases and both P2 controls failed (0 passed, 4 failed).
After the fixes, all four passed. The duplicate-delete case checks that the
original Beta project and its exclusive repository registration survive. Both
repoint cases compare canonical paths and check removal of the old workspace.
The red receipt replaces only the owned temporary fixture prefix for portability
and trims trailing whitespace.

The rebase preserves main's Brain and Inbox surfaces and fixture routing. The
combined shell suite, including Brain and these regressions, passes 17 tests.

Rebased onto `origin/main` at
`6892d7c1c4c4c0ee0b47a8999ab7d00b9dbf0431`, retaining both sides of
`shell_tests.rs`, `shell_view.rs` and `scripts/next/dev-server.ts`.

Final verification:

- New review regressions: **0 passed / 4 failed before**, **4 passed / 0 failed
  after**. See `red-tail.txt` and `green-tail.txt`.
- Full native suite: **51 unit tests and 7 CLI tests passed**, **3 ignored**.
- `tests/o8-next-shell-real-path.test.ts` and
  `tests/next-history-real-path.test.ts`: **9 passed**.
- `npm run test:classify`: **1233 hermetic / 883 resource-owning**; no
  classification changes required for the new Rust test file.
- `NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit` and
  `NODE_OPTIONS=--max-old-space-size=8192 npm run typecheck:fast`: passed.
- ESLint on `scripts/next/dev-server.ts` and `scripts/next/projects-fixture.ts`:
  passed. `npm run rule-check -- --base=origin/main`: 2 files, zero violations.
- Rust formatting and `git diff --check`: passed.
- Final `npm test`: **8947 passed / 4 failed / 5 skipped**, across
  **1236 passed / 1 failed / 3 skipped** files. The four failures are all in
  `tests/pi-sdk-live-contract.test.ts`, whose dated fixture is expired. Running
  that file on an untouched detached worktree of the main commit above produces
  the same **0 passed / 4 failed** result and expiry error. No unrelated fixture
  or clock changes were made. See `suite-tail.txt`.

Reproduce the new cases with:

```sh
cargo test --locked --manifest-path native/o8-next/Cargo.toml review_p -- --nocapture --test-threads=1
```
