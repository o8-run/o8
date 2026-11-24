# Worker capacity recovery

Native Codex and Claude Code owned workers can wait for a subscription usage
window and continue their saved thread. A confirmed quota failure is required.
Ordinary throttling, network errors and authentication failures do not schedule
a capacity resume.

When automatic cross-runtime fallback is disabled, o8 observes capacity through
the worker's pinned account. Only a fresh, exact snapshot with a future reset
for every exhausted applicable window can schedule a wait. Model-specific Claude
windows apply to the corresponding model family. Unknown reset times retain the
operator card instead of inventing a deadline.

The owned session persists the failed run, reset time, Stop epoch and a lane
checkpoint. The lane pauses with `waiting_for_limit_reset:<ISO timestamp>`.
The fleet reports waiting, the sidebar shows the reset time, and packet status
reports blocked with the same reason. This state survives a server restart.

The existing 15-second fleet poll checks due waits. Capacity must be observed
available before resuming. Unknown observations stay parked; probes are bounded
to eight seconds and at least 30 seconds apart. Extended exhausted windows update
the saved reset. Three consecutive capacity resumes are allowed per session;
successful work resets that budget. There is no model inference during a probe.

Resume reuses the session's thread, account, model, effort, work mode and checkout.
Stop, detach, archive, packet holds, replacement sessions and changed run generations
cancel admission. An explicit resume replaces the schedule. Single-attempt workers,
controlled tasks and non-native execution carriers do not receive automatic capacity
recovery.

A saved lane checkpoint completes a crash-interrupted wait transition. The schedule
is consumed before process preparation. If a restart finds that claim without a
proven new run, it holds the worker for inspection instead of replaying a potentially
started process. A proven resume can finish its lane checkpoint.

When the existing cross-runtime fallback preference permits an equivalent native
subscription runtime, the destination receives the original task contract, latest
request, bounded recent messages, tracked workspace diff and working-tree status.
Source binding and Stop intent fence both evidence collection and process launch.
The original lane records the handoff. Approvals, scope and retry counters are not
reset. If both routes exhaust, an observable reset can park the current session;
otherwise the existing operator card remains.

Verification uses [real worker fixtures](../../tests/worker-capacity-resume-real-path.test.ts) and
[provider control fixtures](../../src/lib/claude-code/live-capacity.test.ts).
No live account or native desktop acceptance is needed for those checks.
