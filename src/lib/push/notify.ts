/**
 * Server-side push fan-out helpers.
 *
 * Call these from anywhere we already detect an "operator-noteworthy" event
 * (approval created, agent finished, merge conflict, etc.). They:
 *   - load every subscription
 *   - fire encrypted Web Push (or webhook) requests in parallel
 *   - prune dead subscriptions on 404/410
 *   - silently no-op when no subscriptions are registered
 *
 * Issue: https://github.com/o8-run/o8/issues/639
 */

import 'server-only';
import { listPushSubscriptions } from './store';
import { recordPushGate, type PushGateEvent } from './push-gate';
import { sendPushToSubscription, type PushPayload, type SendResult } from './send';

const ENABLED = process.env.O8_PUSH_NOTIFICATIONS_ENABLED !== '0';

export async function notifyAll(payload: PushPayload): Promise<SendResult[]> {
  if (!ENABLED) return [];

  const subs = listPushSubscriptions();
  if (subs.length === 0) return [];

  const results = await Promise.allSettled(subs.map((sub) => sendPushToSubscription(sub, payload)));
  return results.map((r, idx) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      endpoint: subs[idx].endpoint,
      ok: false,
      status: 0,
      reason: r.reason instanceof Error ? r.reason.message : 'unknown',
    };
  });
}

/**
 * Fire-and-forget wrapper. Use from non-async call sites where we want to
 * trigger the fan-out without blocking the originating event handler.
 */
export function notifyAllInBackground(payload: PushPayload, gate?: PushGateEvent): void {
  void notifyAll(payload).catch((error) => {
    console.warn('[push-notify] background notify failed', error);
  });
  // Record-only push gate (#2441): the push above is already on its way.
  if (gate && ENABLED) recordPushGate(gate);
}

// ── Pre-baked payload helpers for the four trigger points (issue spec) ──

export function notifyApprovalCreated(opts: {
  approvalId: string;
  title: string;
  risk?: string;
}): void {
  notifyAllInBackground({
    title: 'Approval needed',
    body: opts.title,
    tag: `approval-${opts.approvalId}`,
    data: { approvalId: opts.approvalId, risk: opts.risk, kind: 'approval' },
  }, { kind: 'approval_created', approvalId: opts.approvalId });
}

export function notifyAgentFinished(opts: {
  sessionName: string;
  state: 'completed' | 'failed' | 'killed' | 'stalled';
  exitCode?: number;
}): void {
  const labelByState: Record<typeof opts.state, string> = {
    completed: 'finished',
    failed: 'failed',
    killed: 'was stopped',
    stalled: 'is stalled',
  };
  notifyAllInBackground({
    title: `${opts.sessionName} ${labelByState[opts.state]}`,
    body: opts.exitCode !== undefined ? `exit ${opts.exitCode}` : labelByState[opts.state],
    tag: `agent-${opts.sessionName}`,
    data: { sessionName: opts.sessionName, state: opts.state, kind: 'agent' },
  }, { kind: 'agent_finished', sessionKey: opts.sessionName, terminalState: opts.state });
}

export function notifyMergeConflict(opts: {
  repo: string;
  fileCount: number;
}): void {
  notifyAllInBackground({
    title: 'Merge conflict',
    body: `${opts.fileCount} file${opts.fileCount === 1 ? '' : 's'} on ${opts.repo} need attention`,
    tag: `conflict-${opts.repo}`,
    data: { repo: opts.repo, fileCount: opts.fileCount, kind: 'conflict' },
  }, { kind: 'merge_conflict' });
}

export function notifyOrchestratorReady(opts: {
  threadId?: string;
  summary?: string;
}): void {
  notifyAllInBackground({
    title: 'Orchestrator ready',
    body: opts.summary ?? 'Awaiting your input',
    tag: opts.threadId ? `orchestrator-${opts.threadId}` : 'orchestrator',
    data: { threadId: opts.threadId, kind: 'orchestrator' },
  }, { kind: 'orchestrator_ready' });
}

/**
 * Pipeline root fix (2026-07-03) — the missing "work is ready for review"
 * trigger. A lane entering `reviewing` with committed work used to emit only
 * the lane-lifecycle WS event + MCP ring-buffer entry; no push ever fired, so
 * an away operator (or a phone) never heard that review-ready work existed —
 * and stale review-ready lanes aged into reaper territory unseen.
 *
 * NOT the entry point any more (#2150): `publishLaneLifecycleEvent` goes through
 * `review-ready-coalescer.ts`, which batches a parallel dispatch into one
 * notification and applies the on/off setting plus the quiet-mode override. A
 * direct call here bypasses both — use the coalescer.
 */
export function notifyReviewReady(opts: {
  laneId: string;
  label: string;
  packetId?: string | null;
  repoPath?: string;
}): void {
  notifyAllInBackground({
    title: 'Ready for review',
    body: opts.label,
    tag: `review-ready-${opts.laneId}`,
    data: { laneId: opts.laneId, packetId: opts.packetId ?? undefined, repoPath: opts.repoPath, kind: 'review-ready' },
  }, { kind: 'review_ready', laneId: opts.laneId, packetId: opts.packetId });
}
