import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { execFile } from '@/lib/providers/child-process';
import { SandboxUnavailableError } from './sandbox-error';

const execFileAsync = promisify(execFile);

/**
 * The Git metadata a lane worker shares with the operator's checkout and every
 * other lane. The worker may write its lane's branch, its own worktree state
 * and new objects there, and nothing else: not the base branch, other refs,
 * config, hooks, info, packed refs, or another checkout's state.
 */
export interface GitMetadataGuard {
  /** The repository's common Git directory: refs, objects, config and hooks. */
  commonDir: string;
  /** This checkout's own Git directory; the common one for a main checkout. */
  gitDir: string;
  /** A linked worktree's `.git` pointer file. */
  pointerFile?: string;
  /** The lane's branch as `refs/heads/...`, from the lane record, never the checkout's HEAD. */
  branchRef: string;
}

const LANE_BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]+(?<![./])$/;

async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    throw new SandboxUnavailableError(`Cannot resolve Git metadata path '${p}'.`);
  }
}

/** Resolve the guard for a lane worker's checkout. Fails closed: no guard, no launch. */
export async function resolveGitMetadataGuard(cwd: string, branch: string): Promise<GitMetadataGuard> {
  if (!LANE_BRANCH_NAME.test(branch)) {
    throw new SandboxUnavailableError(`Lane branch '${branch}' is not a plain branch name.`);
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
      { windowsHide: true, cwd, encoding: 'utf8', timeout: 5_000 },
    ));
  } catch {
    throw new SandboxUnavailableError(`Git metadata for ${cwd} could not be resolved.`);
  }
  const [gitDir, commonDir] = String(stdout).split(/\r?\n/).map((entry) => entry.trim());
  if (!gitDir || !commonDir) throw new SandboxUnavailableError(`Git metadata for ${cwd} could not be resolved.`);
  const pointer = path.join(cwd, '.git');
  const pointerFile = (await lstat(pointer).catch(() => null))?.isFile() ? pointer : undefined;
  return {
    commonDir: await canonical(commonDir),
    gitDir: await canonical(gitDir),
    ...(pointerFile ? { pointerFile } : {}),
    branchRef: `refs/heads/${branch}`,
  };
}

export function isLinkedCheckout(guard: GitMetadataGuard): boolean {
  return guard.gitDir !== guard.commonDir;
}

/** The lane branch's ref, its lock and its reflog. */
export function laneBranchFiles(guard: GitMetadataGuard): string[] {
  return [guard.branchRef, `${guard.branchRef}.lock`, path.join('logs', guard.branchRef)]
    .map((file) => path.join(guard.commonDir, file));
}

/**
 * Entries inside the writable parts of the guard that would redirect Git or
 * replace protected metadata: object alternates, a linked worktree's pointers
 * and config, and for a main checkout, the protected entries at the top of its
 * Git dir (whose contents the guard already denies).
 */
export function gitRedirectPaths(guard: GitMetadataGuard): string[] {
  return [
    path.join(guard.commonDir, 'objects', 'info', 'alternates'),
    path.join(guard.commonDir, 'objects', 'info', 'http-alternates'),
    ...(isLinkedCheckout(guard)
      ? ['commondir', 'gitdir', 'config.worktree', 'config.worktree.lock'].map((name) => path.join(guard.gitDir, name))
      : ['config', 'config.lock', 'config.worktree', 'config.worktree.lock', 'packed-refs', 'packed-refs.lock',
        'shallow', 'shallow.lock', 'commondir', 'hooks', 'info', 'refs', 'logs', 'objects', 'worktrees']
        .map((name) => path.join(guard.commonDir, name))),
    ...(guard.pointerFile ? [guard.pointerFile] : []),
  ];
}

/**
 * The same guard as bind mounts, for Linux. A mount can only cover a path that
 * exists, and Git moves a ref into place by renaming a lock beside it, so the
 * lane branch's own directory is writable rather than the ref alone: other
 * branches in that directory stay writable there. Object info is read-only so
 * no alternates file can be created. A main checkout keeps its Git dir
 * writable apart from config, hooks, info and packed refs.
 */
export function gitGuardBinds(guard: GitMetadataGuard): { readOnly: string[]; writable: string[]; readOnlyAfter: string[] } {
  const common = guard.commonDir;
  if (!isLinkedCheckout(guard)) {
    return {
      readOnly: ['config', 'hooks', 'info', 'packed-refs', 'shallow', path.join('objects', 'info')]
        .map((name) => path.join(common, name)),
      writable: [],
      readOnlyAfter: guard.pointerFile ? [guard.pointerFile] : [],
    };
  }
  return {
    readOnly: [common],
    writable: [
      path.join(common, 'objects'),
      guard.gitDir,
      path.dirname(path.join(common, guard.branchRef)),
      path.dirname(path.join(common, 'logs', guard.branchRef)),
    ],
    readOnlyAfter: [path.join(common, 'objects', 'info'), ...gitRedirectPaths(guard)],
  };
}
