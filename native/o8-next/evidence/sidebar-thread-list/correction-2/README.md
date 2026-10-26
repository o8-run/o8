# Sidebar correction round 2

The five tests in `src/surfaces/sidebar/race_tests.rs` were written and run red
through the real app shell, GPUI window input dispatch and production fixture
routes before changing row identity or save completion. Their captured tails
are in `red-tail.txt` and `green-tail.txt`: **0 passed / 5 failed → 5 passed / 0 failed**.

The mouse cases press A, promote B through a real message POST and global stream,
paint the reordered list, then release over B or over A's new position. They
assert that the replacement never opens and that moved A still activates. The
moved-thread case also checks keyboard focus after another live reorder.

The save cases start A's rename through Enter, enter a newer draft through real
window keyboard dispatch before draining background HTTP, then let A's PATCH
complete. This uses the same raw window entry as the repository's Projects tests;
GPUI's convenience input methods would otherwise drain the save before the next
input and miss the race. Assertions prove the original A title persisted, B's
rename or the new search/same-item draft remains intact, and retained rename
drafts can subsequently save to their own records.

Rows and navigation choice now use thread IDs; virtual indices are used only for
scroll coordinates and layout diagnostics. Save completion captures the draft's
item, editor revision and interaction generation. Success clears only its own
unchanged rename; stale completion cannot clear or report an error into a newer
editing context. Persisted metadata still refreshes after a successful write.

Targeted command:

```sh
cargo +1.97.1 test --release --locked --manifest-path native/o8-next/Cargo.toml thread_list::races -- --nocapture --test-threads=1
```

The PR body records the full native, TypeScript, Clippy, typecheck, classification,
lint and npm completion-gate results. All tests run headlessly with fixtures.

Completion gates: **95 native tests passed, 3 existing workloads ignored, plus
7 CLI tests passed**; **14 TypeScript files / 44 tests passed**; **full npm:
1,242 files passed, 3 skipped; 9,057 tests passed, 5 skipped**. Both 8 GB TypeScript
checks, Clippy (no sidebar diagnostics), touched-file ESLint, rule-check and
classification (including all five future-clock probes) pass. The original
95 source test function names remain, with five new regressions.

The changed renderer was measured again with the 2,000-thread fixture. Both
runs retain at most 22 rows, 10 first-paint samples and 500 scroll frames:

| Run | First paint p50/p95 | Scroll p50/p95 |
| --- | --- | --- |
| Concurrent completion gates | 689.315 / 1,278.873 ms | 4.178 / 15.621 ms |
| Other gates idle | 333.746 / 496.441 ms | 2.783 / 3.835 ms |

`run-concurrent.json` and `run-isolated.json` retain both sets of raw samples.
These are GPUI TestAppContext CPU scene timings with the test text system,
including HTTP bootstrap but excluding fixture startup and GPU/compositor timing.
