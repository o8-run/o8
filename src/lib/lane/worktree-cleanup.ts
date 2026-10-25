import { laneGit, LaneGitMetadataError } from '@/lib/lane/lane-git';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getWorktreeManager } from '@/lib/worktree/launch';
import { preserveAndRecordLaneRecovery } from './merge-recovery';
import { checkPruneGate } from './prune-gate';
import type { Lane } from './types';
import { releaseTerminalPacketStorageReservations } from '@/lib/orchestrator/terminal-storage-release';
import { worktreeIsConfirmedAbsent } from './lane-storage-release';

type CleanupLane = Pick<Lane, 'id' | 'repoPath' | 'worktreePath'>
  & Partial<Pick<Lane, 'baseBranch' | 'packetId'>>
  & { storageAdmissionOwnerGeneration?: number };

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function settleRemovedWorktreeReservation(lane: CleanupLane, removed: boolean): boolean {
  if (removed) {
    releaseTerminalPacketStorageReservations({
      packetId: lane.packetId,
      laneId: lane.id,
      ownerGeneration: lane.storageAdmissionOwnerGeneration,
    });
  }
  return removed;
}

/**
 * #2474 — a packet directory whose `.git` entry is gone (or points nowhere) has
 * no head to bank. Without this check git either answers "not a git
 * repository" on every preserve attempt, or walks up and answers for the
 * parent checkout instead.
 */
export async function worktreeIsNotGitRepository(worktreePath: string, repoPath: string): Promise<boolean> {
  if (!existsSync(join(worktreePath, '.git'))) return true;
  try {
    await laneGit(worktreePath, repoPath, ['rev-parse', '--git-dir'], {
      timeout: 5_000,
    });
    return false;
  } catch (error) {
    // Invalid metadata is unrecoverable by Git. Retain the directory and let
    // the terminal sweep stop retrying it until an operator repairs it.
    if (error instanceof LaneGitMetadataError) return true;
    const stderr = (error as { stderr?: unknown }).stderr;
    return /not a git repository/i.test(typeof stderr === 'string' ? stderr : formatError(error));
  }
}

/**
 * Bank the worktree HEAD as a salvage branch ref before any destructive step,
 * so a terminal/forced removal never drops a recoverable branch. Fail closed
 * when preservation cannot be confirmed.
 */
async function preserveHeadBeforeRemoval(lane: CleanupLane, worktreePath: string): Promise<boolean> {
  try {
    await preserveAndRecordLaneRecovery({
      id: lane.id,
      repoPath: lane.repoPath,
      worktreePath,
      baseBranch: lane.baseBranch ?? 'main',
    }, 'terminal_worktree_cleanup');
    return true;
  } catch (error) {
    console.warn(`[lane-worktree] Failed to preserve head for ${lane.id} before removal (${formatError(error)}).`);
    return false;
  }
}

export async function cleanupLaneWorktree(
  lane: CleanupLane,
  opts: { deleteBranch?: boolean; terminal?: boolean; force?: boolean; overrideLiveGuard?: true; beforeSourceRemoval?: (phase?: 'before-dependency-detach' | 'dependency-detached') => Promise<void> } = {},
): Promise<boolean> {
  const worktreePath = lane.worktreePath?.trim();
  if (!worktreePath) {
    return false;
  }

  // Safety guard: never touch the main working tree. A lane whose
  // worktreePath equals its repoPath is an un-isolated session running in
  // the main checkout — `git worktree remove` would fail and, worse,
  // `preserveUncommittedWork` would drop a rogue "chore: preserve agent
  // work" commit onto whatever branch main is currently on. Bail cleanly.
  const repoPath = lane.repoPath.replace(/\/+$/, '');
  const normalizedWorktree = worktreePath.replace(/\/+$/, '');
  if (normalizedWorktree === repoPath) {
    console.warn(`[lane-worktree] Skipping cleanup for ${lane.id}: worktree path equals repo path (no isolation).`);
    return false;
  }

  // Exact merge retirement may have removed this path before its terminal
  // callback runs. Absence is settled cleanup, not another capture attempt.
  if (worktreeIsConfirmedAbsent(worktreePath)) {
    return settleRemovedWorktreeReservation(lane, true);
  }

  const terminal = opts.terminal === true;
  const force = opts.force === true;

  // Single prune gate (Rock 1 item 3): a terminal owning lane passes cleanly; a
  // non-terminal lane with uncommitted work / recent activity is refused unless
  // the caller explicitly forces (reset/recovery), which records `prune_forced`.
  const gate = await checkPruneGate({
    repoRoot: lane.repoPath,
    worktreePath,
    laneId: lane.id,
    logPrefix: 'lane-worktree',
    operatorForce: force,
  });
  if (!gate.ok) {
    console.warn(`[lane-worktree] Skipping cleanup for ${lane.id}: prune gate refused (${gate.reason}).`);
    return false;
  }

  // The gate is read-only. Once it allows cleanup, bank the head branch ref
  // before any destructive step. manager.cleanup also preserves uncommitted
  // work internally; this covers the commit history. Fail closed if the ref
  // cannot be confirmed.
  if (terminal || force) {
    if (await worktreeIsNotGitRepository(worktreePath, lane.repoPath)) {
      console.warn(`[lane-worktree] Retaining non-git directory ${worktreePath}: preservation authority is unavailable.`);
      return false;
    }
    if (!(await preserveHeadBeforeRemoval(lane, worktreePath))) return false;
  }

  try {
    const manager = getWorktreeManager(lane.repoPath);
    const worktree = await manager.getDependencyMaterializationByPath(worktreePath);
    if (worktree) {
      // manager.cleanup already calls preserveUncommittedWork internally
      const removed = await manager.cleanup(worktree.id, {
        force: true,
        deleteBranch: opts.deleteBranch ?? true,
        overrideLiveGuard: opts.overrideLiveGuard,
        beforeSourceRemoval: opts.beforeSourceRemoval,
      });
      return settleRemovedWorktreeReservation(lane, removed);
    }
  } catch (error) {
    console.warn(`[lane-worktree] Manager cleanup failed for ${lane.id}: ${formatError(error)}`);
  }

  // A missing manager or a refused/failed cleanup never grants raw deletion.
  return false;
}

export async function pruneRepoWorktrees(repoPath: string): Promise<string[]> {
  return getWorktreeManager(repoPath).prune();
}
