# Activity verification

The baseline had no Activity command or pane in the opt-in shell. Four regression
scenarios failed through the real command palette before implementation:
`0 passed; 4 failed`. The initial tests were subsequently moved from
`src/shell_tests.rs` to `src/activity_tests.rs` within the same shell test module.
Their original output is retained in `red-entry.txt`.

Additional red tails cover a lost mission-stop receipt (`red-receipt.txt`),
keyboard filter navigation (`red-keyboard.txt`), and automatic CI-detail recovery
after the server cooldown (`red-cooldown.txt`), and exact-SHA grouping that
keeps a CI-detail action reachable (`red-grouping.txt`). These fail through GPUI controls
and the production fixture HTTP routes. They do not substitute helper-only tests
for reachability.

Implemented actions: repository/all scope, six filters, refresh, row expansion,
PR/CI retry, external commit/issue/PR/CI links, CI-to-PR links, worker navigation,
packet hold/release, and mission stop with persisted receipt replay. Invalid
authority cannot mutate the packet. Malformed CI identities cannot replace the
last successful detail. Failed remote reads retain per-scope streams, successful
empty reads replace them, and local-only workspaces cannot acquire another
workspace's remote snapshot.

See `parity.md` for the incomplete acceptance items. See `green.txt` for the final
headless output and `run-1.json` through `run-3.json` for fixture frame timings.

Final results:

- Activity: 8 passed, 0 failed. Initial entry-point regression: 0 passed, 4 failed.
- Full native suite: 44 unit/GPUI tests and 7 CLI tests passed; 3 existing explicit
  measurement workloads ignored. Built the existing `o8d` binary with
  `--features experimental-http --bin o8d` for the saved-route fixture test.
- Launcher: `tests/o8-next-shell-real-path.test.ts`, 6 passed.
- Full `npm test`: 1,233 files passed, 3 skipped; 8,896 tests passed, 5 skipped.
- Typecheck fast, tsc with 8 GiB heap, touched TypeScript ESLint, rule-check against
  `origin/main`, classification, and the existing native license audit passed.

The first full hermetic run hit `git status` ENOBUFS in the release-artifact test
because the scratch toolchain was untracked. A local Git exclusion for `work/`
corrected the environment. That unchanged file passed 15 tests in isolation, then
the complete hermetic suite passed. No release files were modified.

Three fixture runs: first CPU frame 79.4 ms median; 77.6–83.7 ms range; loaded content 100.5 ms median; 95.9–102.6 ms range;
interaction 15.6 ms median; 55.3 ms p95 (27 samples). No baseline timing existed because the shell had no
Activity surface. See the receipts and `summary.json`; these are debug-build
CPU scene timings, not physical presentation latency.
