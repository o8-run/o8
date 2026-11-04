import { resolveGitBinary } from '@/lib/git/binary';
import { execFileSync } from '@/lib/providers/child-process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isOrchestratorHomePath } from '@/lib/orchestrator/repo-path';
import { isThreadScratchPath } from '@/lib/orchestrator/thread-scratch';

function couldContainGitWorkTree(repoPath: string): boolean {
  // Explicit Git environment may locate metadata outside the cwd ancestry.
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return true;
  try {
    let directory = realpathSync(repoPath);
    for (;;) {
      if (existsSync(join(directory, '.git'))
        || (existsSync(join(directory, 'HEAD')) && existsSync(join(directory, 'objects')))) return true;
      const parent = dirname(directory);
      if (parent === directory) return false;
      directory = parent;
    }
  } catch {
    return true; // An uncertain filesystem probe still gets Git's verdict.
  }
}

export type RepoDispatchFailedCheck = 'repository_folder_exists' | 'git_work_tree';

export type RepoDispatchAdmission = {
  ok: true;
  repoPath: string;
} | {
  ok: false;
  repoPath: string;
  failedCheck: RepoDispatchFailedCheck;
  correctiveAction: string;
  message: string;
};

export class RepoDispatchAdmissionError extends Error {
  readonly admission: Extract<RepoDispatchAdmission, { ok: false }>;

  constructor(admission: Extract<RepoDispatchAdmission, { ok: false }>) {
    super(admission.message);
    this.name = 'RepoDispatchAdmissionError';
    this.admission = admission;
  }
}

/**
 * #1551 — repo-path preflight shared by BOTH orchestrator spawn paths.
 *
 * Node's spawn throws ENOENT when the WORKING DIRECTORY is missing, but its
 * message names the BINARY — "spawn …/claude ENOENT" — which sent a whole
 * debugging round chasing a healthy install while the real fault was a repo
 * folder the operator had moved or deleted (Sydney, FKAR3B/6JWBVV 2026-07-17).
 * And a plain non-git folder let the CLI boot and fail into a confusing
 * tool-side error mid-turn. Fail with the truth, before any spawn work.
 */
export function isGitWorkTreeSync(repoPath: string): boolean {
  // #2048 — probe the path BEFORE spawning git. A packet whose repo folder was
  // moved or deleted made the headless recovery tick re-run this every tick, and
  // execFileSync inherits the parent's stderr by default, so each miss printed a
  // bare `fatal: not a git repository` into serve.log with nothing naming the
  // caller. The existence check answers the missing-folder case without a spawn;
  // the explicit `stdio` keeps git's stderr piped (and discarded) for the
  // folder-exists-but-isn't-a-repo case, which the catch below already handles.
  if (!repoPath || !existsSync(repoPath)) return false;
  // Queued non-repository folders are checked on every recovery tick. A fresh
  // metadata check avoids spawning Git for them and detects a later git init.
  if (!couldContainGitWorkTree(repoPath)) return false;
  try {
    return execFileSync(resolveGitBinary(), ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() === 'true';
  } catch {
    return false;
  }
}

export function getRepoDispatchAdmission(repoPath: string): RepoDispatchAdmission {
  const normalized = repoPath.trim();
  if (!normalized || !existsSync(normalized)) {
    const correctiveAction = 'Re-add the repo at its current location, or remove the stale registry entry.';
    return {
      ok: false,
      repoPath: normalized,
      failedCheck: 'repository_folder_exists',
      correctiveAction,
      message: normalized
        ? `Repository folder not found at ${normalized}. ${correctiveAction}`
        : `Repository path is missing. ${correctiveAction}`,
    };
  }
  if (isOrchestratorHomePath(normalized) || isThreadScratchPath(normalized)) return { ok: true, repoPath: normalized };
  if (!isGitWorkTreeSync(normalized)) {
    const correctiveAction = `Run "git init" in ${normalized}, create an initial commit, or select an existing Git repository.`;
    return {
      ok: false,
      repoPath: normalized,
      failedCheck: 'git_work_tree',
      correctiveAction,
      message: `${normalized} isn't a Git repository. ${correctiveAction}`,
    };
  }
  return { ok: true, repoPath: normalized };
}

export function assertRepoDispatchAdmission(repoPath: string): void {
  const admission = getRepoDispatchAdmission(repoPath);
  if (!admission.ok) throw new RepoDispatchAdmissionError(admission);
}

/** Throws a human-actionable error when `repoPath` is missing or not a Git
 *  work tree. A null/empty repoPath passes — some sessions run unbound. */
export function assertOrchestratorRepoPath(repoPath: string | null | undefined): void {
  if (!repoPath) return;
  if (isOrchestratorHomePath(repoPath)) return;
  assertRepoDispatchAdmission(repoPath);
}
