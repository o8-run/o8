import { execFile } from '@/lib/providers/child-process';
import { existsWhenReachable } from '@/lib/fs/protected-folders';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ApprovalRecord } from '@/lib/approvals/types';
import type { AgentSummary, ReviewChangedFile, WorkflowReviewSnapshot } from '@/lib/fleet/types';
import { findLaneBySession } from '@/lib/lane/registry';
import { summarizeLaneReviewDiff } from '@/lib/review/lane-diff';
import type { MobileReviewUnit } from '@/lib/mobile/types';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

export interface MobileReviewUnitDiff {
  worktreePath?: string;
  baseBranch?: string;
  headSha?: string;
  changedFiles: ReviewChangedFile[];
  additions: number;
  deletions: number;
}

export interface BuildMobileReviewUnitsOptions {
  sessions: AgentSummary[];
  pendingApprovals: ApprovalRecord[];
  reviewSnapshot?: WorkflowReviewSnapshot | null;
  collectSessionDiff?: (session: AgentSummary) => Promise<MobileReviewUnitDiff | null>;
}

function repoNameFromPath(repoPath: string) {
  return path.basename(repoPath.trim()) || repoPath || 'unknown';
}

function sessionRepoPath(session?: AgentSummary) {
  return session?.runtimeSurface?.cwd?.trim() || session?.workspace?.trim() || '';
}

function sessionRepoSlug(session?: AgentSummary) {
  return session?.runtimeSurface?.reviewContext?.repoSlug?.trim();
}

function sessionBranch(session?: AgentSummary) {
  return session?.runtimeSurface?.reviewContext?.branch?.trim()
    || session?.runtimeSurface?.branch?.trim()
    || session?.branch?.trim()
    || 'unknown';
}

function statusForSession(session?: AgentSummary): MobileReviewUnit['status'] {
  if (!session) return 'awaiting_review';
  if (session.status === 'running' || session.status === 'huddling' || session.status === 'waiting') return 'running';
  if (session.status === 'blocked') return 'blocked';
  if (session.status === 'failed') return 'failed';
  if (session.status === 'completed') return 'merged';
  return 'awaiting_review';
}

function approvalFiles(approval: ApprovalRecord): ReviewChangedFile[] {
  return (approval.diff?.files ?? []).map((file) => ({
    path: file.path,
    status: file.status === 'A' ? 'added'
      : file.status === 'D' ? 'deleted'
        : file.status === 'R' ? 'renamed'
          : 'modified',
  }));
}

function buildApprovalUnit(
  approval: ApprovalRecord,
  session: AgentSummary | undefined,
  diff: MobileReviewUnitDiff | null,
): MobileReviewUnit {
  const repoPath = sessionRepoPath(session)
    || (approval.continuation?.kind === 'llm-chat' ? approval.continuation.repoPath : undefined)
    || '';
  const changedFiles = diff?.changedFiles.length ? diff.changedFiles : approvalFiles(approval);
  return {
    id: `approval:${approval.id}`,
    sessionKey: approval.sessionKey,
    approvalId: approval.id,
    authority: 'approval_gate',
    status: 'awaiting_review',
    title: approval.title,
    agent: approval.agent,
    runtime: approval.runtime,
    repo: repoNameFromPath(repoPath),
    repoSlug: sessionRepoSlug(session),
    repoPath,
    branch: sessionBranch(session),
    baseBranch: diff?.baseBranch,
    headSha: diff?.headSha,
    worktreePath: diff?.worktreePath,
    changedFiles,
    fileCount: changedFiles.length,
    additions: diff?.additions ?? 0,
    deletions: diff?.deletions ?? 0,
    diffAvailable: Boolean(diff?.worktreePath) || changedFiles.length > 0,
    previewUrl: session?.browserSurface?.url ?? null,
    terminalSessionName: session?.tmuxSession ?? null,
    actions: ['inspect', 'comment', 'approve', 'request_changes', 'deny'],
  };
}

function isInspectableReviewSession(session: AgentSummary, approvalSessionKeys: Set<string>) {
  return session.status === 'reviewing'
    && session.runtime === 'codex'
    && session.runtimeSurface?.ownership === 'owned'
    && !approvalSessionKeys.has(session.sessionKey);
}

function buildInspectOnlyUnit(
  session: AgentSummary,
  diff: MobileReviewUnitDiff,
): MobileReviewUnit | null {
  if (diff.changedFiles.length === 0 && diff.additions === 0 && diff.deletions === 0) {
    return null;
  }
  const repoPath = sessionRepoPath(session) || diff.worktreePath || '';
  return {
    id: `review-session:${session.sessionKey}`,
    sessionKey: session.sessionKey,
    authority: 'inspect_only',
    status: statusForSession(session),
    title: session.currentTask || session.surfaceLabel || session.name,
    agent: session.name,
    runtime: session.runtime,
    repo: repoNameFromPath(repoPath),
    repoSlug: sessionRepoSlug(session),
    repoPath,
    branch: sessionBranch(session),
    baseBranch: diff.baseBranch,
    headSha: diff.headSha,
    worktreePath: diff.worktreePath,
    changedFiles: diff.changedFiles,
    fileCount: diff.changedFiles.length,
    additions: diff.additions,
    deletions: diff.deletions,
    diffAvailable: true,
    previewUrl: session.browserSurface?.url ?? null,
    terminalSessionName: session.tmuxSession ?? null,
    actions: ['inspect', 'comment', 'steer', 'stop'],
  };
}

export function shouldExposeWorkspaceReviewSnapshot(reviewSnapshot: WorkflowReviewSnapshot | null | undefined) {
  if (!reviewSnapshot) return false;
  const hasIdentity = Boolean(reviewSnapshot.repoSlug.trim())
    && reviewSnapshot.branch.trim() !== ''
    && reviewSnapshot.branch !== 'unknown';
  const hasReviewWork = reviewSnapshot.pullRequests.length > 0
    || reviewSnapshot.changedFiles.length > 0
    || reviewSnapshot.dirty;
  return hasIdentity && hasReviewWork;
}

export function summarizeMobileReviewUnits(units: MobileReviewUnit[]) {
  return {
    reviewItems: units.length,
    inspectOnlyReviews: units.filter((unit) => unit.authority === 'inspect_only').length,
  };
}

export async function buildMobileReviewUnits({
  sessions,
  pendingApprovals,
  collectSessionDiff = collectSessionReviewDiff,
}: BuildMobileReviewUnitsOptions): Promise<MobileReviewUnit[]> {
  const sessionsByKey = new Map(sessions.map((session) => [session.sessionKey, session]));
  const approvalSessionKeys = new Set(pendingApprovals.map((approval) => approval.sessionKey));
  const units: MobileReviewUnit[] = [];

  for (const approval of pendingApprovals) {
    const session = sessionsByKey.get(approval.sessionKey);
    const diff = session ? await collectSessionDiff(session).catch(() => null) : null;
    units.push(buildApprovalUnit(approval, session, diff));
  }

  for (const session of sessions) {
    if (!isInspectableReviewSession(session, approvalSessionKeys)) continue;
    const diff = await collectSessionDiff(session).catch(() => null);
    if (!diff) continue;
    const unit = buildInspectOnlyUnit(session, diff);
    if (unit) units.push(unit);
  }

  return units;
}

async function runGit(cwd: string, args: string[], maxBuffer = MAX_DIFF_BYTES) {
  const { stdout } = await execFileAsync('git', args, {
    windowsHide: true,
    cwd,
    timeout: 10_000,
    maxBuffer,
  });
  return stdout;
}

export async function collectSessionReviewDiff(session: AgentSummary): Promise<MobileReviewUnitDiff | null> {
  let worktreePath = session.runtimeSurface?.cwd ?? '';
  let baseBranch: string | undefined;

  try {
    const lane = findLaneBySession(session.sessionKey);
    if (lane) {
      worktreePath = lane.worktreePath ?? lane.repoPath ?? worktreePath;
      baseBranch = lane.baseBranch || undefined;
    }
  } catch {
    // Fall back to the runtime surface cwd below.
  }

  if (!worktreePath || !existsWhenReachable(worktreePath)) return null;

  const sections: string[] = [];
  if (baseBranch) {
    const branchDiff = await runGit(worktreePath, ['diff', '--no-color', `${baseBranch}...HEAD`]).catch(() => '');
    if (branchDiff.trim()) sections.push(branchDiff);
  }
  const dirtyDiff = await runGit(worktreePath, ['diff', '--no-color', 'HEAD']).catch(() => '');
  if (dirtyDiff.trim()) sections.push(dirtyDiff);
  const summarized = summarizeLaneReviewDiff(sections.join('\n'));
  const headSha = await runGit(worktreePath, ['rev-parse', 'HEAD']).then((value) => value.trim()).catch(() => undefined);

  return {
    worktreePath,
    baseBranch,
    headSha,
    changedFiles: summarized.files.map((file) => {
      const { patch, ...summaryFile } = file;
      void patch;
      return summaryFile;
    }),
    additions: summarized.additions,
    deletions: summarized.deletions,
  };
}
