# Retained memory source verification

All probes use synthetic, isolated data. They call production routes, completion capture, recall readers, durable stores and packet prompt assembly. Model/embedding services and notifications are substituted. No installed-app, account or paid-provider acceptance is claimed.

| Boundary | Regression coverage |
| --- | --- |
| Inspect and select | Customize → Instructions lists retained feedback and all outcome inventory, including older/expired rows. Pagination, search, project selection, errors and inline cancellation/confirmation retain their existing component assertions. |
| Project authority | Project A and B share a registered repository; a third project owns another repository. Foreign IDs return 404. Recall searches A → B → A without foreign outcomes or outcome-derived facts; project filters run before FTS caps. |
| Durable forgetting | Deletion atomically records SHA-256 content/provenance exclusions, removes equal-content legacy aliases and their facts/queue entries, and advances the recall revision. Original approval/steering audit and completion receipts remain evidence. |
| Recapture and restart | Identical transcript capture with changed generated IDs, inventory/timestamps or pre-upgrade NULL fingerprints cannot restore forgotten content. Normal database reopen upgrades old exclusion ledgers before either new or already-open connections write. Unrelated provenance and retained siblings remain usable. |
| Current writers | Closing a retained outcome updates its fingerprint; stale summary/provenance updates with unchanged fingerprints remain held. Compact receipts carry the original ledger fingerprint rather than hashing truncated text. |
| Cached answers | Both streamed HTTP answers and nonstreamed answers reject a semantic-cache hit when another process commits deletion during scope selection or while embedding lookup is paused. Retrieval restarts with retained content. |
| Worker continuity | Dependent dispatch, completion receipts, attempt learnings and handoff assembly honor exclusions/revisions. Owned CLI and ACP sessions rebuild stale packet prompts and start fresh provider threads; current newly assembled handoff text survives launch. Pi stores conservatively refuse stale packet history with a fresh-dispatch diagnostic. |
| Pending remote work | Cloud worker pickup cancels a queued pre-forget packet prompt and returns 409 without its text; job-status withholds it too. A current-revision queued job remains deliverable. |

Primary tests: `forget-project-matrix-real-path.test.ts` (31 cases), `forgotten-content-project-recall-real-path.test.ts` (5), `forgotten-answer-cache-real-path.test.ts` (4), `hermes-worker-real-path.test.ts` (6), `pi-forgotten-context-real-path.test.ts` (2), and `cloud-forgotten-context-real-path.test.ts` (1). The supporting correction, deletion, attempt, quota, completion-retirement, authorization and UI tests run separately. Exact red/green tails and final check results are recorded in the PR.

Legacy exclusions without content/provenance cannot prove which packet fragment was forgotten. Their packet memory is conservatively held; this does not delete the original audit. Pi stale provider histories require a fresh dispatch rather than editing opaque provider files. Source verification does not award completion credit before merge.
