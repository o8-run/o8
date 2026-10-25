import 'server-only';

import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { getApproval, listApprovalsForContext } from '@/lib/approvals/store';
import { getLane, listLanes } from '@/lib/lane/registry';
import { readHeadSha } from '@/lib/lane/head-sha-lock';
import { laneGitSync } from '@/lib/lane/lane-git';
import { ownedRoots } from '@/lib/runtimes/shared/owned-session-index';
import { createOwnedSessionIo } from '@/lib/runtimes/shared/owned-session/session-io';
import { readOwnedSessionMetadataSync } from '@/lib/runtimes/shared/owned-session/metadata-read';
import type { OwnedRunRecord, OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';
import { resolveTerminalStatusEvidence } from './resolve';
import type { TerminalApprovalAdapter } from './approval-adapter';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class TerminalApprovalChangedError extends Error {
  constructor() { super('The reviewed terminal session, run or HEAD changed. Read the lane decision again.'); }
}
type TerminalApprovalSubject = Pick<TerminalApprovalAdapter,
  'runtime' | 'sessionKey' | 'terminalSession' | 'laneId' | 'laneRevision' | 'headSha' | 'subjectRevision' | 'sessionRevision' | 'runId'>;

function sessionRevision(session: OwnedSessionRecord, run: OwnedRunRecord): string {
  return digest({ surfaceId: session.surfaceId, sessionDir: session.sessionDir, threadId: session.threadId, laneId: session.laneId,
    cwd: session.cwd, repoPath: session.repoPath, workspaceBinding: session.workspaceBinding, executionPolicy: session.executionPolicy,
    detachedAt: session.detachedAt, orphanedAt: session.orphanedAt,
    runId: run.id, outcome: run.outcome, finishedAt: run.finishedAt, tmuxSession: run.tmuxSession, interruptRequestedAt: run.interruptRequestedAt });
}

function sessionClaimMatches(expected: TerminalApprovalAdapter, preparedRunId?: string): boolean {
  const root = ownedRoots().find(entry => entry.marker === `${expected.runtime}-owned:`);
  const name = root && expected.sessionKey.startsWith(root.marker) ? expected.sessionKey.slice(root.marker.length) : '';
  if (!root || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) return false;
  const directory = path.join(realpathSync(root.root), name);
  const currentSession = () => {
    const entry = lstatSync(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    const session = readOwnedSessionMetadataSync<OwnedSessionRecord>(path.join(directory, 'session.json'));
    if (!Array.isArray(session.recentRuns)) return null;
    if (preparedRunId && (session.activeRun?.id !== preparedRunId || session.activeRun.spawnState !== 'prepared'
      || session.recentRuns[0]?.id !== preparedRunId)) return null;
    const run = preparedRunId ? session.recentRuns.find(candidate => candidate.id !== preparedRunId) : session.activeRun ?? session.recentRuns[0];
    return run && run.id === expected.runId && sessionRevision(session, run) === expected.sessionRevision ? session : null;
  };
  const session = currentSession();
  if (!session || laneGitSync(session.cwd, session.repoPath, ['rev-parse', 'HEAD'], { timeout: 5000 }).trim() !== expected.headSha) return false;
  // Git crosses process boundaries. Re-read the exact lane/session afterward,
  // inside the synchronous admission that immediately creates the process.
  return Boolean(currentSession() && terminalApprovalLaneMatches(expected));
}

export function terminalApprovalLaneMatches(expected: TerminalApprovalAdapter): boolean {
  const lane = getLane(expected.laneId);
  return Boolean(lane && lane.sessionKey === expected.sessionKey && digest(lane) === expected.laneRevision);
}

/** Runs inside the approval transaction, including same-timestamp replacements. */
export function terminalApprovalClaimMatches(expected: TerminalApprovalAdapter): boolean {
  try {
    return terminalApprovalLaneMatches(expected) && digest(getApproval(expected.approvalId)) === expected.approvalRevision && sessionClaimMatches(expected);
  } catch { return false; }
}

/** Reused by the final synchronous provider-store admission immediately before spawn. */
export function assertTerminalApprovalSpawnClaim(expected: TerminalApprovalAdapter, preparedRunId?: string): void {
  try { if (terminalApprovalLaneMatches(expected) && sessionClaimMatches(expected, preparedRunId)) return; } catch { /* Refuse unreadable or changed evidence. */ }
  throw new TerminalApprovalChangedError();
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
  const revision = sessionRevision(session, run);
  const subjectRevision = digest({ laneRevision, sessionRevision: revision, headSha });
  return { runtime, sessionKey, terminalSession, laneId: lane.id, laneRevision, headSha, subjectRevision, sessionRevision: revision, runId: run.id };
}

/** Rechecked inside the owned session lock. A failed fence never falls back to a new launch. */
export async function assertTerminalApprovalSubject(expected: TerminalApprovalAdapter, session: OwnedSessionRecord | null): Promise<void> {
  const subject = await readSubject(expected.sessionKey, expected.terminalSession, session);
  if (!subject || subject.subjectRevision !== expected.subjectRevision) throw new TerminalApprovalChangedError();
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
