import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from '@/lib/providers/child-process';
import { resolveGitBinary } from '@/lib/git/binary';
import { validateRepoRelativePath } from '@/lib/worktree/diff-transport';

const execute = promisify(execFile);
export class SourceControlError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export interface SourceControlStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: Array<{ path: string; originalPath?: string; index: string; worktree: string; staged: boolean; unstaged: boolean; untracked: boolean }>;
}

/** Parses porcelain v2 with NUL delimiters, including rename source records. */
export function parsePorcelainStatus(output: string): SourceControlStatus {
  const result: SourceControlStatus = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (row.startsWith('# branch.head ')) {
      const branch = row.slice(14);
      result.branch = branch === '(detached)' ? null : branch;
    } else if (row.startsWith('# branch.upstream ')) {
      result.upstream = row.slice(18);
    } else if (row.startsWith('# branch.ab ')) {
      const counts = /^# branch.ab \+(\d+) -(\d+)$/.exec(row);
      if (counts) { result.ahead = Number(counts[1]); result.behind = Number(counts[2]); }
    } else if (row.startsWith('? ')) {
      result.files.push({ path: row.slice(2), index: '?', worktree: '?', staged: false, unstaged: false, untracked: true });
    } else if (/^[12u] /.test(row)) {
      const fields = row[0] === '1' ? 8 : row[0] === '2' ? 9 : 10;
      const parts = row.split(' ');
      const xy = parts[1];
      result.files.push({
        path: parts.slice(fields).join(' '),
        ...(row[0] === '2' ? { originalPath: records[++i] } : {}),
        index: xy[0], worktree: xy[1], staged: xy[0] !== '.', unstaged: xy[1] !== '.', untracked: false,
      });
    }
  }
  return result;
}

export function validateSourceControlPaths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000) {
    throw new SourceControlError('invalid_paths', 'Provide 1 to 1000 repository-relative paths, or all: true.');
  }
  return value.map(item => {
    try {
      if (typeof item !== 'string' || item.startsWith('-')) throw new Error();
      return validateRepoRelativePath(item);
    } catch { throw new SourceControlError('invalid_paths', 'Paths must be repository-relative without traversal or leading options.'); }
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute(resolveGitBinary(), ['--literal-pathspecs', ...args], {
    cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

/**
 * A phone names its thread by id, and a worker session by its session key: exactly
 * one of the two. The checkout always comes from what the desktop has stored for it.
 */
export async function resolveSourceControlCheckout(identity: { sessionKey?: unknown; threadId?: unknown }): Promise<string> {
  const sessionKey = typeof identity.sessionKey === 'string' ? identity.sessionKey.trim() : '';
  const threadId = typeof identity.threadId === 'string' ? identity.threadId.trim() : '';
  if (Boolean(sessionKey) === Boolean(threadId)) {
    throw new SourceControlError('invalid_session', 'Provide exactly one of threadId or sessionKey.');
  }
  if (threadId && !/^[a-zA-Z0-9_-]+$/.test(threadId)) {
    throw new SourceControlError('invalid_session', 'threadId is not valid.');
  }
  try {
    let cwd: string | null | undefined;
    if (threadId) {
      const { readProjectedThread } = await import('@/lib/mobile/orchestrator-thread-history');
      cwd = readProjectedThread(threadId)?.repoPath;
    } else {
      const { findLaneBySession } = await import('@/lib/lane/registry');
      const lane = findLaneBySession(sessionKey);
      cwd = lane?.worktreePath ?? lane?.repoPath;
    }
    if (cwd && (await stat(cwd)).isDirectory()) {
      await git(cwd, ['rev-parse', '--show-toplevel']);
      return cwd;
    }
  } catch { /* Missing thread, lane or checkout is never replaced with another repository. */ }
  throw new SourceControlError('checkout_not_found', 'The thread checkout could not be resolved.', 404);
}

export async function readSourceControlStatus(cwd: string): Promise<SourceControlStatus> {
  return parsePorcelainStatus(await git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']));
}

export function assertPushBranch(branch: string | null, defaultBranch: string): asserts branch is string {
  if (!branch || ['main', 'master', defaultBranch].includes(branch)) {
    throw new SourceControlError('protected_branch', 'Cannot push a detached HEAD, the repository default branch, main, or master.', 409);
  }
}

export type SourceControlAction = 'stage' | 'unstage' | 'commit' | 'pull' | 'push';

export async function mutateSourceControl(cwd: string, action: SourceControlAction, body: Record<string, unknown>) {
  if (action === 'stage' || action === 'unstage') {
    if (body.all !== undefined && typeof body.all !== 'boolean') throw new SourceControlError('invalid_paths', 'all must be a boolean.');
    if (body.all === true && body.paths !== undefined) throw new SourceControlError('invalid_paths', 'Provide paths or all, not both.');
    const paths = body.all === true ? ['.'] : validateSourceControlPaths(body.paths);
    if (action === 'stage') await git(cwd, ['add', '--all', '--', ...paths]);
    else {
      const status = await readSourceControlStatus(cwd);
      // reset does not support an unborn HEAD; remove only its index entries instead.
      const unborn = (await git(cwd, ['status', '--porcelain=v2', '--branch', '-z'])).includes('# branch.oid (initial)\0');
      if (unborn && status.files.some(file => file.staged)) await git(cwd, ['rm', '--cached', '-r', '-f', '--', ...paths]);
      else if (status.files.some(file => file.staged)) await git(cwd, ['reset', 'HEAD', '--', ...paths]);
    }
  } else if (action === 'commit') {
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 4096 || message.includes('\0')) throw new SourceControlError('invalid_message', 'A trimmed commit message of 1 to 4096 characters is required.');
    if (!(await readSourceControlStatus(cwd)).files.some(file => file.staged)) throw new SourceControlError('nothing_staged', 'Stage changes before committing.', 409);
    await git(cwd, ['commit', '-m', message]);
  } else if (action === 'pull') {
    try { await git(cwd, ['-c', 'merge.autoStash=false', 'pull', '--ff-only', '--no-rebase', '--no-autostash']); }
    catch { throw new SourceControlError('pull_failed', 'Fast-forward pull failed. The branch may have diverged, lack an upstream, or the remote may be unavailable; no merge was created.', 409); }
  } else {
    const status = await readSourceControlStatus(cwd);
    assertPushBranch(status.branch, 'main');
    const remote = status.upstream ? (await git(cwd, ['config', '--get', `branch.${status.branch}.remote`])).trim() : 'origin';
    if (!remote || remote.startsWith('-') || remote === '.' || /[\s:/\\@]/.test(remote)) throw new SourceControlError('invalid_remote', 'A named remote is required.', 409);
    // Query the remote HEAD so a stale or absent local origin/HEAD cannot bypass protection.
    let remoteHead: string;
    try { remoteHead = await git(cwd, ['ls-remote', '--symref', remote, 'HEAD']); }
    catch { throw new SourceControlError('default_branch_unknown', 'Cannot verify the repository default branch; push refused.', 409); }
    const defaultBranch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(remoteHead)?.[1];
    if (!defaultBranch) throw new SourceControlError('default_branch_unknown', 'Cannot verify the repository default branch; push refused.', 409);
    assertPushBranch(status.branch, defaultBranch);
    await git(cwd, ['push', '--no-follow-tags', '--recurse-submodules=no', ...(!status.upstream ? ['--set-upstream'] : []), remote, `refs/heads/${status.branch}:refs/heads/${status.branch}`]);
  }
  return { ok: true as const, status: await readSourceControlStatus(cwd) };
}

/** Git stderr can contain credential-bearing URLs; only controlled errors leave this boundary. */
export async function sourceControlResponse(request: Request, action: SourceControlAction | 'status'): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store, max-age=0' };
  try {
    let body: Record<string, unknown> = {};
    if (action !== 'status') {
      const parsed: unknown = await request.json().catch(() => null);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SourceControlError('invalid_request', 'A JSON object is required.');
      body = parsed as Record<string, unknown>;
    }
    const query = new URL(request.url).searchParams;
    const identity = action === 'status'
      ? { sessionKey: query.get('sessionKey'), threadId: query.get('threadId') }
      : { sessionKey: body.sessionKey, threadId: body.threadId };
    const cwd = await resolveSourceControlCheckout(identity);
    const result = action === 'status' ? { ok: true, status: await readSourceControlStatus(cwd) } : await mutateSourceControl(cwd, action, body);
    return Response.json(result, { headers });
  } catch (error) {
    return Response.json({ ok: false, code: error instanceof SourceControlError ? error.code : 'git_failed', error: error instanceof SourceControlError ? error.message : 'Git operation failed. Check repository state and remote access, then retry.' }, { status: error instanceof SourceControlError ? error.status : 409, headers });
  }
}
