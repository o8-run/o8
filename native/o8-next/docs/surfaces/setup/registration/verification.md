# Registration verification

Final rebase: `9f44b02ea`, including the request ownership refactor.
All main and original surface test function names remain present. All **5 surface cases passed** through the real GPUI/fixture entries.

Current native result and any separate CLI run:

```text
Base: 9f44b02ea
test result: ok. 84 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 688.33s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
```

Latest main/launcher TypeScript verification: **12 files / 110 tests passed**. Both TypeScript checks (8 GB heap), ESLint, rule-check, classification and Clippy passed after this rebase. See [gates](gates.json), [native](native-9f.txt), [surface green](green-9f.txt) and [measurements](run.json).

The full npm receipts below precede the final main updates; no second full npm run is claimed.

## Earlier verification and retained failures/retries

The earlier verified base was `eb715fd1c`. The rebased product tree matched the three-way merge of the verified 506
snapshot and updated main. The additional registered-workspace regression
below then restored the original conversation-based first-run trigger. Shared main dispatchers are retained; tests are included from each
surface module with `shell::test_support`.

Current-main full cargo: 82 passed, 1 failed, 3 ignored in the unit binary. The unchanged worker queue case failed under concurrent checks and once in a grouped retry, then passed alone (worker-retry.txt). All four original setup cases passed; all seven CLI integration cases passed separately. Earlier full cargo on 506 passed 90, with 3 ignored. No worker code or test was changed.

Each branch completed its full `npm test` on the 506 snapshot: **1,242 files /
9,056 tests passed**, with 3 skipped files / 5 skipped tests. Those receipts
remain in [npm-summary.txt](npm-summary.txt). No second full npm pass is claimed
after the final rebase. Main's seven changed TypeScript test files passed
**190 tests** after that rebase.

The registered-workspace regression additionally failed before correcting the first-run predicate. The final focused run passed **21 cases**: all five setup cases and all sixteen main Projects cases. A registered project without saved conversations still enters setup. See [red](registered-red.txt) and [green](registered-green.txt).

Both TypeScript gates passed on current main with an 8 GB heap. Clippy exited
zero; [diagnostics](clippy-summary.json) have no new surface warnings. Three
pre-existing suggestions remain outside changed hunks in shortcuts' shared
composer/terminal files. ESLint, rule checks and classification results are
recorded in [gates.json](gates.json). Existing ignored measurements were retained;
no tests were removed or disabled. Linux/headless CPU measurements establish
no macOS/GPU/compositor latency claim.

Refs #4548
