# Retained memory final local matrix

Written before the final-round production changes for #4697. All data is synthetic and isolated.

Each row runs with both timestamp packet siblings selected for forgetting. Siblings share the first 16 packet-ID characters, provider session and completion timestamp. Both approval rejections and lane steering are exercised. Project A and B share one repository; the third project uses another repository.

Initial capture has live inventory with a finish time five seconds after the transcript. Re-capture removes that inventory while retaining the exact transcript. Outcome identity must remain stable across this transition; managed captures use the durable provider-run finish time.

| Target | Inspect | Forget | Identical re-capture | Restart | Dependent dispatch |
| --- | --- | --- | --- | --- | --- |
| Project A | A sees only A; own IDs listed | Own IDs return 200 | Forgotten IDs absent; sibling retained | Reopen keeps exclusions and inventory | Cold prompt omits forgotten completion, retains sibling |
| Project B, shared repo | A cannot see B; B sees B | A gets 404; B gets 200 | Same checks under B identity | Same checks after reopen | Same cold and warm dependency checks |
| Other repository | A cannot see other project; owner sees it | A gets 404; owner gets 200 | Same checks under other project identity | Same checks after reopen | Same cold and warm dependency checks |

`tests/forget-project-matrix-real-path.test.ts` runs all 30 cells through real route handlers, persisted approvals/lane events, production completion capture and production dependency prompt assembly. Provider transcript and notification side effects are substituted. Each dependent-dispatch cell starts a separate Node process. The existing `forget-dependent-dispatch` fixture also exercises the actual dispatch route and provider launch after restart.

The unheld retirement case remains a separate real Git preservation, removal and recovery check. Its timeout diagnosis and red/green tails are recorded in the PR verification section.

Initial red matrix: 28 failed, 2 passed (30 cells). A-scoped correction DELETE returned 200 for B's IDs, and identical packet prefixes produced identical outcome IDs. The inventory-disappearance variant then failed all six re-capture cells before timestamp canonicalization (6 failed, 6 passed, 19 skipped).

The unheld retirement fixture hit its 60-second aggregate deadline. Phase measurement completed in 58.0 seconds: fixture 2.7, completion through 12.0, maintenance through 43.2, preservation read through 43.6, first cold read through 51.8, Git recovery through 52.2 and second cold read through 58.0. Its aggregate budget is now 120 seconds; individual operation deadlines and every recovery assertion remain intact. The separate salvage and already-merged scenarios each retain the default 30-second deadline instead of sharing one aggregate deadline. No test is quarantined.
