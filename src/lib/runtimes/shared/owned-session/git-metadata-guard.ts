import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { execFile } from '@/lib/providers/child-process';
import { SandboxUnavailableError } from './sandbox-error';

const execFileAsync = promisify(execFile);

/**
 * The Git metadata a worker shares with the operator's checkout and every
 * other lane. The worker may write its own branch, its own worktree state and
 * new objects there, and nothing else: not the base branch, other refs,
 * config, hooks, info, packed refs, or another checkout's state.
 */
export interface GitMetadataGuard {
  /** The repository's common Git directory: refs, objects, config and hooks. */
  commonDir: string;
  /** This checkout's own Git directory; the common one for a main checkout. */
  gitDir: string;
  /** The checkout's top-level directory. */
  checkoutRoot: string;
  /** A linked worktree's `.git` pointer file. */
  pointerFile?: string;
  /** The worker's branch as `refs/heads/...`, from o8's records, never the checkout's HEAD. None: no branch is writable. */
  branchRef?: string;
}

/**
 * Where the worker's branch comes from: its lane record, or the branch its
 * session was created on, which o8 recorded before the worker first ran.
 */
export interface WorkerGitBranch {
  lane?: string;
  session?: string;
}

const LANE_BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]+(?<![./])$/;

async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    throw new SandboxUnavailableError(`Cannot resolve Git metadata path '${p}'.`);
  }
}

/**
 * Resolve the guard for a worker's checkout. A worker in a linked worktree is
 * always guarded, to its lane's branch, else its session's, else no branch. A
 * worker in the repository's main checkout is guarded only when it belongs to
 * a lane. Fails closed: a lane whose metadata cannot be resolved does not launch.
 */
export async function resolveGitMetadataGuard(cwd: string, branches: WorkerGitBranch): Promise<GitMetadataGuard | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
      { windowsHide: true, cwd, encoding: 'utf8', timeout: 5_000 },
    ));
  } catch {
    if (!branches.lane) return undefined;
    throw new SandboxUnavailableError(`Git metadata for ${cwd} could not be resolved.`);
  }
  const [gitDir, commonDir, checkoutRoot] = String(stdout).split(/\r?\n/).map((entry) => entry.trim());
  if (!gitDir || !commonDir || !checkoutRoot) {
    if (!branches.lane) return undefined;
    throw new SandboxUnavailableError(`Git metadata for ${cwd} could not be resolved.`);
  }
  const guard = {
    commonDir: await canonical(commonDir),
    gitDir: await canonical(gitDir),
    checkoutRoot: await canonical(checkoutRoot),
  };
  const linked = guard.gitDir !== guard.commonDir;
  if (!linked && !branches.lane) return undefined;
  const branch = branches.lane || (linked ? branches.session : undefined) || undefined;
  if (branch && !LANE_BRANCH_NAME.test(branch)) {
    throw new SandboxUnavailableError(`Worker branch '${branch}' is not a plain branch name.`);
  }
  const pointer = path.join(guard.checkoutRoot, '.git');
  const pointerFile = linked && (await lstat(pointer).catch(() => null))?.isFile() ? pointer : undefined;
  return {
    ...guard,
    ...(pointerFile ? { pointerFile } : {}),
    ...(branch ? { branchRef: `refs/heads/${branch}` } : {}),
  };
}

export function isLinkedCheckout(guard: GitMetadataGuard): boolean {
  return guard.gitDir !== guard.commonDir;
}

/** The worker branch's ref, its lock and its reflog. */
export function laneBranchFiles(guard: GitMetadataGuard): string[] {
  if (!guard.branchRef) return [];
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

function ancestors(p: string): string[] {
  const found: string[] = [];
  for (let dir = path.dirname(p); dir !== path.dirname(dir); dir = path.dirname(dir)) found.push(dir);
  return found;
}

/**
 * Directories whose own entry must stay where it is, because a protected entry
 * lies inside them: moving one would carry the protected entry with it, or let
 * a prepared replacement take its place. Their contents keep their own rules.
 */
export function gitFixedDirectories(guard: GitMetadataGuard): string[] {
  return [...new Set([
    ...ancestors(guard.commonDir),
    guard.checkoutRoot,
    ...ancestors(guard.checkoutRoot),
    guard.gitDir,
    path.join(guard.commonDir, 'objects'),
    path.join(guard.commonDir, 'objects', 'info'),
  ])];
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
      readOnly: ['config', 'config.worktree', 'hooks', 'info', 'packed-refs', 'shallow', path.join('objects', 'info')]
        .map((name) => path.join(common, name)),
      writable: [],
      readOnlyAfter: [],
    };
  }
  return {
    readOnly: [common],
    writable: [
      path.join(common, 'objects'),
      guard.gitDir,
      ...(guard.branchRef ? [
        path.dirname(path.join(common, guard.branchRef)),
        path.dirname(path.join(common, 'logs', guard.branchRef)),
      ] : []),
    ],
    readOnlyAfter: [path.join(common, 'objects', 'info'), ...gitRedirectPaths(guard)],
  };
}

/**
 * Linux binds a whole ref directory writable. Refuse a branch whose directory
 * is `refs/heads` itself, which holds the base branch.
 */
export function assertBwrapGitGuard(guard: GitMetadataGuard): void {
  if (guard.branchRef && path.posix.dirname(guard.branchRef) === 'refs/heads') {
    throw new SandboxUnavailableError(
      `The Linux worker sandbox needs the worker branch in its own directory (for example inline/<name>), `
      + `not '${guard.branchRef.slice('refs/heads/'.length)}'. Refusing to run it with a weaker policy.`,
    );
  }
}

/**
 * Create the protected entries Linux must bind read-only but that do not exist
 * yet: empty Git directories and an empty worktree config and packed refs,
 * which Git reads as nothing. Existing entries are left as they are.
 */
export async function ensureGitGuardEntries(guard: GitMetadataGuard): Promise<void> {
  const common = guard.commonDir;
  const linked = isLinkedCheckout(guard);
  const dirs = [path.join(common, 'objects', 'info'), ...(linked ? [] : [path.join(common, 'hooks'), path.join(common, 'info')])];
  const files = linked
    ? [path.join(guard.gitDir, 'config.worktree')]
    : [path.join(common, 'config.worktree'), path.join(common, 'packed-refs')];
  try {
    for (const dir of dirs) await mkdir(dir, { recursive: true });
    for (const file of files) {
      await writeFile(file, '', { flag: 'wx', mode: 0o644 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
  } catch (error) {
    throw new SandboxUnavailableError(`Cannot prepare Git metadata for the worker sandbox: ${(error as Error).message}`);
  }
}
