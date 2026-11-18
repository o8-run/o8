# Server phone tool handlers

Historical reference: the phone voice HTTP routes and WS handlers have been removed. The contracts below describe the former implementation.

Phone voice calls now run in the server without a webview or Rust shell (#6130). The authenticated tool route preserves the session grant and scope transform, then uses `phoneToolServer` in `src/lib/symon/execution/server.ts`. Its registry is created with `phoneToolHandler` and held on `globalThis.__o8PhoneToolServer`, so separately bundled tool and confirmation routes share the same calls. Native transport continues to forward both routes to the WS process; classic transport owns them in Next.

The route overwrites `__symonSessionId` and `__symonCallId`. For a supported gated tool it awaits `PHONE_TOOL_REVIEW_BUILDERS[tool]` with scoped arguments before `start()`. Preparation failures return `tool_failed` and create no card. Request review text is ignored. Concurrent preparation is shared per session/call. Re-POST attaches before rebuilding a review and returns the original card or terminal result, even when targets have since changed.

The confirmation route calls `decide()` and projects its result into the existing resolution shape. First decision wins; duplicate decisions replay that resolution without changing consent. Denial and the two-minute confirmation expiry fail closed. DELETE calls `interrupt()` and preserves `delivered`/`wasActive`. Early interrupts remain tombstones. Active cancellation must settle within one second or the result is `interrupt_delivery_failed`. Completed calls and early interrupts retain at most 1,000 entries for five minutes. Restart loses this process-local state and approval receipts.

Session minting wraps static catalog schemas as `{ type: 'function', ...schema }` and applies the existing Code or o8 selectors in their existing order. The o8 pack appends connected tools from `getSymonMcpCatalog`; the Code pack stays frozen. Connected calls use `callSymonMcpTool` after an explicit destructive-class card names the server tool and its arguments. Internal correlation fields are excluded from MCP arguments. The MCP transport currently cannot cancel an in-flight request; interruption can report an unknown outcome rather than claim cancellation succeeded. No persisted server voice selection exists, so minting uses `DEFAULT_VOICE`.

Phone voice no longer reads or stops deleted desktop live voice, polls its status, or ends its webview machine session. Existing WS confirmation mirroring already uses the card returned by the tool route and its own correlated tracker, so it needs no new route or protocol message. Desktop Remote mode and the separate text planner retain their existing bridge helpers. The WS relay, text planner, and machine cleanup helpers have since been removed with Symon.

## Transport choices

Control-plane tools use the same authenticated loopback API routes as the classic bridge. The routes own authorization, governance, idempotency, live process control, and publication. Importing their backing services directly into the WebSocket process would skip those route checks and, for orchestration state, introduce a second process owner. The same choice covers status, needs-me, team inbox, Brain questions, attention receipts, review evidence, wait, recap, usage, panel reads, dispatch, delegation, steering, rerun, reset, stop, approve, and reject.

Hosted terminals use the same bearer-authenticated WebSocket host endpoints. The attachment registry is private to that process; no reusable library exposes its live inventory or input ownership check. The existing endpoint still refuses controlled or missing sessions. The approval builder reads the current inventory before naming a target.

Watch list and cancel call `listSymonWatches` and `cancelSymonWatch` in process. These are the exact record functions used by the HTTP routes and contain no process-owned execution state. Cancellation does not claim or run a saved plan. The builder reads the persisted condition instead of the classic shell's cached wording.

## Deliberate differences from the classic shell

- Required-argument refusals use concise key-based messages instead of the classic shell's conversational hints. Model-facing refusals keep the `{ error }` shape.
- Polling, HTTP calls, and correlated retries honor cancellation. HTTP errors expose the route and status rather than echoing potentially sensitive response bodies.
- Ports and bearer credentials resolve through the shared server helpers instead of the classic shell's private fallback resolver. Imports do not resolve credentials or execute a tool.
- Correlation identifiers use random UUIDs instead of a process/time counter. Each retry preserves the same body and identifier. Review tokens use the platform cryptographic random source with no weak fallback.
- The server does not nudge the classic shell's worker-pulse poller after mutations. Server routes retain their existing publication behavior.
- Confirmation summaries use the existing transcript credential redaction policy. Packet-reset cards also state whether the worktree will be wiped or kept. Dispatch cards name the registered repository rather than its filesystem path.
- Terminal writes with a repository scope require that scope to resolve and match the hosted terminal's recorded working directory. Watch cancellation checks the authenticated session, and a supplied repository path, before acting. Unknown watch targets fail before a card instead of falling back to a bare id.
- Brain questions with an explicit repository path require a registered repository and must match an accompanying immutable repository scope.
- The receipt store remains process-local, like the classic bridge. Restart invalidates receipts. It binds approval id, packet id, title, HEAD, diff fingerprint, governance fingerprint, and a five-minute expiry; execution burns the token before the final evidence request. A fresh review invalidates earlier tokens for that approval.

## Git and GitHub

The server now handles `git_status`, `git_log`, `repo_commit_diff`, `gh_pr_list`, `gh_issue_list`, `gh_issue_view`, `gh_pr_view`, `gh_triage`, `gh_issue_create`, and `gh_comment`. GitHub views preserve the untrusted observed-data envelope, bounded fields and threads, review states, checks, and three-page REST limits. Triage stays read-only and uses the same exact-since REST streams and 30-item global limit. Commit diffs preserve the 15 KiB patch budget, metadata and filename limits, omitted-file count, and structured error codes.

All process working directories come from the existing registered repository scope helper. The commit-diff path must exactly match a registered path before canonicalization. Scope failures prevent process launch. Cross-repository triage uses only registered repositories, deduplicates resolved remotes, and honors an injected repository scope. Write review builders name the resolved registered repository and issue title or comment target and opening text. Existing redaction applies to both sentences. Execution still requires the call registry's confirmation gate.

These are the Git/GitHub differences from Rust:

- Executables resolve from PATH instead of preferring fixed installation directories. The child inherits the environment, as the Rust helper does. Commands use argument arrays with no shell; text stays in separate argument values. Git uses literal pathspecs and explicit option boundaries so filenames cannot select pathspec magic. Refs retain Rust's strict allowlist; `rev-parse` also uses `--end-of-options`.
- Each child has a 30-second deadline, an 8 MiB stdout ceiling, and a 64 KiB stderr ceiling. Exceeding the stdout ceiling refuses rather than returning incomplete JSON or a partial file inventory. Rust's subprocess helper has no such resource bounds. Existing model-facing patch, body, thread, and pagination truncation remains separate from these process bounds.
- Cancellation kills the process group (or the process tree through `taskkill` on Windows) and rejects the call. Rust's blocking helper does not support cancellation. The server does not attempt a write retry after a timeout or cancellation.
- Registered scope resolution replaces the classic fallback resolver. Immutable repo id/path pairs must agree, and injected scope also restricts triage. Numbers must fit JavaScript's safe integer range rather than Rust's full unsigned 64-bit range.
- Thrown scope and process errors pass through the existing redaction policy. Commit-diff failures retain `{ error, detail }`; other failures retain `{ error }`. Registry failures during diff repository preparation use `repo_registry_unavailable` with detail. Missing, unresolved or unregistered exact paths use `repo_not_tracked`. Some validation and Git failure detail wording is shorter; Git failures use the common “could not inspect” prefix instead of separate resolve/show prefixes.
- Comment review sentences include bounded opening text, as required for the server review, while Rust's comment readback omits the body.

The nine remaining deferred tools are `symon_execute_plan`, `symon_machine_list`, `symon_machine_switch`, `symon_ledger_recent`, `symon_ledger_undo`, `symon_watch`, `symon_watch_run`, `agent_turn`, and `escalate`. They still return `desktop_unavailable`. Unknown names return `unknown_tool` without dispatching.

## Verification boundaries

The added focused integration test drives the dispatcher over authenticated loopback HTTP with persisted lane state, the existing child PTY host fixture, the production agent-control route with its execution-service fixture, and real watch registration and cancellation records. Other control endpoints use bounded HTTP response fixtures to verify request arguments and model result projections. It does not claim installed phone or desktop acceptance. The Git/GitHub integration test drives the dispatcher with a registered temporary Git repository and a PATH-first recording GitHub CLI fixture. It checks argument vectors and stdin, refusal before spawn, bounded UTF-8 output, review targets and redaction, and cancellation of a long-running process and its child. GitHub service acceptance is not claimed.

Route tests now drive a temporary Git repository and authenticated HTTP control-plane fixture through the tool and confirmation handlers, including independently evaluated route bundles. They cover trusted review text, replay, approve/deny/expiry, duplicate decisions, interrupts, scope refusal, deferred tools, unknown names and preparation failure. Mint tests cover the server catalog, pack selection, MCP schemas, default voice and minting without a host. Native transport tests retain the operator gate and scope checks with Next stopped and add server-owned deferred/unknown results.

Live phone acceptance remains required. The nine deferred tools remain unavailable; phone voice no longer executes the classic shell action ledger or plan machinery. WS attempt tracking remains in place. No phone app or protocol shape changes are included.
