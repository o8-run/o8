# o8 next Threads panel

Design only, researched 2026-11-01. No Threads implementation or server changes
are part of this commit. `Tool::Threads` remains a placeholder until the first
reviewed native port has control-driven GPUI proof.

## Decision

Threads should be the project's work overview beside the main conversation:
what needs the operator, what is ready to review, what is running, and what has
been resolved. Keep classic's Tasks / Exchanges distinction. A task, a chat,
a worker attempt and an agent exchange have different identities and controls;
a common project does not make them one transcript.

Reuse the existing project/thread inventory and native conversation, diff and
PR surfaces. Do not build another chat implementation or another task engine.
The useful default is Waiting on you, followed by Ready for review and Working;
Resolved starts collapsed. Queued rows inside Working must still say Ready to
dispatch; grouping must not imply a worker has started. Project context should be inspectable without
leaving the current task.

## What Claude.ai Projects teaches us

There are two documented experiences during the current rollout. They must not
be described as one stable interface. The conventional experience groups chats
and a knowledge base; the newer beta introduces an ongoing coordinating
conversation and parallel worker threads. Availability is rolling out, so this
research uses official documentation rather than claiming acceptance in a
particular signed-in account. [Projects overview][claude-overview]

### Conventional project chats

A project is a container for related conversations and standing material.
Project knowledge accepts documents, text and code; project instructions apply
to the chats in that project. A project's name and description are organizational
labels rather than automatically supplied model context. Chats can be moved
into, out of, or between projects. Merely grouping chats does not combine their
full conversation context: the management guide separately identifies project
knowledge as shared context. [Create and manage projects][claude-manage]

That last rule needs a current qualification. Chat search can retrieve earlier
conversations within a specific project, and project memory is another source
of continuity. The current memory documentation says project memory can be
used alongside account memory; memories from another project are excluded.
Account-memory use can be disabled for a project, and an individual chat can
start with memory disabled. Shared knowledge, retrieved chats, memory, and the
current transcript are therefore distinct context mechanisms. Do not simplify
this to either “all chats know everything” or “project chats never share
anything.” [Chat search and memory][claude-memory]

Knowledge availability also does not mean every byte is inserted into every
turn. The documented RAG mode retrieves relevant content when project material
approaches context capacity. A native UI should distinguish material available
to a task from material actually loaded or cited. It should not invent a
context-loaded badge from a filename alone. [Project RAG][claude-rag]

### New coordinating-project beta

The beta describes one coordinating conversation plus separate worker sessions.
The coordinator consumes their reports rather than every worker step. Its
Overview exposes work state; Library collects supplied and produced files.
Project instructions reach new threads, while project memory and repository
instructions are separate sources. Uploaded files are copies, so local edits
do not update an upload automatically. Changes to project setup apply to new
threads rather than silently reconfiguring already running ones.
[Claude Code Projects][claude-code-projects]

The useful lesson for o8 is explicit context provenance and visible work state.
This is a design inference, not evidence that o8 already has equivalent cloud
execution, project memory, knowledge retrieval, or automatic task coordination.
We should retain o8's actual execution and evidence model.

## Classic o8: the behavior to preserve

The launcher calls Threads “Project tasks and agent exchanges.”
[O8Panel][classic-panel] opens [O8ThreadTools][classic-tools], whose Tasks and
Exchanges tabs preserve their own mounted surfaces.

[O8ThreadsPane][classic-tasks] resolves the selected repository against project
membership, then offers Threads, Library, Merges, History and Agents. It groups
rows into Waiting on you, Ready for review, Working and Resolved; ready work
also appears under Working. It supports task creation separately from creation
and dispatch. Library aggregates recorded artifacts; it is not an uploaded
knowledge base. Merges and History link back to their originating thread.
[ThreadProjectView][classic-project-view]

The server's [project-thread reader][thread-reader] already combines packet and
lane tasks, mission containers, runtime and saved sessions, incidents,
approvals and agent handoffs. It attaches evidence and preserves exact child
identities. Keep the default grouping C inventory initially; grouping A/B can
hide rows and must not become a client-side approximation of C.
[Grouping model][thread-grouping]

[readThreadPages][classic-pages] accepts only a complete, same-revision
inventory: 250 rows per page, at most 40 pages, stable IDs, advancing offsets,
and a revision check. A changed revision is an error, not permission to join
incompatible pages. [useThreadsTasks][classic-load] polls visible work at seven
seconds and retains a prior same-scope snapshot on failure. A scope change
must not display the old project's rows as the new project's work.

[ThreadDetail][classic-detail] ties execution output to task, job and attempt;
[useThreadEvidence][classic-evidence] verifies returned task/repository identity.
A later attempt must not inherit an earlier attempt's logs as current output.
Packet steering keeps a stable request identity through uncertain delivery.
[ThreadActions][classic-actions] only offers task mutations for the task kinds
that support them; synthetic inventory rows mostly navigate to the source.

[O8HandoffsPane][classic-exchanges] reads presence and up to 50 recent messages
for one repository, refreshes visible exchanges at 15 seconds, and reconciles
on lifecycle/focus events. Replies name a live recipient and original message;
close/extend act on the recorded conversation. Changing repository resets
selection and form state. Exchanges are operational correspondence, separate
from the operator's side conversation.

## Native surface and interaction

At the existing right-panel width, use one vertical reading column and the
native type scale. Keep Tasks / Exchanges as the primary switch. Inside Tasks,
Threads is the default view; Library, Merges, History and Agents can use a
compact view menu so five labels do not crowd the narrow column. Show the
project name and explicit repository scope above the content. Do not alter the
left sidebar, nav rail or bot rail to implement this panel.

| Area | What the operator sees and does |
| --- | --- |
| Scope header | Project name, This repository / Project repositories, refresh age and Refresh. Show unresolved project membership explicitly. Persist selection, collapse and scroll state by project plus repository scope. |
| Thread list | Title, repository/branch, readable blocker or last event, kind, runtime/model/effort when supplied, and observed state. Waiting rows lead with the next human action. Unknown state remains unknown. |
| Mission row | Expand exact `childIds`; keep child task IDs selectable. Never infer parentage from matching titles, branch names or timestamps. |
| Detail | Back to the same list position; status, requirements/coverage, workers/stages, artifacts, PR checks and head, history and the current attempt's bounded output. Keep supplied truncation markers visible. |
| Conversation | Open the exact linked session using the shared native `Surface`. Packet steering and ordinary conversation sending are different actions; label the actual destination and keep unsent text through navigation. |
| Library | Recorded output artifacts with source task, kind and open action. Do not label these files as knowledge inherited by future threads. Use existing compatible viewers; unavailable formats stay explicitly unavailable. |
| Merges / History / Agents | Derived from the same scoped inventory, deduplicated by supplied identity, with a route back to the thread. A green check without its recorded head is not exact-head verification. |
| Exchanges | Repository, sender, recipient, time, delivery/conversation state, message chain and reply context. Keep operator draft and recipient explicit. A recorded request is not proof of delivery. |
| Project context | Read-only instructions, repositories/roles, identity mapping and source warnings from the context route. Show the returned project-file limitation. This is context inspection, not proof that a running worker loaded it. |

Loading, failed, unavailable and genuinely empty are separate states. Keep the
last good same-scope snapshot with its age and error when a read fails; Retry
must request a real refresh. Pause reads when the panel/view is covered. Use
existing lifecycle invalidations where available, one in-flight read and a
seven-second Tasks / fifteen-second Exchanges fallback. Do not subscribe to
transcript traffic just to repaint a work list. No spinner or animation loops.
Hide scrollbars while preserving wheel, touch and keyboard scrolling.

When changing scope during a request, discard the old response by generation
and identity. Clear an out-of-scope detail rather than opening a similarly
named row. A navigation receipt is successful only after the intended native
control is mounted and selectable; a queued navigation intent is not proof.
The classic [navigation contract][classic-navigation] provides the reference.

## Existing data contracts

Paths below are existing application routes, not proposed new endpoints.

| Need | Route and contract to consume |
| --- | --- |
| Project identity/membership | `GET /api/panel/projects` returns the ledger (`projects`, `activeProjectId`, repository paths and stable SQLite partner where present). `GET /api/panel/repos` supplies registered repository identities. Use IDs and mapping fields, not project-name equality. |
| Effective project context | `GET /api/projects/context?projectId=…&repoPath=…` returns `context` plus `taskBrief`: panel/settings/runtime IDs, instructions, repositories and roles, primary/current repository, source warnings and `files` capability. |
| Thread inventory | `GET /api/panel/threads?projectId=…&repoPath=…&limit=250&offset=…` (repeat `repoPath`). Response schema `o8/project.threads/v1`: revision, counts, tasks, offset, nextOffset and observedAt. Later pages send the same revision; 409 restarts a complete read while retaining the last committed snapshot. |
| Detail evidence | Same route with `taskId` and exact repository scope. The optional `task` contains `thread` evidence: kind/state/session, children, requirements, artifacts, merges, workers, stages, history and truncation. A missing task is unavailable, not an empty successful detail. |
| Attempt output | `GET /api/tasks/{taskId}/evidence?jobId=…&attempt=…`; match the returned job and attempt before installing logs or changed files. |
| Artifacts | Use the supplied artifact reference. Recorded thread artifacts can use `GET /api/panel/threads/artifact?id=…&projectId=…` (interactive records also specify `source=interactive`). Do not construct filesystem paths from labels. |
| Native chat | Existing session inventory/history and the shared native conversation/composer. Resolve `thread.sessionKey` or the task's recorded session reference, including the `llm-chat:` convention; runtime histories can be read-only. |
| Exchanges | `GET /api/agents/presence?repo=…&includeStale=true`; `GET /api/agents/message?repo=…&limit=50`. Keep structured errors and `live`/delivery state. |
| Exchange actions | Existing `POST /api/agents/message` with repo, recipient, text, replyToId and stable requestId; `POST /api/agents/conversation` with id, repo and close/extend. This design adds no alternate identity or admission path. |
| Task actions | `POST /api/tasks` saves a task; `/api/tasks/{id}/dispatch` is a distinct request. Existing claim/report/block/archive/prune/remove routes remain kind-specific. Mutation bodies carry the recorded project/repository and action data. |
| Packet steering | Existing `POST /api/orchestrator/steer-packet` uses packetId, message, source and stable idempotencyKey. Preserve uncertain-delivery state and inspect the same request on retry; do not create a second steer. |

Sources: [thread route][thread-route], [thread types][thread-types],
[project ledger route][project-route], [repository lookup][classic-repos],
[context route][context-route], [context model][context-model],
[task creation helper][task-create], [agent presence route][presence-route],
[exchange route][exchange-route], [artifact route][artifact-route].

The existing native [project models][native-projects] already load Settings
projects, the repository registry and panel ledger. Reuse that mapping instead
of introducing a parallel project store. `GET /api/projects` supplies the
Settings project records; the resolved context route exposes the instruction
text to inspect. Editing remains in the existing Projects/Settings flow.

Project identity needs care: [threadProjectMatches][project-match] distinguishes
an absent legacy mapping from an explicitly unavailable `panelProjectId`.
Preserve that distinction. Do not silently fall back to a same-named Settings
project or to all repositories when a selected project cannot be resolved.

## Context gaps and boundaries

The current [ProjectContext][context-model] obtains instructions from the
Settings project's description and resolves panel, Settings and runtime
identities. Its `files.enabled` is explicitly false, `items` is empty, and its
note says project files are not wired. The current evidence Library therefore
cannot provide Claude-style input-file knowledge, upload replacement/versioning,
retrieval provenance or project-memory editing.

The separate [codebase-memory status route][codebase-memory] reports indexer
state and can kick its boot pass; it is not a project knowledge-file or memory
editing API. Do not treat that status chip as an inherited-context receipt.

No new endpoint is required for the initial Threads inventory and evidence
port. Full uploaded knowledge or shared project-memory editing needs a separate
server contract and review; stop at that boundary rather than implementing a
native-only store or pretending output artifacts are inherited input. Project
instruction edits can use existing project Settings flows; this panel initially
inspects the resolved context and does not rewrite description fields itself.

Security review owns existing authentication, credentials, process/agent
admission, sandboxing, network binding and redaction behavior, including native
artifact-renderer equivalence. This proposal does not change those policies or
specify replacements. Actions that start work, send agent messages or remove
records need their existing governance and concrete receipts. Viewing a thread
must not dispatch a worker, create a preview allocation or change active project
settings as a side effect.

## Small PR sequence

1. **Scoped read-only Threads.** Add native models/adapters and the Tasks list,
   full revision-bound pagination, same-scope retention, age/error states and
   collapse/selection state. GPUI: real launcher and group controls, second
   project with identical titles, a two-page revision conflict, failed refresh,
   empty success and covered-panel polling. Remove the placeholder only after
   this useful read-only surface passes; label later actions as unavailable.
2. **Details and evidence navigation.** Add task/attempt detail, exact child
   expansion, shared chat/PR/diff navigation, Library/Merges/History/Agents and
   read-only project context. GPUI: real row, Back, session and evidence controls;
   stale-attempt responses, deleted tasks, truncation and unavailable artifacts.
   Reuse existing viewer implementations; blocked formats wait for viewer review.
3. **Exchanges.** Port repository-scoped presence, conversations and delivery
   state first, then existing reply/close/extend controls after the action
   boundary review. GPUI: real selection and reply controls, recipient going
   stale, repository switch during a read/send, retained draft, double-click and
   lost response. An authored send receipt must not be reported as live delivery.
4. **Task creation and supported actions.** Separate Save task from Dispatch;
   add kind-specific claim/report/block and packet steer with durable request
   identity. Keep archive/remove/prune in a separately reviewed destructive
   follow-up. GPUI: actual composer/action selectors, save succeeding while
   dispatch fails, busy controls, uncertain steer and rereading recorded state.

Each PR stays native unless an existing contract proves insufficient. Record
that blocker and stop instead of adding TypeScript server behavior in the port.
Input knowledge and project-memory editing are a separate future workstream,
not an extra item hidden inside these PRs. No PR in this sequence requires a
left-sidebar or rail redesign.

## Research and acceptance status

The classic paths and route shapes above were inspected directly in this
checkout. External sources were checked on 2026-11-01; rollout documentation can
change. This is a reviewable design, not GPUI, signed-in Claude, installed-app,
provider, remote-worker or publication acceptance. Future code PRs must supply
selector-driven GPUI fail-then-pass receipts and actual entry-point evidence for
the behavior they add.

[claude-overview]: https://support.claude.com/en/articles/9517075-what-are-projects
[claude-manage]: https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects
[claude-memory]: https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
[claude-rag]: https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects
[claude-code-projects]: https://code.claude.com/docs/en/claude-projects
[classic-panel]: ../../src/components/desktop/O8Panel.tsx
[classic-tools]: ../../src/components/desktop/o8-panel/O8ThreadTools.tsx
[classic-tasks]: ../../src/components/desktop/o8-panel/O8ThreadsPane.tsx
[classic-project-view]: ../../src/components/desktop/o8-panel/ThreadProjectView.tsx
[classic-pages]: ../../src/components/desktop/o8-panel/readThreadPages.ts
[classic-load]: ../../src/components/desktop/o8-panel/useThreadsTasks.ts
[classic-detail]: ../../src/components/desktop/o8-panel/ThreadDetail.tsx
[classic-evidence]: ../../src/components/desktop/o8-panel/useThreadEvidence.ts
[classic-actions]: ../../src/components/desktop/o8-panel/ThreadActions.tsx
[classic-exchanges]: ../../src/components/desktop/O8HandoffsPane.tsx
[classic-navigation]: ../../src/components/desktop/o8-panel/thread-navigation.ts
[classic-repos]: ../../src/components/desktop/o8-panel/useThreadRepos.ts
[thread-route]: ../../src/app/api/panel/threads/route.ts
[thread-reader]: ../../src/lib/threads/project.ts
[thread-types]: ../../src/lib/threads/types.ts
[thread-grouping]: ../../src/lib/threads/grouping.ts
[project-route]: ../../src/app/api/panel/projects/route.ts
[project-match]: ../../src/components/desktop/o8-panel/thread-project-identity.ts
[context-route]: ../../src/app/api/projects/context/route.ts
[context-model]: ../../src/lib/projects/context.ts
[task-create]: ../../src/components/desktop/repo-focus/tabs/control-room/create-task-request.ts
[presence-route]: ../../src/app/api/agents/presence/route.ts
[exchange-route]: ../../src/app/api/agents/message/route.ts
[artifact-route]: ../../src/app/api/panel/threads/artifact/route.ts

[codebase-memory]: ../../src/app/api/cortex/codebase-memory/route.ts
[native-projects]: ../../native/o8-next/src/projects_model.rs
