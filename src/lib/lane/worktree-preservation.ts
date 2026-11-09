import { resolveGitBinary } from '@/lib/git/binary';
import { execFile } from '@/lib/providers/child-process';
import { laneGit } from '@/lib/lane/lane-git';
import path from 'node:path';
import { promisify } from 'node:util';
import { autoCommitCompletionWorktree } from '@/lib/supervisor/completion-verification';
import type { Lane } from './types';
import { captureWorktreeState } from './worktree-capture';

const execFileAsync = promisify(execFile);
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

export interface LaneWorktreePreservation {
  preserved: boolean;
  autoCommitted: boolean;
  alreadyPreserved: boolean;
  branchName?: string;
  refName?: string;
  headSha?: string;
  /** True when uncommitted work was snapshotted to an out-of-band capture ref
   *  (see captureWorktreeState) — recovery independent of the agent's commit. */
  captured?: boolean;
  captureRef?: string;
}

function branchSafeId(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'lane';
}

async function git(cwd: string, args: string[]) {
  return execFileAsync(resolveGitBinary(), args, {
    windowsHide: true,
    cwd,
    timeout: 30_000,
    maxBuffer: COMMAND_MAX_BUFFER,
  });
}

async function headHasUnmergedWork(worktreePath: string, repoPath: string, baseBranch: string): Promise<boolean> {
  try {
    await laneGit(worktreePath, repoPath, ['merge-base', '--is-ancestor', 'HEAD', baseBranch], { timeout: 30_000 });
    return false;
  } catch {
    return true;
  }
}

async function preserveHeadRef(
  repoPath: string,
  worktreePath: string,
  refName: string,
): Promise<void> {
  try {
    await git(repoPath, ['fetch', worktreePath, `+HEAD:${refName}`]);
    return;
  } catch {
    await laneGit(worktreePath, repoPath, ['update-ref', refName, 'HEAD'], { timeout: 30_000 });
  }
}

async function resolveRefSha(repoPath: string, refName: string): Promise<string | null> {
  try {
    const { stdout } = await git(repoPath, ['rev-parse', '--verify', refName]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function preserveLaneWorktreeHead(
  lane: Pick<Lane, 'id' | 'repoPath' | 'worktreePath' | 'baseBranch'> & Partial<Pick<Lane, 'branch'>>,
): Promise<LaneWorktreePreservation> {
  const worktreePath = lane.worktreePath?.trim();
  if (!worktreePath) {
    return { preserved: false, autoCommitted: false, alreadyPreserved: false };
  }

  // Capture the raw working state to an out-of-band ref BEFORE any commit logic
  // runs, so recovery never depends on the agent (or a blind amend) having
  // committed correctly — the worktree-amend false-landing trap.
  const capture = await captureWorktreeState(worktreePath, lane.id, lane.repoPath);

  const autoCommitted = await autoCommitCompletionWorktree(worktreePath, lane.repoPath, undefined, lane.branch);
  const baseBranch = lane.baseBranch?.trim() || 'main';
  const hasUnmergedWork = await headHasUnmergedWork(worktreePath, lane.repoPath, baseBranch);
  if (!autoCommitted && !hasUnmergedWork) {
    return {
      preserved: false,
      autoCommitted: false,
      alreadyPreserved: false,
      captured: capture.captured,
      captureRef: capture.ref,
    };
  }

  const id = branchSafeId(path.basename(worktreePath) || lane.id);
  const branchName = `preserved/${id}`;
  const refName = `refs/heads/${branchName}`;
  const { stdout } = await laneGit(worktreePath, lane.repoPath, ['rev-parse', 'HEAD'], { timeout: 30_000 });
  const headSha = stdout.trim() || undefined;
  const alreadyPreserved = Boolean(
    headSha && await resolveRefSha(lane.repoPath, refName) === headSha,
  );
  if (!alreadyPreserved) {
    await preserveHeadRef(lane.repoPath, worktreePath, refName);
  }

  return {
    preserved: true,
    autoCommitted,
    alreadyPreserved,
    branchName,
    refName,
    headSha,
    captured: capture.captured,
    captureRef: capture.ref,
  };
}
