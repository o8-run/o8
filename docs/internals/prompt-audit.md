# Prompt audit

Audited 2026-10-24 against the official guides linked below. Baseline: `31885055d88d1faef04c84646839e696a81e1780`.
The [source inventory](./prompt-inventory.md) lists each discovered template or tool description,
its source, purpose, and before/after static fragment budget. Keep protocol markers, JSON field
names, enum values, tool names, authority boundaries, and payer policy stable when editing prose.

## Guidance applied

- [Provider A overview](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview): define observable success and a way to evaluate it before tuning a prompt. Prompt size alone is not an outcome metric.
- [Provider A prompting reference](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices): give direct instructions and context, distinguish instructions from supplied data, and use examples for formats that need them. Replace aggressive tool-use reminders with ordinary instructions. Keep the task bounded instead of encouraging speculative extra work.
- [Provider A latest migration guide](https://platform.claude.com/docs/en/models/fable-5-1/migration-guide): state required tools and turn-specific actions explicitly; re-evaluate effort and completion behavior on representative tasks. Keep conversation history and thinking blocks intact. This audit changes prompts, not model selection, API parameters, or stored effort settings.
- [Provider B current prompting guide](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#prompting-best-practices): specify the intended outcome, constraints, authority, and when delegation helps. Complete authorized work, prepare reviewable results before asking for missing authority, and make instruction priority explicit. Match verification to risk. Audit skills for conflicting instructions; do not infer task outcomes or allowance savings from token estimates.

## Render and delivery map

| Surface | Production path and purpose |
| --- | --- |
| Direct worker launch | `api/orchestrator/delegate/route.ts` builds the project/task brief, pins any review source, and adds `buildPacketCompletionInstructions` before `launch_session`. |
| Scheduled launch | `buildPacketPrompt` adds outcome ownership, mode, task contract, session rules, dependencies, corrections, alignment, scope, verification, and the same completion builder. Optional project, tool, memory, preservation, read-budget, and UI sections remain conditional. |
| Completion | `self-review.ts` retains the JSON receipt, independent-review boundary, retry limit, lint policy, invariant coverage, confidence, partial/blocked states, and read-only finding receipt. One shared builder owns the commit and read-only completion rules. |
| Steer | `operator-mission-service/steer.ts` forwards the authorized operator message to the owned runtime. It has no fixed instruction prefix. Size is `ceil(message.length / 4)`; routing, session ownership, holds, and idempotency checks remain in code. |
| Rerun | `operator-mission-service/rerun-with-feedback.ts:appendFeedback` replaces an earlier feedback section, then uses the normal packet renderer. It does not stack completion rules or old feedback. The heading is fixed; base task and feedback are variable. |
| Handoff | `renderBackendSwitchHandoffPrelude`, slash-command handoff/recall, and compaction preserve obligations and distinguish historical evidence from active instructions. Tool-looking text stays escaped; omitted layers remain explicitly unknown. |
| Orchestrator | `buildOrchestratorSystemPrompt` loads `orchestrator.md` and scopes tools/backend sections to the actual surface. The fallback remains separate. Removes the conflicting forced-dispatch-after-two-reads rule; keeps review, mode, approval, pinning, correction, and truthful-receipt rules. |
| Review | Versioned auto-review and blind-second-pass builders preserve SCOPE, GUARD, COVERAGE, PROCESS, MINIMALITY, COMPLETENESS, execution-path traces, exact HEAD binding, operator supplementation, publication handoffs, and distinct verdict formats. |
| Tools | MCP catalogs carry selection, argument, capability, payer, stop, and ownership rules in their descriptions and schemas. Already concise descriptions are retained; the shared mission guidance loses prose emphasis only. Native tool descriptions are included in the inventory. |
| Other model inputs | The inventory also covers extraction, retrieval/classification/composition, judgment, specification/CI review, suggestions, dictation, voice, native screen prompts, and offline benchmark prompts. Historical benchmark templates stay unchanged. Auxiliary emphasis edits preserve all other source tokens with a checked baseline digest. |

## Size measurement

No model tokenizer is installed for this purpose. Use the approximation
`ceil(UTF-16 characters / 4)`. It is not a provider token count.
The source inventory counts literal fragments across branches and excludes dynamic substitutions;
never sum those rows as a request size. Native source estimates also retain escaped characters.

The table below measures actual rendered strings from fixed, isolated fixtures in
`src/lib/prompts/prompt-audit.test.ts`. Task text, branch, contract, tool catalogs, and repository
placeholders are held constant. The baseline run captured the original builders before rewriting;
Solo baselines use the unchanged production scoper over the baseline template. Read and write
workers differ deliberately. UI capture instructions appear only for the UI fixture. After values
include the verification-command migration retained when rebasing onto main.

| Rendered fixture | Before ~tokens | After ~tokens |
| --- | ---: | ---: |
| `worker-write` | 1973 | 1942 |
| `worker-read` | 818 | 818 |
| `worker-ui` | 2369 | 2237 |
| `orchestrator-claude` | 8188 | 7343 |
| `orchestrator-claude-solo` | 1956 | 1466 |
| `orchestrator-codex` | 7750 | 6912 |
| `orchestrator-codex-solo` | 1953 | 1463 |
| `orchestrator-pi` | 7749 | 6911 |
| `orchestrator-pi-solo` | 1952 | 1461 |
| `orchestrator-muse` | 7752 | 6914 |
| `orchestrator-muse-solo` | 1955 | 1465 |
| `review-false` | 1304 | 1264 |
| `review-blind-false` | 779 | 779 |
| `review-true` | 1914 | 1873 |
| `review-blind-true` | 1027 | 1027 |
| `tool-o8_launch_task` | 117 | 117 |
| `tool-o8_stop_task` | 74 | 74 |
| `tool-cortex_shared_team_status` | 72 | 72 |
| `tool-cortex_finish_shared_team` | 75 | 75 |
| `tool-cortex_reconcile_shared_team` | 103 | 103 |
| `tool-cortex_correct_workers` | 136 | 136 |
| `tool-cortex_wait_workers` | 97 | 97 |
| `tool-cortex_worker_catalog` | 69 | 69 |
| `tool-cortex_launch_agent` | 146 | 146 |

Reproduce current rendered sizes with:

```sh
O8_PROMPT_AUDIT_OUTPUT=/tmp/prompt-sizes.json npx vitest run src/lib/prompts/prompt-audit.test.ts
node scripts/prompt-audit.mjs --base 31885055d88d1faef04c84646839e696a81e1780 --write
```

Custom repository instructions, task text, operator steers, saved library entries, retrieved rows,
transcripts, allowlisted skills, and externally supplied MCP/plugin descriptions are runtime data.
Their source carriers are inventoried; their sizes depend on the actual request and are not fixed
repository constants. This inventory is an offline source audit, not a capture of every possible
installed plugin or conversation. The scanner is conservative and can include prompt-adjacent
carrier literals; a static row does not prove that a branch ran.

## Verification and limits

The rendered-rule tests exercise packet assembly in both modes, UI restrictions, four orchestrator
backends with and without tools, both reviewer passes with and without a contract, and registered
tool policy descriptions. The delegate-route test checks the delivered completion contract, including the required self-review block and committing all task changes and new files after checking status. Rendered VERDICT templates must match the resident-process summary marker.
Existing persisted handoff, session-rule, alignment, contract, and dispatch tests cover their real
entry points. Casing-only auxiliary changes have a baseline source-token retention check.

The initial required-rule run failed 8 of 10 cases, including aggressive prose and the forced
read-count delegation conflict. Correction-round assertions failed 6 of 27 cases before restoring
the explicit completion gate and fixing the VERDICT punctuation. These are regression receipts,
not model-performance evaluations.

| Outcome metric on fixed tasks | Before | After |
| --- | --- | --- |
| Model completion rate | Not measured | Not measured |
| Model review findings | Not measured | Not measured |
| Actual input/output tokens per completed task | Not measured | Not measured |
| Effort versus accepted outcome | Not measured | Not measured |

Focused verification passed 168 cases across 22 files in aggregate after fixture environment isolation. One additional case in `tests/delegate-dispatch-merge-real-path.test.ts` remains failing at the expected retired-workspace snapshot assertion (line 287); its worker launch and merge completed in the isolated fixture, but cleanup produced no snapshot receipt. This is an unresolved integration limitation, not a prompt-quality result.

TypeScript passed with the CI 8 GB heap setting after the default heap was exhausted. Touched-file lint, changed-source rule-check, test classification, and local documentation links passed. The full local test suite was not run.

Correction-round verification passed 121 focused tests across 14 files, including all 20 prompt-audit cases. TypeScript, touched-file ESLint, rule-check, test classification, and 637 local documentation links passed again.

After rebasing onto main, 135 focused tests across 17 files passed, including the updated verification-command assertions and the persisted handoff transport test. `npm run typecheck:fast`, touched-file ESLint, rule-check, classification, and documentation checks passed. The classification manifest was regenerated with its script. No Rust crate or Cargo file changed relative to main.

No live model tasks were replayed, and no outcome improvement is claimed.
Source and rendered-input sizes do not establish total task cost, completion quality, latency,
weekly allowance use, or acceptance. Behavioral replay remains an explicit evaluation follow-up.
