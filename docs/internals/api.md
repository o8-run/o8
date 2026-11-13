# o8 API reference

This is the canonical reference for o8's HTTP surface. All routes live under
`src/app/api/` as Next.js route handlers. The filesystem currently contains
**369 route files across 42 top-level families** (audited 2026-09-20 against
the issue #2541 branch).

## Auth model

o8's API is default-deny:

- **Operator:** stateful and sensitive routes require
  `Authorization: Bearer <ws-token>`, including requests originating on
  loopback. The desktop, CLI, and MCP proxy attach the token.
- **Paired device / worker / spectator:** device, worker, and spectator tokens can reach only the
  method-and-path capabilities explicitly listed in `src/middleware.ts`.
- **Public or self-authenticating:** the small public-read, enrollment,
  webhook, cloud-worker, and service-account surfaces are individually
  allowlisted or authenticate inside their handlers.
- **Loopback-read exceptions:** a few iframe and boot resources accept
  socket-truth loopback because browser navigation cannot attach a bearer.

There is no gated-prefix allowlist. Every `/api/*` route fails closed unless
`src/middleware.ts` names its public, principal, or self-authenticating policy;
`tests/route-coverage.test.ts` keeps that policy exhaustive as route files move.

**Never expose a new route by omission.** Add the narrowest explicit
method-and-path policy and a middleware/route-coverage test in the same change.

## Conventions

- App Router routes use the Node.js runtime unless a route explicitly declares
  another runtime. Routes that must bypass caching export
  `dynamic = 'force-dynamic'`; this is not a universal boilerplate requirement.
- Errors return structured JSON: `{ ok: false, error: '<message>' }` with appropriate HTTP status. Never throw — always return a response.
- Dispatch entry points refuse a known runtime outside the dispatchable capability set with HTTP 400 and `worker_not_enabled`. The known-runtime delegate refusal keeps `worker_not_enabled`; unknown names now use `invalid_runtime` instead of the delegate API's former `worker_not_enabled`; task, mission, and prompt dispatch use the same refusal message. Unknown runtime names remain distinct client errors (400, `invalid_runtime`). This includes `/api/lanes` `open_lane` and the internal task-dispatch owner route; lane command callers retain their structured refusal result.
- Pagination is opt-in per-route via `?limit=<n>&offset=<n>` query params (not standardized across the surface).
- Realtime updates ship over WebSocket (`/ws`) on the dynamically selected port
  written to `~/.o8/ws-port` (dev default `47125`; packaged block
  `47105`–`47109`). See `src/ws-server.ts`.
Note: the realtime `lane-lifecycle` payload carries lane status in the `status` field, not `laneStatus`; client readers should coalesce via `laneStatusOf()` in `src/lib/orchestrator/status-events.ts`.

Review submission is guarded in depth: middleware refuses worker credentials for `POST /api/orchestrator/review`, and the handler independently re-checks the server-owned reviewer assignment and fails closed. Assigned-reviewer admission is not wired; `mintAssignedReviewerToken` has no production caller. Handler-level assignment tests do not establish admission through the middleware gate.

## Review execution evidence

Saved packet reviews and durable `orchestrator_review` approval JSON carry additive
`runEvidence`, `reviewMode`, `verdictLabel` and optional `runEvidenceWarning` fields. Existing `approved` and verdict
enums remain compatible. Readers derive the mode and label from validated evidence,
never trust a saved mode flag, and read old records with no evidence as
`read_only` / `approved, not run`. No database columns or storage-version migration
are needed. Existing JSON is upgraded on read; historical audit entries are preserved.

`POST /api/orchestrator/review` and MCP `submit_review` accept either:

```json
{ "status": "not_run", "reason": "The window driver is unavailable." }
```

or a structured receipt for the exact full `reviewedHeadSha`:

```json
{
  "status": "run",
  "headSha": "0123456789012345678901234567890123456789",
  "reviewerRuntime": "codex",
  "recordedAt": "2026-11-13T00:00:00.000Z",
  "observations": [{
    "kind": "command",
    "command": "node scripts/acceptance.mjs",
    "result": "The changed command returned the expected output.",
    "exitCode": 0,
    "excerpt": "acceptance passed"
  }]
}
```

A receipt has 1–20 observations. Each needs a command or launch/steps, observed
result, safe integer exit status (a launch may use null), and an excerpt (at most
4000 characters) or artifact reference (at most 1000). Commands/results are bounded
to 2000 characters, the runtime to 100, and the ISO timestamp to 40. A not-run reason
is bounded to 2000. Invalid or stale submitted evidence is downgraded to `not_run`
with a recorded warning; the code verdict remains valid, including when policy is off.
Old malformed/stale saved evidence also reads as not run. A missing authenticated
operator or assigned-reviewer principal cannot earn run credit. The server attaches
the principal (operator, or packet/review-turn/runtime assignment); request JSON and
model prose cannot choose it. Command, result, excerpt and artifact text is redacted
through the existing transcript policy before persistence or output.
A failed command is still an observation; the reviewer owns the approval judgment.
Prose and author claims do not supply structured evidence. These are reviewer-reported
receipts, not independently attested execution or a measured correctness guarantee.

The reviewer prompt asks for real-entry execution on user-facing changes or a
specific not-run reason. The self-contained `POST /api/harness` `evaluate_diff` /
`o8_evaluate_diff` evaluator cannot run a commit and always reports a read-only
verdict, including when the model claims execution. CLI packet review accepts
`--run-evidence <JSON-file>` or `--not-run <reason>` and reports the mode in human
and JSON output. Review-state (including the native window's data), mission status,
and MCP outputs carry the same fields. The run label is
`approved, run (reviewer-reported)`. This is data/CLI/MCP support: the native packet
review, AuditLogPanel and ChatPacketStatusBanner still show a bare Approved label
(#6076). No native UI or driver is added.

### Opt-in merge requirement

Set **the server process environment** `O8_REVIEW_RUN_REQUIRED_PATHS` to a JSON
array of repository-relative globs, for example `["native/o8-next/src/**"]`.
Unset, empty, or `[]` leaves enforcement off. Patterns support `*`, `**` and `?`;
Matching is case-insensitive and treats backslashes as forward slashes;
absolute/traversal paths and other glob syntax are refused. The reviewed repository
cannot set its own policy through this field; no UI setting is added.
The environment value applies to **every registered repository**; a malformed
value blocks merges in **every repository**. Per-project settings are tracked in
#6075 under #5822. Merge preview and review-state expose the active paths, enabled
state, validity and source. When off, preview omits the run-evidence check row.

Merge preview and the lane merge chokepoint check the full committed change
at the resolved source candidate SHA after snapshot resolution and before rebase,
including deleted paths and both sides of renames. A matching change needs a durable,
approved review with structured run evidence at the exact reviewed HEAD. Operator
approval does not bypass this opt-in requirement. The packet merge HTTP route returns
409 `review_run_evidence_required`; invalid configuration returns 409
`review_run_policy_invalid`, and an unverifiable diff returns 409
`review_run_diff_unavailable`. Dirty worktrees, merge-time source commits and
unresolvable remote candidates refuse with `review_run_candidate_unavailable`;
commit and review the final source first. Remote lanes check the fetched branch,
not the canonical checkout. Rebase-carried approvals do not inherit run evidence
for their new HEAD. Existing integration/rebase gates remain in place; these receipts
refer to the reviewed source commit, not a claim that the eventual integration commit
was exercised. Launching and driving the reviewed commit remains dependent on #5947.

## Route reference

Routes are grouped by their first path segment.

### `/api/automations/*` — cron-style scheduled runs (gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/automations` | List automations. |
| POST | `/api/automations` | Create an automation. |
| PATCH | `/api/automations/[id]` | Partial update; cron change recomputes `nextRunAt`. |
| DELETE | `/api/automations/[id]` | Delete an automation. |
| POST | `/api/automations/[id]/run` | Fire an automation now; updates `lastRunAt` + recomputes `nextRunAt` for cron rows. |

### `/api/board/*` — Cortex task board state (gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/board?repo=<path>` | Read board snapshot for a repo. |
| POST | `/api/board` | Apply a board mutation with optimistic concurrency (`expectedRevision`). |
| POST | `/api/board/tasks/[taskId]/start` | Launch a backlog task in plan mode, building the launch prompt. |

### `/api/browser/*` — In-app browser provider surface (gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/browser/inventory` | Snapshot of attachable browser surfaces. |
| POST | `/api/browser/attach` | Attach a browser surface via the named provider. |

### `/api/broadcast/*` — Read-only spectator projection

A spectator bearer is a distinct read-only principal. Active hashes are durable in SQLite and
projected into an owner-only data-dir file so middleware can validate them without loading a native
database addon. The bearer is returned only when minted. The `/broadcast` page receives it through
the URL fragment, moves it into session storage, and scrubs the fragment before calling the API.
The page shell never receives the operator token or operator auth providers.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/broadcast/events?cursor=...&wait=...&repo=...&lane=...&kinds=...` | Cursor-paginated, optionally long-polled projection of approved ledger event kinds. Operator or spectator bearer. |
| GET | `/api/broadcast/snapshot?events=30` | Current lanes, packets, active agents, pending approvals, and recent redacted events. Operator or spectator bearer. |
| POST | `/api/broadcast/tokens` | Operator-only `mint` or `revoke` mutation for spectator credentials. |

An events request without a cursor starts at the ledger head and pages forward. Live-tail clients
bootstrap from the snapshot's recent events and continue from the cursor returned with that snapshot.
Every projection recursively redacts credential/environment fields, environment values, and absolute
home paths before serialization. A spectator credential has no write capability; any other API route
is refused by the global middleware even when it originates on loopback.

### `/api/claude-code/*` — Claude Code runtime transcript + send (gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/claude-code/transcript?sessionKey=...&limit=...` | Read Claude Code JSONL and return transcript entries compatible with the mobile shape. |
| GET | `/api/claude-code/diffs?sessionKey=...&limit=...` | Extract file edit/write operations from Claude Code JSONL for live rendering. |
| POST | `/api/claude-code/send` | Send a message to a Claude Code session (delegates to `handleClaudeCodeSend`). |

### `/api/cloud/*` — Cloud worker scaffolding (self-authenticating)

Workers authenticate via `Authorization: Bearer cwk_*` per-request, not the panel middleware.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/cloud/worker-poll?cursor=...&workerId=...` | Long-poll for cloud worker job assignments. |
| POST | `/api/cloud/worker-stream` | Stream transcript chunks + lifecycle events from a cloud worker. |

### `/api/codex/*` — Codex CLI runtime transcript + send (gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/codex/transcript` | Read Codex session JSONL and project to mobile-shaped transcript entries. |
| GET | `/api/codex/diffs` | Parse Codex `apply_patch` format into structured file edits. |
| POST | `/api/codex/send` | Stream a message through `codex exec --json`; resumes if `threadId` provided. |

### `/api/command-center/*` — Fleet snapshot for the desktop dashboard (gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/command-center/snapshot?fresh=1` | Full fleet snapshot (cached unless `fresh=1`). |

### `/api/connectors/*` — Third-party data importers (gated)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/connectors/chatgpt` | Import ChatGPT conversation history (zip multipart or JSON). |

### `/api/cortex/*` — Cortex v2 memory + Q&A surface (gated)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/cortex/ask` | Full streaming Q&A pipeline (classifier → composer → SSE). |
| POST | `/api/cortex/ask/answer` | Non-streaming JSON sibling of `/ask` used by the `cortex_ask` MCP tool. |
| GET | `/api/cortex/codebase-memory` | Live state of the boot indexer (#741), feeds the Recall card pill. |
| GET | `/api/cortex/cross-repo-proposals` | List cross-repo directive proposal candidates. |
| POST | `/api/cortex/cross-repo-proposals` | Dismiss a cross-repo proposal. |
| GET | `/api/cortex/diagnostics` | Substrate eval summary (#749) — answers "is SQLite still fine?". |
| GET | `/api/cortex/directives` | List directive markdown files from `~/.o8/directives/`. |
| POST | `/api/cortex/directives` | Create / update a directive. |
| GET | `/api/cortex/project-pulse?repoPath=...` | Aggregate peer-repo activity (commits, PRs, issues) across projects. |
| GET | `/api/cortex/proposals` | List directive proposal candidates. |
| POST | `/api/cortex/proposals` | Dismiss a directive proposal. |
| GET | `/api/cortex/recent-outcomes?repoPath=...&limit=...` | Read recent rows from the `session_outcomes` ledger. |
| GET | `/api/cortex/runtime-recommendation?repoPath=...` | Dispatch routing recommendation backed by `recommendRuntime()`. |
| POST | `/api/cortex/symbol-graph` | Resolve symbol references for a repo from explicit list or free-form text. |

### `/api/dictation/*` — Push-to-talk voice input (gated)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/dictation/transcribe` | Multipart audio upload → OpenRouter transcription endpoint. |
| POST | `/api/dictation/polish` | Polish raw Whisper transcript via Gemini Flash Lite (adaptive punctuation). |

### `/api/github/*` — GitHub App webhook receiver (self-authenticating)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/github/webhook` | Verify HMAC signature and upsert installation / repo / issue / PR events. |

### `/api/lanes/*` — Lane registry and packet worktree state (gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/lanes?active=true\|false` | List lanes (active by default). |
| POST | `/api/lanes` | Reconcile lanes whose worktrees were deleted out-of-band (#534 follow-up). |
| GET | `/api/lanes/[id]` | Get a single lane + its event history. |
| GET | `/api/lanes/[id]/diff` | Read-only diff of a packet's worktree (byte-bounded). |
| GET | `/api/lanes/[id]/events?since=...&follow=1` | Lane event stream (loopback+bearer required for `follow`). |
| POST | `/api/lanes/[id]/events` | Append an agent report event to the lane. |
| POST | `/api/lanes/[id]/heartbeat` | Record an agent heartbeat tick. |
| GET | `/api/lanes/[id]/scope` | Get the packet scope (paths/files in scope for the packet). |
| POST | `/api/lanes/apply-diff` | Create a transient worktree and `git apply` a diff blob. |
| GET | `/api/lanes/touches?repo=...&packet=...&path=...` | Find lanes touching given paths or a packet's diff. |

### `/api/leases` — Named resource coordination (gated)

Operator and worker credentials can use this route. Device and anonymous callers are denied.
The handler captures the submitted local owner PID's exact boot/start identity before recording
ownership. Worker mutations additionally prove that the submitted owner and waiter PIDs belong to
the process tree bound to that packet credential; worker labels and ledger actors come from the
authenticated principal, not the request body. Workers cannot mutate the governance-reserved
`repo-tree:`, `test-suite:`, or `apfs-mounts:` namespaces. Acquire creates a private claim that is
never returned by status/list; release and heartbeat require both the exact process identity and
that claim. Claim files inside the o8 data directory are readable by the same operating-system
user; worker-to-worker isolation comes from the server-verified process binding, not secrecy of
the claim token. An overdue lease remains held until release or confirmed process death; an unknown
identity fails closed.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/leases?resource=...` | Read one holder and its FIFO waiter queue. Omit `resource` to list active resources. |
| POST | `/api/leases` | Acquire, release, or heartbeat a named resource using an explicit action body. |

### `/api/mobile/*` — Mobile surface for the native o8-mobile app (partial)

Mobile clients present an enrolled device bearer. `src/middleware.ts` grants
that principal only the named method-and-path capabilities; operator-only
mobile routes still require the operator bearer. The VAPID public key is the
narrow read-only exception.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/mobile/action` | Execute a mobile-issued runtime action (LLM chat turn, dispatch, approval). |
| GET | `/api/mobile/activity` | Chronological fleet activity feed (newest-first, capped ~40). |
| GET | `/api/mobile/bootstrap?fresh=1` | First-load bootstrap snapshot (repos, sessions, layout). |
| POST | `/api/mobile/chat` | Create a new mobile LLM chat session, returning `sessionKey`/`tabId`. |
| POST | `/api/mobile/chat/send` | Send a mobile chat turn (streams via WS, persists locally). |
| POST | `/api/mobile/enhance` | Enhance raw mobile prompt via Gemini 2.0 Flash. |
| GET | `/api/mobile/history?sessionKey=...&limit=...` | Read paginated transcript for a session (LLM chat or runtime tail). |
| GET | `/api/mobile/inbox?fresh=1&limit=...` | Mobile inbox snapshot (pending approvals, activity items). |
| GET | `/api/mobile/media?path=...&download=1` | Serve allowed media files (image/PDF) from sanctioned roots. |
| GET | `/api/mobile/orchestrator/openclaw-agents` | List openclaw agents available on this machine. |
| GET | `/api/mobile/orchestrator/openclaw-availability` | Probe whether openclaw orchestrator is usable on this machine. |
| GET | `/api/mobile/orchestrator/packets?repoPath=...` | List orchestrator packets per repo (mobile-shaped payload). |
| GET | `/api/mobile/orchestrator/threads` | List recent orchestrator threads. |
| POST | `/api/mobile/orchestrator/threads` | Create a desktop-owned o8/Claude thread mobile can attach to. |
| GET | `/api/mobile/orchestrator/threads/reveal?since=...` | List pending reveal-on-desktop requests. |
| POST | `/api/mobile/orchestrator/threads/[threadId]/reveal` | Request the desktop reveal a thread. |
| POST | `/api/mobile/push-url` | Fan out a URL push to every connected mobile client over WS. |
| GET | `/api/mobile/push/public-key` | Return the VAPID public key for `pushManager.subscribe`. |
| POST | `/api/mobile/push/subscribe` | Store a web-push subscription. |
| GET | `/api/mobile/push/subscribe` | List subscriptions. |
| DELETE | `/api/mobile/push/subscribe` | Remove a web-push subscription by endpoint. |
| POST | `/api/mobile/push/test` | Send a test push to every subscription. |
| GET | `/api/mobile/review-file?path=...` | Server-side cached review file content. |
| GET | `/api/mobile/search?q=...` | Universal mobile search across chats, packets, history. |
| GET | `/api/mobile/session-media?sessionKey=...` | List media attachments per session (currently returns empty scaffold). |
| POST | `/api/mobile/sync` | Reconcile mobile-side cache with server (multi-type sync envelope). |
| GET | `/api/mobile/ws-token` | Return `~/.o8/ws-token` for mobile WS handshake. |

### `/api/mcp` — Operator MCP streamable-HTTP host (gated)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/mcp` | Streamable-HTTP MCP transport for the shared operator tool registry; requires the operator bearer even on loopback. |

### `/api/operator/*` — Operator status (gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/operator/status` | Operator runtime status (agent counts, queue depth). |

### `/api/orchestrator/*` — Orchestrator mission + packet lifecycle (gated)

This is the backbone for the mission dispatch flow (`create_mission` → `dispatch_mission` → `submit_review` → `approve_and_merge`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/orchestrator/archive` | Read archived orchestrator transcripts from `~/.o8/orchestrator-archives/`. |
| POST | `/api/orchestrator/compact` | Compact the orchestrator transcript for a repo. |
| POST | `/api/orchestrator/comparison-pick` | Pick the winner from a best-of-n comparison group. |
| POST | `/api/orchestrator/create-mission` | Create a mission shell; validates `OrchestratorRuntime` + `ExistingBranchPolicy`. |
| POST | `/api/orchestrator/delegate` | Create packet shell + open lane + launch Codex in one step. |
| POST | `/api/orchestrator/dispatch` | Dispatch a created mission (spawns agent workers). |
| POST | `/api/orchestrator/headless-tick` | Run one headless sprint tick (used by autonomous loop). |
| GET | `/api/orchestrator/lead?leadId=...&turnId=...&afterCursor=...&waitMs=...` | Read or bounded-long-poll a compact, turn-correlated persistent-lead receipt. Operator only. |
| POST | `/api/orchestrator/lead` | Start, send, structurally report an outcome, or durably stop a persistent lead with replay-safe admission. Operator only. |
| GET | `/api/orchestrator/lane-events?since=...` | Long-poll for orchestrator-relevant lane events. |
| POST | `/api/orchestrator/merge` | Approve + merge a packet (`approveAndMergePacket`). |
| GET | `/api/orchestrator/packet-spec?packetId=...` | Read the packet's structured spec. |
| PUT | `/api/orchestrator/packet-spec` | Replace a packet's spec. |
| GET | `/api/orchestrator/packet-transcript?packetId=...&limit=...&cursor=...` | Paginated transcript for a packet. |
| POST | `/api/orchestrator/propose-spec` | `cortex_propose_spec` MCP backend — agents suggest a spec (#773/#857). |
| POST | `/api/orchestrator/reload` | Graceful orchestrator reload after conversational MCP install. |
| POST | `/api/orchestrator/rerun-with-feedback` | Re-dispatch a packet with feedback string (cap 4000 chars). |
| POST | `/api/orchestrator/reset-packet` | Reset a packet to a clean state (clears lane + worktree). |
| POST | `/api/orchestrator/reset-session` | Reset an orchestrator thread (by repo or explicit thread id). |
| POST | `/api/orchestrator/review` | Submit a review verdict for a packet. |
| GET | `/api/orchestrator/review-state?packetId=...` | Canonical review state for a packet — backs the `o8_review_state` MCP tool (#621). |
| GET | `/api/orchestrator/state` | Live mission state enriched with lane registry data. |
| POST | `/api/orchestrator/state` | Mutate orchestrator state. |
| PATCH | `/api/orchestrator/state` | Partial mutate orchestrator state. |
| GET | `/api/orchestrator/status?missionId=...&includeCost=true` | Mission status snapshot (used by `get_mission_status` MCP). |

### `/api/panel/*` — Desktop panel surface (gated)

`/api/panel/status` is the narrow unauthenticated health read. The GitHub
device flow and every stateful panel route require the operator bearer.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/panel/analytics?hours=24` | Aggregate cost/usage across Codex, Claude Code, and IDE LLM chat. |
| GET | `/api/panel/approvals` | List pending approvals from the shared queue. |
| POST | `/api/panel/approvals` | Resolve a pending approval. |
| POST | `/api/panel/assign-issue` | Assign a GitHub issue to an agent (adds comment + label). |
| GET | `/api/panel/branches?repo=...` | List branches with diff stats. |
| POST | `/api/panel/branches` | Create a branch. |
| DELETE | `/api/panel/branches` | Delete a branch. |
| POST | `/api/panel/branches/checkout` | Checkout a branch; checks for uncommitted changes first. |
| POST | `/api/panel/browse-folder` | Open native folder picker (macOS osascript). |
| GET | `/api/panel/ci?repo=...` | Latest CI workflow runs (60s cache). |
| GET | `/api/panel/ci/[id]?repo=...` | Detail for a single CI workflow run. |
| GET | `/api/panel/cli-usage` | Snapshot of CLI usage across all runtimes. |
| GET | `/api/panel/cloud-workers` | Panel-side surface for cloud workers (#514). |
| POST | `/api/panel/cloud-workers` | Mutate cloud worker registrations. |
| POST | `/api/panel/codex-sessions/prune` | Archive or delete Codex sessions older than `maxAgeDays`. |
| GET | `/api/panel/commit-diff?sha=...&workspace=...` | Files changed in a single commit. |
| GET | `/api/panel/commits?repo=...\|workspace=...&limit=...` | Recent commits (GitHub-side or local workspace). |
| GET | `/api/panel/commits/[hash]?workspace=...` | Detail for a single commit. |
| GET | `/api/panel/commits/[hash]/file?workspace=...&path=...` | File contents at a specific commit. |
| GET | `/api/panel/deployments?project=...&limit=...` | List Vercel deployments (requires `VERCEL_TOKEN`). |
| GET | `/api/panel/deploys` | Latest deployment statuses via GitHub API. |
| GET | `/api/panel/dev-server` | List active dev server processes. |
| POST | `/api/panel/dev-server` | Start a dev server process. |
| DELETE | `/api/panel/dev-server` | Stop a dev server process. |
| POST | `/api/panel/diagnostics/run-demo` | Run the in-app demo sequence (#800), capturing screenshots. |
| POST | `/api/panel/factory-reset` | Wipe contents of `~/.o8/` data directory (preserves the dir). |
| GET | `/api/panel/file-asset?workspace=...&path=...` | Serve registered repo file as asset (image/PDF), 50MB cap. |
| GET | `/api/panel/file-content?path=...` | Read raw file content with path-traversal protection. |
| GET | `/api/panel/file-diff?path=...&hideWhitespace=1` | Per-file diff (`git diff -w` when `hideWhitespace`). |
| GET | `/api/panel/file-preview?path=...&workspace=...` | File preview (image MIME or text). |
| GET | `/api/panel/files?workspace=...` | List files in a workspace. |
| POST | `/api/panel/fleet/invalidate` | Flush the owned-session fleet cache across every runtime. |
| GET | `/api/panel/git-log?workspace=...` | Parsed git log with structured ref data. |
| GET | `/api/panel/git-status?workspace=...` | Working tree + branch-vs-main status. |
| GET | `/api/panel/git/log?workspace=...&limit=...` | Compact git log for Loop Status widget (#796). |
| POST | `/api/panel/github-device` | GitHub device-flow handshake (operator bearer required). |
| GET | `/api/panel/github-status` | Parsed `gh auth status` output. |
| GET | `/api/panel/ide-surface` | Read persisted IDE surface state (terminal repos, active repo). |
| POST | `/api/panel/ide-surface` | Persist IDE surface state. |
| GET | `/api/panel/issues?repo=...` | List GitHub issues for a repo. |
| GET | `/api/panel/issues/[number]?repo=...` | Detail for a single issue. |
| POST | `/api/panel/issues/create` | Create a GitHub issue. |
| POST | `/api/panel/issues/enhance` | Enhance issue body via LLM, parallel-fetching repo context. |
| GET | `/api/panel/lan-host` | Discover first private LAN IPv4 + reachable dev ports for mobile DevHostFrame. |
| GET | `/api/panel/loop-status` | Read `~/.o8/loop-cron-state.json` for the autonomous-loop widget. |
| POST | `/api/panel/mcp-test` | "Test connection" probe for a registered MCP server (stdio or HTTP). |
| GET | `/api/panel/mobile-pairing` | Mobile pairing payload (Tailscale URL, ws-token, fingerprints) for QR. |
| POST | `/api/panel/o8-github-summary` | Summarize a repo's recent GitHub activity via OpenRouter free models. |
| GET | `/api/panel/o8-update-summary` | Summarize an o8 GitHub release (release notes + recent commits) via OpenRouter free models for the UpdateCard. |
| POST | `/api/panel/o8-mission-summary` | Summarize a completed mission's merged packets (hydrated from the session_outcomes ledger) into plain-language prose via OpenRouter free models, for the Mission-complete detail modal. |
| POST | `/api/panel/o8-scratch-chat` | One-shot scratch chat with tool calls (file context, OpenRouter free models). |
| GET | `/api/panel/open-in` | List available editors (CLIs that exist on PATH). |
| POST | `/api/panel/open-in` | Open a file in the requested editor. |
| GET | `/api/panel/operator-defaults` | Read operator defaults (parallel cap, overlap gate mode, etc.). |
| POST | `/api/panel/operator-defaults` | Update operator defaults. |
| GET | `/api/panel/ports?fresh=1` | Discover ports in use on the local machine (cached). |
| GET | `/api/panel/pr?repo=...&number=...` | PR detail + computed checks rollup status. |
| POST | `/api/panel/pr/review` | Submit a PR review (approve / comment / request_changes / merge / close). |
| POST | `/api/panel/pr/review/reply` | Reply to a PR review thread. |
| POST | `/api/panel/pr/review/resolve` | Resolve / unresolve a PR review thread. |
| GET | `/api/panel/pr/review/threads?repo=...&number=...` | GraphQL review threads (in-memory cached). |
| GET | `/api/panel/projects` | List projects ledger (reconciled with repo registry). |
| POST | `/api/panel/projects` | Create a project. |
| PATCH | `/api/panel/projects/[id]` | Update project name / repos / color. |
| DELETE | `/api/panel/projects/[id]` | Delete a project. |
| POST | `/api/panel/projects/active` | Set the active project. |
| ALL | `/api/panel/proxy?url=...` | Localhost preview proxy with HTML/CSS/srcset rewriting + frame-busting strip (GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS). |
| GET | `/api/panel/prs?repo=...` | List PRs for a repo. |
| GET | `/api/panel/prs/[number]?repo=...` | Detail for a single PR. |
| POST | `/api/panel/prs/[number]` | PR mutation (close / merge / review / comment). |
| GET | `/api/panel/prs/[number]/comments?repo=...` | List PR comments + reviews. |
| GET | `/api/panel/readme?workspace=...` | First matching README file in a workspace. |
| GET | `/api/panel/repo-status?path=...` | "What changed since I last checked" signal set (commit, diff, etc.). |
| GET | `/api/panel/repos` | List registered repos. |
| POST | `/api/panel/repos` | Add / touch / update a registered repo. |
| DELETE | `/api/panel/repos` | Remove a registered repo (with runtime cleanup). |
| POST | `/api/panel/repos/init` | Initialize a new git repo at the given path. |
| POST | `/api/panel/repos/scaffold` | Scaffold a repo from a kind (next, tauri, etc.). |
| GET | `/api/panel/search?q=...` | Cmd+K command palette server-side fan-out (#661). |
| GET | `/api/panel/serve-image?path=...` | Serve image file from allowed roots (`$HOME` or `/tmp`). |
| GET | `/api/panel/session-costs?agent=...` | Persisted runtime-session cost rows from `usage_logs`. |
| GET | `/api/panel/skeleton?workspace=...&search=...` | Workspace skeleton map + rendered text, or symbol search. |
| GET | `/api/panel/status` | Stable status read for CLI / agents (allowlisted — read-only). |
| GET | `/api/panel/supervisor-inbox?includeDismissed=1&scope=all&projectId=...` | Supervisor inbox items + summary. |
| POST | `/api/panel/supervisor-inbox` | Dismiss / clear inbox items. |
| POST | `/api/panel/terminal-exec` | Send a command to a dashboard terminal session (WS bridge). |
| GET | `/api/panel/terminal-sessions` | List alive dashboard terminal sessions. |
| GET | `/api/panel/terminal-state?scope=...` | Read persisted terminal state for a scope (per-tile JSON file). |
| POST | `/api/panel/terminal-state` | Persist terminal state for a scope. |
| GET | `/api/panel/timeline` | Aggregate today's agent activity into timeline segments. |
| GET | `/api/panel/universal-search?q=...` | Cross-surface search (files, navigation targets, sessions). |
| GET | `/api/panel/workers` | Worker tokens + fleet status + remote-runtime registration. |
| POST | `/api/panel/workers` | Mutate worker tokens. |
| GET | `/api/panel/workspaces` | List workspaces with cached PR / branch / diff data per repo. |
| POST | `/api/panel/workspaces` | Mutate workspace lifecycle records. |

*These three summary routes share the free OpenRouter pool (`poolside/laguna-m.1:free`, `openai/gpt-oss-120b:free`, `nvidia/nemotron-3-super-120b-a12b:free`), overridable via `O8_SCRATCH_OPENROUTER_MODELS`.*

### `/api/projects/*` — Projects ledger + dismissed suggestions + locks (gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/projects` | List projects (parallel-array shape with roles). |
| POST | `/api/projects` | Create a project. |
| GET | `/api/projects/[id]` | Project detail with repos. |
| PATCH | `/api/projects/[id]` | Update project (name, description, mainRepoId). |
| DELETE | `/api/projects/[id]` | Delete a project. |
| POST | `/api/projects/[id]/repos` | Add a repo to a project (with role + suggestionOrigin). |
| PATCH | `/api/projects/[id]/repos/[repoId]` | Update repo's role within the project. |
| DELETE | `/api/projects/[id]/repos/[repoId]` | Remove a repo from a project. |
| GET | `/api/projects/context?repoPath=...&projectId=...&taskTitle=...&taskBody=...` | Build a project task brief (or raw context). |
| POST | `/api/projects/context` | Build a project task brief from body params. |
| GET | `/api/projects/dismissed-suggestions` | List dismissed suggestion fingerprints. |
| POST | `/api/projects/dismissed-suggestions` | Dismiss a suggestion by fingerprint. |
| GET | `/api/projects/locks?projectId=...` | List project locks (lane-scoped concurrency control). |
| POST | `/api/projects/locks/[laneId]` | Lock action — currently only `archive_stale` is supported. |

### `/api/repo-spec/*` — Per-repo `o8.md` spec file (gated)

`o8.md` lives at `<repoPath>/o8.md` and is the agent-annotatable spec for a repo.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/repo-spec?repoPath=...` | Read `o8.md` for a repo. |
| POST | `/api/repo-spec` | Agent-side annotation (comment, suggest, resolve). |
| PUT | `/api/repo-spec` | Operator-only spec replacement. |
| POST | `/api/repo-spec/asset` | Upload inline image assets (stored at `<repoPath>/o8-assets/`). |

### `/api/review/*` — Code review workflow (gated)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/review/auto-review` | Start the review drain or enqueue a lane for auto-review. |
| POST | `/api/review/commit` | Commit staged changes with a message (500 char cap). |
| POST | `/api/review/discard` | Discard unstaged changes (path-traversal protected). |
| GET | `/api/review/file?path=...` | File detail for the live review surface. |
| POST | `/api/review/push` | `git push` the current branch. |
| GET | `/api/review/workspace?workspace=...&repo=...&strictBranch=1` | Full review snapshot (ahead/behind, changed files, recent commits, worktrees, PRs, issues). |

### `/api/runtime/*` — Universal runtime adapter surface (gated)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/runtime/action` | Dispatch any runtime action via `performRuntimeAction()` + realtime publish. |
| POST | `/api/runtime/archive` | Archive an owned Codex / Gemini / opencode session. |
| GET | `/api/runtime/inventory?fresh=1` | Runtime inventory snapshot (all adapters in parallel). |
| POST | `/api/runtime/launch` | Launch a runtime surface (`launchRuntimeSurface`) and publish realtime mutation. |
| GET | `/api/runtime/review?surfaceId=...` | Owned Codex review packet for a surface. |
| GET | `/api/runtime/telemetry?sessionKey=...` | Per-session telemetry from the adapter (when supported). |
| GET | `/api/runtime/transcript?sessionKey=...&limit=...&sinceId=...` | Read normalized transcript entries (with compaction metadata). |

### `/api/setup/*` — First-run setup wizard (gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/setup/active-branch?repoPath=...` | Resolve the active repo + its default branch (handles worktree paths). |
| GET | `/api/setup/claude-desktop` | Read current Claude config + report install status. |
| POST | `/api/setup/claude-desktop` | Merge o8 + codebase-memory MCP entries into Claude config. |
| GET | `/api/setup/config` | Read `~/.o8/setup.json`. |
| POST | `/api/setup/config` | Write `~/.o8/setup.json`. |
| GET | `/api/setup/detect` | Detect installed tools (Codex, Claude, Gemini, opencode, embeddings, API keys). |
| GET | `/api/setup/external-client` | Detect Hermes Agent / OpenClaw + report install status. |
| POST | `/api/setup/external-client` | Auto-register o8 MCP with Hermes Agent / OpenClaw. |
| GET | `/api/setup/mcp-config` | Generate copy-paste-ready MCP config for the current install. |
| GET | `/api/setup/mcp-servers` | List external MCP server registrations. |
| POST | `/api/setup/mcp-servers` | Insert an external MCP server. |
| PATCH | `/api/setup/mcp-servers` | Toggle enabled state for an external MCP server. |
| DELETE | `/api/setup/mcp-servers` | Remove an external MCP server. |

### `/api/task-artifacts/*` — Interactive task artifacts (gated)

An orchestrator or packet worker attaches a sandboxed, agent-authored form to a
thread or packet; the operator edits it and its exact validated payload returns
to the originating session with a receipt. Contract: [Interactive task artifacts](task-artifacts.md).
Creating needs the operator credential or a packet-bound worker token; submitting
needs the operator credential or an enrolled device, never a worker.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/task-artifacts` | Create: `{ title, html, actions, headPolicy?, threadId + repoPath \| packetId }`. A worker is pinned to its own packet. Returns the artifact without its html. |
| GET | `/api/task-artifacts?threadId=...&repoPath=...` or `?packetId=...` | List artifacts with writability and last receipt. A worker may list only its own packet. |
| GET | `/api/task-artifacts/[id]` | One artifact with its html, writability verdict, last receipt, and accepted count. |
| POST | `/api/task-artifacts/[id]/actions` | Submit `{ action, payload, nonce, target }`. Accepted → 200 with the receipt and delivery; refused → 422 with `error.code` in `target_mismatch`, `read_only`, `undeclared_action`, `invalid_payload`, `payload_too_large`, `schema_violation`, `replayed`, `suspended`, `rate_limited`. |
| GET | `/api/task-artifacts/[id]/actions` | The receipt ledger for one artifact. |

### `/api/tasks/*` — Task pool mutation surface (gated)

The global middleware requires an affirmative operator, paired-device, or
worker principal according to the explicit task capability. Mutation wrappers
also validate the request body and actor at the handler layer.

Every `[taskId]/<action>` route is a thin wrapper around `runTaskMutationRoute` calling the matching `lib/tasks` mutator.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tasks?projectId=...&repoPath=...&includeDone=true&includeBrief=true` | List task pool (filtered). |
| POST | `/api/tasks` | Create a task pool entry. |
| GET | `/api/tasks/[taskId]?projectId=...&repoPath=...` | Read a single task with `o8/task.detail/v1` schema. |
| POST | `/api/tasks/[taskId]/archive` | Archive a task. |
| POST | `/api/tasks/[taskId]/block` | Block a task with a `reason` + optional `AgentReportReason` code. |
| POST | `/api/tasks/[taskId]/claim` | Claim a task (sets actor / note). |
| POST | `/api/tasks/[taskId]/dispatch` | Dispatch a task to a runtime (model, worker intent, requested provider). |
| POST | `/api/tasks/[taskId]/prune` | Prune a task with a reason. |
| POST | `/api/tasks/[taskId]/remove` | Remove a task with a reason. |
| POST | `/api/tasks/[taskId]/report` | Report progress / status / metadata for a task. |

### `/api/tts/*` — Text-to-speech (operator or paired-device capability)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/tts` | Server-side TTS via `edge-tts` Python (browser can't set DRM headers Microsoft now requires). |

### `/api/v2/*` — v2 API layer: auth, chat, files, BYOK, proxies (partial)

This is the consumer-facing API. Route handlers use the session JWT cookie
where applicable, while the global middleware still requires an allowed
principal for stateful routes. Only session inspection (read) and logout
(self-authenticating cookie revocation) are public middleware exceptions.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v2/auth/logout` | Revoke session row + clear auth cookie. |
| GET | `/api/v2/auth/session` | Read current authenticated user profile. |
| GET | `/api/v2/chat/ftux` | Personalized first-touch payload for the chat surface. |
| POST | `/api/v2/chat` | Streaming chat endpoint (free / paid tier routing via gateway). |
| POST | `/api/v2/chat/suggestions` | Suggested-reply chips (0-3 short replies, #771). |
| GET | `/api/v2/chat-history?tabId=...` | Read persisted LLM chat messages per tab. |
| POST | `/api/v2/chat-history` | Append a message to a tab's history. |
| PATCH | `/api/v2/chat-history` | Update a tab's history. |
| DELETE | `/api/v2/chat-history` | Delete a tab's history. |
| GET | `/api/v2/chat-history/list?q=...` | List saved LLM chat conversations with optional FTS. |
| GET | `/api/v2/context/files?q=...` | Autocomplete file paths in workspace. |
| POST | `/api/v2/context/files` | Read file contents for context injection. |
| GET | `/api/v2/files?path=...` | Read a workspace file (LLM Chat "Apply to File"). |
| POST | `/api/v2/files` | Write / edit a workspace file. |
| GET | `/api/v2/keys` | List configured BYOK providers (keys masked). |
| POST | `/api/v2/keys` | Set / update a provider key. |
| DELETE | `/api/v2/keys` | Remove a provider key. |
| POST | `/api/v2/proxy/cli` | Route chat through an installed CLI runtime (Claude Code, Codex, Gemini CLI). |
| POST | `/api/v2/proxy/llm` | BYOK provider proxy (Anthropic / OpenAI / OpenRouter / Gemini) with cost computation + cache multipliers. |
| GET | `/api/v2/repos` | List registered repos from `~/.o8/repos.json`. |

### `/api/worker/*` — Cloud worker event polling (self-authenticating)

Workers authenticate with `Authorization: Bearer cwk_*` per-request.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/worker/event` | Submit a worker event for an in-flight run. |

### `/api/worktrees/*` — Git worktree management (gated)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/worktrees?repo=...` | List all worktrees + conflict status for a repo. |
| POST | `/api/worktrees` | Create a new worktree. |
| DELETE | `/api/worktrees` | Cleanup / prune worktrees. |
| POST | `/api/worktrees/batch` | List worktrees for many repos in parallel. |
| GET | `/api/worktrees/capabilities?repo=...` | Probe APFS CoW capability for a repo's filesystem. |
| GET | `/api/worktrees/conflicts?repo=...&deep=true` | Conflict report (fast file-level or deep line-level). |
| GET | `/api/worktrees/diff?sessionKey=...&worktreePath=...&baseBranch=...` | Full unified diff for an agent's worktree vs base. |
| GET | `/api/worktrees/diff-summary?sessionKey=...&worktreePath=...&baseBranch=...` | `{ additions, deletions, fileCount }` for a worktree. |
| POST | `/api/worktrees/merge` | Create PR, merge to main, or discard a worktree. |

### Idle draft decisions

`GET /api/panel/prs?view=idle-drafts&repo=owner/repository&page=1` lists open drafts whose GitHub `updatedAt` is at least 72 hours old, excluding pending checks. The list and decision paths use the same rule: any unfinished check run (including queued, requested, waiting or an unrecognized nonterminal state), or a PENDING/EXPECTED status context, blocks triage even when the aggregate also reports failure. Completed success, failure and other terminal conclusions do not block idle-draft triage. Per-state summary counts cover all checks. Follow `nextPage`; the first page is incomplete when it is present. Rows expose `headSha`, `updatedAt` and `decisionSnapshot` (`expectedHeadSha`, `expectedUpdatedAt`). Unknown checks remain labeled unknown; conflicts with main are true, false or unknown. A non-main base or missing mergeability remains unknown.

Desktop and mobile Inbox read the same registered GitHub repositories. Both carry the decision snapshot; mobile rows include the repo, number and expected fields in their metadata. No new UI is added. Desktop `truncated` describes only its local 200-contribution cap; `idleDraftNextPages` separately identifies repositories with additional remote pages. Mobile `staleDrafts.sources` reports each repository's next page or error. Summary reads retain the bounded account/epoch-scoped 20-second cache.

Use `o8 inbox drafts --repo owner/repository [--page N]`, then `o8 inbox continue-draft NUMBER --repo owner/repository --expected-head-sha SHA --expected-updated-at ISO [--reason TEXT]`. Handoff additionally requires `--owner LOGIN`; Close requires `--reason TEXT`. Copy the snapshot from the row you reviewed, rather than obtaining a newer snapshot automatically for a write. CLI human/JSON output and registered MCP `o8_idle_drafts` expose these fields. MCP decisions require `expectedHeadSha` and `expectedUpdatedAt`.

`POST /api/panel/prs/NUMBER` with `action: "draft-decision"` requires an affirmative operator credential and a literal `owner/repository` in `registeredGitHubRepos()`; unregistered repositories return 403 before any GitHub call. Aliases, paths and default-repository fallback are refused. Before Continue, Handoff or Close, the server bypasses its shared metadata cache and re-fetches the PR. A changed head or timestamp, a non-idle/non-draft PR, pending checks (including optional status contexts) or unavailable fresh check evidence returns 409 with a refresh instruction before writing. Missing snapshot fields and invalid/oversized text return 400. The only operator text input is `reason`; a separate `comment` field / `--comment` flag is refused by the API, CLI and MCP. Reasons and generated GitHub comments (including the decision prefix) are capped at **4096 UTF-8 bytes**. The fresh decision read inspects all status contexts from the existing requirements query, not only required contexts; unavailable or truncated context evidence also refuses. Fresh check-run reads spanning more than one page are treated as checks unavailable, not as a complete first page: a next-page link, a total count exceeding the returned runs, or a full 100-run page without a total count causes a 409 refusal. An in-flight guard per case-insensitive `repo#number` refuses overlapping decisions with 409 instead of queuing duplicate writes.

Account changes stop later write steps. If assignment succeeded before an account change, the 502 receipt reports `ownerAssigned: true` and `commentPosted: false`. These decisions start no workers and do not mark drafts ready. Continue posts a comment; Handoff confirms assignment to the named GitHub user and posts a comment; Close posts the required reason before closing. GitHub writes are separate requests, not an atomic transaction. After an uncertain/partial write, inspect GitHub before retrying; MCP decisions disable automatic HTTP replay.
