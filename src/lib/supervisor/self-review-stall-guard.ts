import { laneGit, LaneGitMetadataError } from '@/lib/lane/lane-git';
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { ownedTranscriptMtimeMs } from '@/lib/lane/reaper-liveness';
import type { Lane } from '@/lib/lane/types';

const COMMAND_MAX_BUFFER = 4 * 1024 * 1024;
const AUTO_COMMIT_AFTER_VERIFIED_IDLE_MS = 2 * 60_000;
const SELF_REVIEW_HARD_DEADLINE_MS = 5 * 60_000;
const SELF_REVIEW_ACTIVITY_WINDOW_MS = SELF_REVIEW_HARD_DEADLINE_MS;
const STALL_SIGNAL_MS = 10 * 60_000;
const MIN_PROBE_INTERVAL_MS = 15_000;

interface TranscriptEntryLike {
  id: string;
  role: string;
  text: string;
  toolName?: string;
}

type LaneSnapshot = Pick<
  Lane,
  'id' | 'label' | 'repoPath' | 'worktreePath' | 'baseBranch' | 'status' | 'packetId' | 'runtime' | 'lastEventAt'
>;

interface GuardState {
  firstObservedAt: number;
  initialHead: string | null;
  lastProbeAt: number;
  lastEditSignature: string | null;
  lastEditAt: number;
  lastTranscriptActivityAt: number | null;
  verifiedAt: number | null;
  signalSentAt: number | null;
  forceStartedAt: number | null;
}

interface WorktreeSnapshot {
  cwd: string;
  head: string | null;
  dirty: boolean;
  hasDiffAgainstBase: boolean;
  changedPaths: string[];
  signature: string;
  latestFileMtimeMs: number | null;
}

export interface SelfReviewStallProbeInput {
  surfaceId: string;
  lane: LaneSnapshot;
  transcript: TranscriptEntryLike[];
  startedAt?: number | null;
  now?: number;
}

export type SelfReviewStallDecision =
  | { kind: 'none' }
  | {
      kind: 'signal-stall';
      reason: string;
      runningMs: number;
      head: string | null;
    }
  | {
      kind: 'force-review';
      reason: string;
      idleMs: number;
      verification: VerificationEvidence;
      cwd: string;
    };

interface VerificationEvidence {
  typecheckPassed: boolean;
  lintPassed: boolean;
  selfReviewLikely: boolean;
}

export interface SelfReviewStallWorkPreservation {
  committed: boolean;
  hasReviewableDiff: boolean;
  captureRef?: string;
  error?: string;
}

const states = new Map<string, GuardState>();

export function resetSelfReviewStallGuard(surfaceId: string): void {
  states.delete(surfaceId);
}

export async function hasFreshSelfReviewTranscriptActivity(
  surfaceId: string,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const activityAt = await ownedTranscriptMtimeMs(surfaceId);
    return activityAt !== null
      && Math.max(0, now - activityAt) <= SELF_REVIEW_ACTIVITY_WINDOW_MS;
  } catch {
    return false;
  }
}

export async function probeSelfReviewStall(
  input: SelfReviewStallProbeInput,
): Promise<SelfReviewStallDecision> {
  const now = input.now ?? Date.now();
  const lane = input.lane;
  if (lane.runtime !== 'codex' || lane.status !== 'running' || !lane.packetId) {
    resetSelfReviewStallGuard(input.surfaceId);
    return { kind: 'none' };
  }

  const existing = states.get(input.surfaceId);
  if (existing && now - existing.lastProbeAt < MIN_PROBE_INTERVAL_MS) {
    return { kind: 'none' };
  }

  const snapshot = await readWorktreeSnapshot(lane.worktreePath ?? lane.repoPath, lane.repoPath, lane.baseBranch);
  const hasCommitWorthyWork = snapshot.dirty || snapshot.hasDiffAgainstBase;
  if (!hasCommitWorthyWork) {
    resetSelfReviewStallGuard(input.surfaceId);
    return { kind: 'none' };
  }

  const state = existing ?? {
    firstObservedAt: input.startedAt ?? parseDateMs(lane.lastEventAt) ?? now,
    initialHead: snapshot.head,
    lastProbeAt: 0,
    lastEditSignature: null,
    lastEditAt: snapshot.latestFileMtimeMs ?? now,
    lastTranscriptActivityAt: null,
    verifiedAt: null,
    signalSentAt: null,
    forceStartedAt: null,
  };
  states.set(input.surfaceId, state);
  state.lastProbeAt = now;

  const previousSignature = state.lastEditSignature;
  if (snapshot.signature !== previousSignature) {
    state.lastEditSignature = snapshot.signature;
    state.lastEditAt = snapshot.latestFileMtimeMs ?? now;
    state.forceStartedAt = null;
    if (state.verifiedAt && snapshot.latestFileMtimeMs && snapshot.latestFileMtimeMs > state.verifiedAt + 1000) {
      state.verifiedAt = null;
    }
  }

  // #1589: transcript activity is worker liveness. The guard is reached from a
  // supervisor transcript-progress callback, but its deadline previously used
  // only file mtimes. A worker could spend five minutes researching, testing, or
  // reviewing without touching a file and get interrupted while its owned run
  // log was still streaming. Read the same runs/*.jsonl pulse used by the zombie
  // reaper and extend the deadline from the newest real activity.
  let transcriptActivityAt: number | null = null;
  try {
    transcriptActivityAt = await ownedTranscriptMtimeMs(input.surfaceId);
  } catch {
    transcriptActivityAt = null;
  }
  if (transcriptActivityAt !== null) {
    state.lastTranscriptActivityAt = Math.max(
      state.lastTranscriptActivityAt ?? 0,
      transcriptActivityAt,
    );
  }
  const transcriptActivityAgeMs = state.lastTranscriptActivityAt === null
    ? null
    : Math.max(0, now - state.lastTranscriptActivityAt);
  const hasFreshTranscriptActivity = transcriptActivityAgeMs !== null
    && transcriptActivityAgeMs <= SELF_REVIEW_ACTIVITY_WINDOW_MS;
  if (hasFreshTranscriptActivity) {
    state.forceStartedAt = null;
  }

  const verification = detectVerificationEvidence(input.transcript);
  if (verification.typecheckPassed && verification.lintPassed && !state.verifiedAt) {
    state.verifiedAt = now;
  }

  const runningMs = now - state.firstObservedAt;
  if (
    !state.signalSentAt
    && runningMs >= STALL_SIGNAL_MS
    && !hasFreshTranscriptActivity
    && snapshot.head === state.initialHead
    // Tuning (2026-07-03): only ALARM when there is genuinely no reviewable
    // output. If committed work already exists ahead of base, the worker is
    // done-and-over-reviewing, not stuck-with-nothing — that case falls through
    // to the force-review salvage below (surface the work as `reviewing`)
    // instead of raising a scary `self_review_stall_detected`. Observed live:
    // a worker that committed once then spent 10+ min in a thorough self-review
    // (whose transcript didn't match the `selfReviewLikely` regex) tripped this
    // alarm while its work was perfectly reviewable.
    && !snapshot.hasDiffAgainstBase
  ) {
    state.signalSentAt = now;
    return {
      kind: 'signal-stall',
      reason: 'Codex has not committed after 10 minutes and its transcript activity is stale.',
      runningMs,
      head: snapshot.head,
    };
  }

  if (state.forceStartedAt) {
    return { kind: 'none' };
  }

  if (hasFreshTranscriptActivity) {
    return { kind: 'none' };
  }

  const latestActivityAt = Math.max(
    state.lastEditAt,
    state.lastTranscriptActivityAt ?? 0,
  );
  const selfReviewIdleMs = now - latestActivityAt;
  const idleMs = now - Math.max(latestActivityAt, state.verifiedAt ?? 0);
  if (
    state.verifiedAt
    && selfReviewIdleMs >= SELF_REVIEW_HARD_DEADLINE_MS
    && idleMs >= AUTO_COMMIT_AFTER_VERIFIED_IDLE_MS
  ) {
    state.forceStartedAt = now;
    return {
      kind: 'force-review',
      reason: 'Transcript shows typecheck and lint passed, and worktree/transcript activity is past the hard deadline.',
      idleMs,
      verification,
      cwd: snapshot.cwd,
    };
  }

  if (
    // Salvage on EITHER a self-review-shaped transcript OR the presence of
    // committed work ahead of base (2026-07-03 tuning): the regex was too
    // narrow, so a worker that finished, committed, and quietly over-reviewed
    // fell through to the 10-min alarm above. Committed work + a clean,
    // idle worktree past the deadline means "done" — surface it as `reviewing`.
    (verification.selfReviewLikely || (snapshot.hasDiffAgainstBase && !snapshot.dirty))
    && selfReviewIdleMs >= SELF_REVIEW_HARD_DEADLINE_MS
  ) {
    state.forceStartedAt = now;
    return {
      kind: 'force-review',
      reason: 'Codex appears stuck in self-review after the last worktree/transcript activity hard deadline.',
      idleMs: selfReviewIdleMs,
      verification,
      cwd: snapshot.cwd,
    };
  }

  return { kind: 'none' };
}

/**
 * Preserve commit-worthy work before the ws-server transitions a genuinely idle
 * self-review stall. The out-of-band capture is the last-resort recovery ref;
 * the normal path still uses the existing completion auto-commit seam so the
 * lane's branch itself becomes reviewable.
 */
export async function preserveSelfReviewStallWork(
  lane: Pick<Lane, 'id' | 'label' | 'repoPath' | 'worktreePath' | 'baseBranch'> & Partial<Pick<Lane, 'branch'>>,
  cwd: string,
): Promise<SelfReviewStallWorkPreservation> {
  const [{ captureWorktreeState }, completion] = await Promise.all([
    import('@/lib/lane/worktree-capture'),
    import('@/lib/supervisor/completion-verification'),
  ]);
  const capture = await captureWorktreeState(cwd, lane.id, lane.repoPath);

  let committed = false;
  try {
    committed = await completion.autoCommitCompletionWorktree(cwd, lane.repoPath, lane.label, lane.branch);
  } catch (error) {
    return {
      committed: false,
      hasReviewableDiff: await completion.hasReviewableCompletionDiff(cwd, lane.baseBranch, lane.repoPath),
      captureRef: capture.ref,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    committed,
    hasReviewableDiff: await completion.hasReviewableCompletionDiff(cwd, lane.baseBranch, lane.repoPath),
    captureRef: capture.ref,
  };
}

function detectVerificationEvidence(entries: TranscriptEntryLike[]): VerificationEvidence {
  const nonUserText = entries
    .filter((entry) => entry.role !== 'user')
    .map((entry) => `${entry.toolName ?? ''}\n${entry.text ?? ''}`)
    .join('\n');
  const normalized = nonUserText.toLowerCase();

  return {
    typecheckPassed: commandSucceeded(normalized, [
      'npm run typecheck',
      'npx tsc --noemit',
      'tsc --noemit',
    ]),
    lintPassed: commandSucceeded(normalized, [
      'npm run lint',
      'npx eslint',
      'eslint ',
      'targeted lint',
    ]),
    selfReviewLikely: /\bself[- ]review\b|\bgit diff main\.\.\.head\b|\breviewing (my|the) diff\b/.test(normalized),
  };
}

function commandSucceeded(text: string, commandNeedles: string[]): boolean {
  for (const needle of commandNeedles) {
    const index = text.indexOf(needle.toLowerCase());
    if (index === -1) continue;
    const window = text.slice(index, index + 6000);
    if (/(process exited with code 0|exit code 0|exited with code 0|completed successfully|no errors|0 errors|passed)/.test(window)) {
      return true;
    }
  }
  return false;
}

async function readWorktreeSnapshot(cwd: string, repoPath: string, baseBranch?: string | null): Promise<WorktreeSnapshot> {
  const [head, porcelain, hasDiffAgainstBase] = await Promise.all([
    readGitStdout(cwd, repoPath, ['rev-parse', 'HEAD']).catch((error) => { if (error instanceof LaneGitMetadataError) throw error; return null; }),
    readGitStdout(cwd, repoPath, ['status', '--porcelain=v1']).catch((error) => { if (error instanceof LaneGitMetadataError) throw error; return ''; }),
    hasDiff(cwd, repoPath, baseBranch?.trim() || 'main'),
  ]);
  const changedPaths = parsePorcelainPaths(porcelain);
  const fileStats = await Promise.all(
    changedPaths.map(async (filePath) => {
      try {
        const fileStat = await stat(path.join(cwd, filePath));
        return `${filePath}:${Math.trunc(fileStat.mtimeMs)}:${fileStat.size}`;
      } catch {
        return `${filePath}:missing`;
      }
    }),
  );
  const latestFileMtimeMs = fileStats.length > 0
    ? await latestChangedPathMtime(cwd, changedPaths)
    : null;

  return {
    cwd,
    head: head?.trim() || null,
    dirty: porcelain.trim().length > 0,
    hasDiffAgainstBase,
    changedPaths,
    signature: [head?.trim() ?? '', porcelain, ...fileStats].join('\n'),
    latestFileMtimeMs,
  };
}

async function hasDiff(cwd: string, repoPath: string, baseRef: string): Promise<boolean> {
  try {
    await laneGit(cwd, repoPath, ['diff', '--quiet', `${baseRef}...HEAD`], { maxBuffer: COMMAND_MAX_BUFFER });
    return false;
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    const status = (error as { status?: number | null; code?: number }).status ?? (error as { code?: number }).code;
    if (status === 1) return true;
  }

  try {
    await laneGit(cwd, repoPath, ['diff', '--quiet', 'HEAD~1..HEAD'], { maxBuffer: COMMAND_MAX_BUFFER });
    return false;
  } catch (error) {
    if (error instanceof LaneGitMetadataError) throw error;
    const status = (error as { status?: number | null; code?: number }).status ?? (error as { code?: number }).code;
    return status === 1;
  }
}

async function readGitStdout(cwd: string, repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await laneGit(cwd, repoPath, args, { maxBuffer: COMMAND_MAX_BUFFER });
  return stdout;
}

function parsePorcelainPaths(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const rawPath = trimmed.slice(3).trim();
    const renamedPath = rawPath.includes(' -> ')
      ? rawPath.split(' -> ').at(-1)?.trim()
      : rawPath;
    const unquoted = renamedPath?.replace(/^"|"$/g, '');
    if (unquoted) {
      paths.add(unquoted);
    }
  }
  return [...paths];
}

async function latestChangedPathMtime(cwd: string, paths: string[]): Promise<number | null> {
  let latest: number | null = null;
  for (const filePath of paths) {
    try {
      const fileStat = await stat(path.join(cwd, filePath));
      latest = latest === null ? fileStat.mtimeMs : Math.max(latest, fileStat.mtimeMs);
    } catch {
      continue;
    }
  }
  return latest;
}

function parseDateMs(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
