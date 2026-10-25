import 'server-only';

import { createHash } from 'node:crypto';
import { getApproval, listApprovalsForContext } from '@/lib/approvals/store';
import { getLane, listLanes } from '@/lib/lane/registry';
import { readHeadSha } from '@/lib/lane/head-sha-lock';
import { ownedRoots } from '@/lib/runtimes/shared/owned-session-index';
import { createOwnedSessionIo } from '@/lib/runtimes/shared/owned-session/session-io';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { resolveTerminalStatusEvidence } from './resolve';
import type { TerminalApprovalAdapter } from './approval-adapter';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type TerminalApprovalSubject = Pick<TerminalApprovalAdapter,
  'runtime' | 'sessionKey' | 'terminalSession' | 'laneId' | 'laneRevision' | 'headSha' | 'subjectRevision' | 'runId'>;

export function terminalApprovalLaneMatches(expected: TerminalApprovalAdapter): boolean {
  const lane = getLane(expected.laneId);
  return Boolean(lane && lane.sessionKey === expected.sessionKey && digest(lane) === expected.laneRevision);
}

/** Runs inside the approval transaction, including same-timestamp replacements. */
export function terminalApprovalClaimMatches(expected: TerminalApprovalAdapter): boolean {
  return terminalApprovalLaneMatches(expected) && digest(getApproval(expected.approvalId)) === expected.approvalRevision;
}

async function readSubject(sessionKey: string, terminalSession: string, suppliedSession?: OwnedSessionRecord | null): Promise<TerminalApprovalSubject | null> {
  const runtime = sessionKey.startsWith('codex-owned:') ? 'codex'
    : sessionKey.startsWith('claude-code-owned:') ? 'claude-code' : null;
  if (!runtime || !terminalSession.trim()) return null;
  const lanes = listLanes().filter(lane => lane.sessionKey === sessionKey && lane.status !== 'archived');
  if (lanes.length !== 1) return null;
  const lane = lanes[0];
  if (lane.runtime !== runtime || !['awaiting_input', 'awaiting_human', 'paused'].includes(lane.status)) return null;
  const root = ownedRoots().find(entry => entry.marker === `${runtime}-owned:`);
  if (!root) return null;
  const io = createOwnedSessionIo({ root: root.root, surfacePrefix: root.marker, invalidateFleetCache: () => {} });
  const session = suppliedSession === undefined ? await io.findSession(sessionKey) : suppliedSession;
  if (!session || session.surfaceId !== sessionKey || session.laneId !== lane.id || !session.threadId
    || session.detachedAt || session.orphanedAt || session.executionPolicy !== undefined
    || session.cwd !== (lane.worktreePath || lane.repoPath)) return null;
  // appendOwnedRun prepends, so the first retained run is authoritative.
  const run = session.activeRun ?? session.recentRuns[0];
  if (!run || !['finished', 'failed', 'interrupted'].includes(run.outcome)
    || !run.finishedAt || run.tmuxSession !== terminalSession) return null;
  const laneRevision = digest(lane);
  const headSha = await readHeadSha(session.cwd, lane.repoPath);
  if (digest(getLane(lane.id)) !== laneRevision) return null;
  const subjectRevision = digest({ laneRevision, sessionKey, terminalSession, threadId: session.threadId,
    cwd: session.cwd, runId: run.id, outcome: run.outcome, finishedAt: run.finishedAt, headSha });
  return { runtime, sessionKey, terminalSession, laneId: lane.id, laneRevision, headSha, subjectRevision, runId: run.id };
}

/** Rechecked inside the owned session lock. A failed fence never falls back to a new launch. */
export async function assertTerminalApprovalSubject(expected: TerminalApprovalAdapter, session: OwnedSessionRecord | null): Promise<void> {
  const subject = await readSubject(expected.sessionKey, expected.terminalSession, session);
  if (!subject || subject.subjectRevision !== expected.subjectRevision) throw new Error('The reviewed terminal session, run or HEAD changed. Read the lane decision again.');
}

/** Only o8-owned, settled coding runs support lane resume. External CLI continuation is separate. */
export async function readTerminalApprovalAdapter(sessionKey: string, terminalSession: string): Promise<TerminalApprovalAdapter | null> {
  try {
    const subject = await readSubject(sessionKey, terminalSession);
    if (!subject) return null;
    const approvals = listApprovalsForContext({ laneId: subject.laneId, sessionKey })
      .filter(approval => approval.status === 'pending' && approval.sessionKey === sessionKey);
    if (approvals.length !== 1) return null;
    const approval = approvals[0];
    if (approval.runtime !== subject.runtime || approval.continuation?.kind !== 'lane'
      || approval.continuation.verb !== 'resume' || approval.continuation.laneId !== subject.laneId) return null;
    const evidence = resolveTerminalStatusEvidence({ lane: getLane(subject.laneId), approvals: [approval] });
    if (evidence.state !== 'blocked' || evidence.authority !== 'lane-state') return null;
    return { ...subject, version: 1, authority: 'lane-state', approvalId: approval.id,
      approvalUpdatedAt: approval.updatedAt, approvalRevision: digest(approval), revision: digest({ subject, approval }), title: approval.title, summary: approval.summary };
  } catch {
    // Missing/malformed records, unavailable Git, or an unrecognized binding stay raw.
    return null;
  }
}
