import 'server-only';
import { createHash } from 'node:crypto';
import { getSqlite } from '@/lib/db';
import { listLanes } from '@/lib/lane/registry';
import { readEffectivePolicy } from '@/lib/lane/effective-policy-read';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import type { Lane } from '@/lib/lane/types';
import type { InboxDecision, InboxDecisions } from './decisions';

interface ReviewJob { id: string; head_sha: string | null; status: string; attempts: number }
const HISTORY_REVISIONS_PER_TASK = 10;
const ATTEMPT_RECEIPTS_PER_TASK = 50;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = (lane: Lane) => lane.status === 'completed' || lane.status === 'archived';

/** Existing durable identities own deduplication and history. No inbox writes,
 * reconciliation, worker discovery, model turns or publication on this path. */
export async function readInboxDecisions(options: {
  state: 'unresolved' | 'history' | 'all'; projectId?: string; cursor?: string; limit: number;
}): Promise<InboxDecisions> {
  const db = getSqlite();
  const packets = readOrchestratorControlPlaneState().packets;
  const lanes = listLanes();
  const owners = new Map<string, Lane>();
  for (const lane of lanes) owners.set(lane.packetId ?? lane.id, lane);
  const reviewedTasks = new Set((db.prepare(`SELECT l.packet_id, l.id FROM lanes l WHERE EXISTS
    (SELECT 1 FROM review_queue q WHERE q.lane_id = l.id) OR EXISTS
    (SELECT 1 FROM correction_reviews c WHERE c.lane_id = l.id) OR EXISTS
    (SELECT 1 FROM lane_events e WHERE e.lane_id = l.id AND e.verb IN ('review_recorded', 'review_queue_blocked'))`).all() as Array<{ packet_id: string | null; id: string }>)
    .map(row => row.packet_id ?? row.id));
  const candidates = [...owners.values()].filter(lane => !options.projectId || lane.projectId === options.projectId)
    .filter(lane => reviewedTasks.has(lane.packetId ?? lane.id)
    || ['reviewing', 'merging'].includes(lane.status)
    || packets.some(packet => packet.id === lane.packetId && packet.review))
    .sort((a, b) => a.id.localeCompare(b.id));
  // Pagination bounds expensive Git/policy reads, including resolved rows.
  const page = candidates.filter(lane => !options.cursor || lane.id > options.cursor).slice(0, options.limit);
  const decisions: InboxDecision[] = [];
  for (const lane of page) {
    const taskId = lane.packetId ?? lane.id;
    const packet = packets.find(item => item.id === lane.packetId)
      ?? (lane.packetId ? findMissionRegistryEntryByPacketId(lane.packetId, { includeArchived: true })?.mission.packets.find(item => item.id === lane.packetId) : undefined);
    const jobs = db.prepare(`SELECT q.id, q.head_sha, q.status, q.attempts FROM review_queue q JOIN lanes l ON l.id = q.lane_id
      WHERE ${lane.packetId ? 'l.packet_id' : 'l.id'} = ? ORDER BY q.rowid DESC`).all(lane.packetId ?? lane.id) as ReviewJob[];
    const recorded = db.prepare(`SELECT e.id, e.payload_json FROM lane_events e JOIN lanes l ON l.id = e.lane_id
      WHERE ${lane.packetId ? 'l.packet_id' : 'l.id'} = ? AND e.verb = 'review_recorded' ORDER BY e.rowid DESC`)
      .all(lane.packetId ?? lane.id) as Array<{ id: string; payload_json: string }>;
    for (const receipt of recorded) {
      try {
        const value = JSON.parse(receipt.payload_json) as Record<string, unknown>;
        if (typeof value?.reviewedHeadSha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.reviewedHeadSha)) {
          jobs.push({ id: receipt.id, head_sha: value.reviewedHeadSha, status: 'recorded', attempts: 0 });
        }
      } catch { /* Malformed activity is not a verified revision receipt. */ }
    }
    const corrections = db.prepare(`SELECT c.correction_id, d.status FROM correction_reviews c
      LEFT JOIN worker_correction_deliveries d ON d.correction_id = c.correction_id WHERE ${lane.packetId ? 'c.packet_id' : 'c.lane_id'} = ? ORDER BY c.rowid, d.surface_id`).all(lane.packetId ?? lane.id) as Array<{ correction_id: string; status: string | null }>;
    const uncertain = corrections.some(item => !['delivered', 'stopped', 'unavailable', 'held'].includes(item.status ?? ''));
    const policy = await readEffectivePolicy(lane.id);
    const headSha = policy?.headSha ?? null;
    const state = uncertain ? 'unresolved' : terminal(lane) ? 'resolved' : 'unresolved';
    // Ordinary active work is progress. History below remains reachable even
    // while a replacement author is running or waiting for its next review.
    const currentVisible = state !== 'unresolved' || uncertain
      || ['reviewing', 'merging', 'paused', 'failed', 'recovering', 'awaiting_input', 'awaiting_human', 'awaiting_orchestrator'].includes(lane.status);
    const reviewPending = jobs.some(job => ['pending', 'in_progress'].includes(job.status) && job.head_sha === headSha);
    const routineReview = state === 'unresolved' && lane.status === 'reviewing' && reviewPending && !uncertain
      && !packet?.blockedReason && !packet?.mergeHold && packet?.queueState !== 'held'
      && !policy?.holds.value.some(hold => hold.blocks.includes('review'));
    const kind = uncertain || !headSha ? 'human' : policy?.nextAction.value ?? 'human';
    const path = `/api/lanes/${encodeURIComponent(lane.id)}`;
    const evidence = { diff: `${path}/diff`, activity: `${path}/events`, policy: `${path}/policy`,
      review: lane.packetId ? `/api/orchestrator/review-state?packetId=${encodeURIComponent(lane.packetId)}` : null,
      correction: lane.packetId ? `/api/orchestrator/worker-corrections?packetId=${encodeURIComponent(lane.packetId)}` : null };
    const review = packet?.review ? { approvalId: packet.review.auditApprovalId ?? null, headSha: packet.review.reviewedHeadSha ?? null,
      findings: packet.review.findings.filter(finding => finding.resolution === 'deferred').length } : null;
    const blocker = uncertain ? 'A correction delivery has an uncertain outcome. Inspect its persisted receipt before retrying.'
      : policy?.nextAction.reason ?? 'Policy is unavailable. Inspect the current task before continuing.';
    const base: InboxDecision = {
      id: `decision-${digest([taskId, headSha])}`, revisionToken: digest([lane.id, headSha, policy?.holds.value, kind, packet?.review?.auditApprovalId, packet?.review?.findings, corrections]),
      taskId, laneId: lane.id, packetId: lane.packetId, projectId: lane.projectId, title: packet?.title ?? lane.label,
      repository: { id: digest(lane.repoPath), projectId: lane.projectId, branch: lane.branch, pullRequest: lane.prNumber }, headSha,
      phase: reviewPending || policy?.durableReview.value?.approved !== true || jobs.some(job => job.status === 'failed' && job.head_sha === headSha) || packet?.review?.approved === false ? 'review' : 'integration', state,
      responsibleAgent: { runtime: lane.runtime, sessionId: lane.sessionKey }, blocker,
      attempts: { review: jobs.reduce((sum, job) => sum + job.attempts, 0), correction: policy?.correctionBounds.used.value ?? null,
        maximumCorrections: policy?.correctionBounds.maximum.value ?? null }, review, uncertain,
      priorAttempts: { reviews: jobs.slice(0, ATTEMPT_RECEIPTS_PER_TASK).map(job => ({ id: job.id, headSha: job.head_sha, status: job.status, attempts: job.attempts })),
        corrections: corrections.slice(-ATTEMPT_RECEIPTS_PER_TASK).map(item => ({ id: item.correction_id, status: item.status })) },
      historyTruncated: jobs.length > ATTEMPT_RECEIPTS_PER_TASK || corrections.length > ATTEMPT_RECEIPTS_PER_TASK,
      primaryAction: state !== 'unresolved' ? null : { kind, method: 'GET',
        label: kind === 'human' ? 'Inspect blocker' : kind === 'approval_required' ? 'Inspect required approval' : 'Prepare pull request',
        path: uncertain && evidence.correction ? evidence.correction
          : kind === 'approval_required' ? '/api/panel/approvals?status=pending' : evidence.policy,
        consequence: kind === 'human' ? 'Inspect evidence and reconcile the blocker before choosing an existing governed action.'
          : 'Read current policy, then use the existing governed create_pr route. All execution and revision checks still apply.' },
      evidence, policy,
    };
    if (currentVisible && !routineReview) decisions.push(base);
    // Every observed prior review revision is history, including queue rows
    // completed by supersession. Never relabel current evidence as old evidence.
    const oldHeads = [...new Set(jobs.filter(job => headSha && job.head_sha && job.head_sha !== headSha).map(job => job.head_sha!))];
    for (const oldHead of oldHeads.slice(0, HISTORY_REVISIONS_PER_TASK)) {
      decisions.push({ ...base, id: `decision-${digest([taskId, oldHead])}`, headSha: oldHead, state: 'superseded',
        blocker: 'A saved review attempt belongs to an earlier revision. Inspect its activity receipt; it grants no authority for the current revision.',
        review: null, phase: 'review', responsibleAgent: null,
        attempts: { review: jobs.filter(job => job.head_sha === oldHead).reduce((sum, job) => sum + job.attempts, 0), correction: null, maximumCorrections: null },
        priorAttempts: { reviews: jobs.filter(job => job.head_sha === oldHead).slice(0, ATTEMPT_RECEIPTS_PER_TASK)
          .map(job => ({ id: job.id, headSha: job.head_sha, status: job.status, attempts: job.attempts })), corrections: [] }, revisionToken: digest([taskId, oldHead, 'superseded']), primaryAction: null, policy: null, uncertain: false,
        historyTruncated: base.historyTruncated || oldHeads.length > HISTORY_REVISIONS_PER_TASK });
    }
    if (oldHeads.length > HISTORY_REVISIONS_PER_TASK) base.historyTruncated = true;
  }
  return { schema: 'o8/inbox-decisions/v1', readAt: new Date().toISOString(),
    decisions: decisions.filter(item => options.state === 'all' || (options.state === 'history' ? item.state !== 'unresolved' : item.state === 'unresolved')),
    nextCursor: candidates.some(lane => lane.id > (page.at(-1)?.id ?? '')) && page.length ? page.at(-1)!.id : null };
}
