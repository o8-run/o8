# Registration verification

Final rebase: `9f44b02ea`, including the request ownership refactor.
All main and original surface test function names remain present. All **8 surface cases passed** through the real GPUI/fixture entries.

Current native result and any separate CLI run:

```text
Base: 9f44b02ea
shell::issues::tests::issues_errors_retry_stale_and_account_switch
test result: FAILED. 86 passed; 1 failed; 3 ignored; 0 measured; 0 filtered out; finished in 693.22s
Separate CLI integration run:
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.07s
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
```

The unchanged Issues case also failed [focused retry](issues-retry-9f.txt) at `issue-view-17` CPU paint. The broad suite remains non-green; all eight surface cases and seven separate CLI cases passed. No Issues code/test was changed.

Latest main/launcher TypeScript verification: **12 files / 110 tests passed**. Both TypeScript checks (8 GB heap), ESLint, rule-check, classification and Clippy passed after this rebase. See [gates](gates.json), [native](native-9f.txt), [surface green](green-9f.txt) and [measurements](run.json).

The full npm receipts below precede the final main updates; no second full npm run is claimed.

## Earlier verification and retained failures/retries

The earlier verified base was `eb715fd1c`. The final product trees matched the three-way merge
of the verified 506 snapshots and the updated main tree, preserving fixed
behavior. Shared main dispatchers are retained; tests are included from each
surface module with `shell::test_support`.

Current-main full cargo: 87 unit cases plus 7 CLI integration cases passed (94 total), with 3 existing ignored measurements. All eight Customize cases passed. Production API/store: 10 cases passed. The first broader attempt before staging the worktree o8d binary failed its prerequisite; the final full run is clean.

Each branch completed its full `npm test` on the 506 snapshot: **1,242 files /
9,056 tests passed**, with 3 skipped files / 5 skipped tests. Those receipts
remain in [npm-summary.txt](npm-summary.txt). No second full npm pass is claimed
after the final rebase. Main's seven changed TypeScript test files passed
**190 tests** after that rebase.

Both TypeScript gates passed on current main with an 8 GB heap. Clippy exited
zero; [diagnostics](clippy-summary.json) have no new surface warnings. Three
pre-existing suggestions remain outside changed hunks in shortcuts' shared
composer/terminal files. ESLint, rule checks and classification results are
recorded in [gates.json](gates.json). Existing ignored measurements were retained;
no tests were removed or disabled. Linux/headless CPU measurements establish
no macOS/GPU/compositor latency claim.

Refs #4548
