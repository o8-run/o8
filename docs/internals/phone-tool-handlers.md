# Server phone tool handlers

The dispatcher is deliberately unwired. It accepts already authenticated, scoped arguments through the existing `PhoneToolHandler` interface. It does not grant authority or replace the call registry's confirmation gate. This is a partial step toward #6130.

The caller must overwrite repository scope and `__symonSessionId` / `__symonCallId` from its authenticated session. Model input cannot select those fields. Before `start()`, select the tool's own entry in `PHONE_TOOL_REVIEW_BUILDERS`, await it, and pass its review with the same immutable arguments. A builder failure must stop the call. The final wiring must retain this binding across confirmation and execution.

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

Git/GitHub tools are deferred together: `git_status`, `git_log`, `repo_commit_diff`, `gh_pr_list`, `gh_issue_list`, `gh_issue_view`, `gh_pr_view`, `gh_triage`, `gh_issue_create`, and `gh_comment`. They return `desktop_unavailable`, as do the nine tools assigned to the following migration step. Unknown names return `unknown_tool` without dispatching.

## Verification boundaries

The added focused integration test drives the dispatcher over authenticated loopback HTTP with persisted lane state, the existing child PTY host fixture, the production agent-control route with its execution-service fixture, and real watch registration and cancellation records. Other control endpoints use bounded HTTP response fixtures to verify request arguments and model result projections. It does not claim installed phone or desktop acceptance. No Git/GitHub process is spawned by these handlers; aborting and killing those processes belongs to their deferred implementation.

The next step needs the Git/GitHub group, then authenticated session wiring, review preparation before `start()`, registry execution, and real phone acceptance. No route, WebSocket server, session mint, native source, or protocol is changed here.
