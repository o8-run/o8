import { childEnvironment } from '@/lib/providers/spawn-environment';
import 'server-only';

/**
 * Clone a remote repository to the default local location so it can be
 * registered in the repo registry (#1339 — onboarding GitHub selections used
 * to POST { cloneUrl } into a handler with no clone case and silently no-op).
 *
 * Destination convention: `~/Developer/<repo-name>` — there is no prior
 * clone-to-disk convention in the registry (registered repos live wherever
 * the user already has them), so we adopt the macOS-standard source-code
 * directory. Created if missing.
 *
 * Clone strategy: `gh repo clone` for GitHub URLs (inherits the device-flow
 * auth for private repos), falling back to plain `git clone` when gh is
 * absent. Non-GitHub URLs and local paths go straight to `git clone`.
 * All spawns are execFile array-args — no shell interpolation.
 */

import { execFile } from '@/lib/providers/child-process';
import { access, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { remoteRepositoryIdentity } from './remote-identity';
import { assertNotKnowledgeSource } from '@/lib/cortex/knowledge/sources';

const execFileAsync = promisify(execFile);

const CLONE_TIMEOUT_MS = 180_000;
const MAX_URL_LENGTH = 2_048;

export class RepoCloneError extends Error {
  constructor(message: string, readonly statusCode: number = 400) {
    super(message);
    this.name = 'RepoCloneError';
  }
}

function isGitHubUrl(cloneUrl: string) {
  return /^(https:\/\/github\.com\/|git@github\.com:)/i.test(cloneUrl);
}

function deriveRepoName(cloneUrl: string, explicitName?: string | null) {
  const raw = explicitName?.trim()
    || cloneUrl.replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/i, '')
    || '';
  const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, '-');
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    throw new RepoCloneError('Could not derive a repository name from the clone URL.');
  }
  return sanitized;
}

async function pathExists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export function getDefaultCloneRoot() {
  return path.join(os.homedir(), 'Developer');
}

/**
 * Clone `cloneUrl` under the default clone root and return the local path,
 * ready to hand to the registry's add path. Throws RepoCloneError with an
 * operator-readable message on any failure (never a raw child_process dump).
 */
export async function cloneRepoToDefaultLocation(cloneUrl: string, explicitName?: string | null): Promise<{ localPath: string }> {
  const url = cloneUrl?.trim() ?? '';
  if (!url) throw new RepoCloneError('cloneUrl is required.');
  if (url.length > MAX_URL_LENGTH) throw new RepoCloneError('cloneUrl is too long.');
  // Fail-closed: a leading dash would be parsed as an option by git/gh.
  if (url.startsWith('-')) throw new RepoCloneError('Invalid cloneUrl.');

  const name = deriveRepoName(url, explicitName);
  const root = getDefaultCloneRoot();
  const dest = path.join(root, name);
  assertNotKnowledgeSource(dest);

  if (await pathExists(dest)) {
    // Reuse only the requested repository. Different owners can use the same
    // basename, so an existing Git checkout alone is not enough evidence.
    const gitDir = await stat(path.join(dest, '.git')).catch(() => null);
    if (gitDir) {
      const origin = await execFileAsync('git', ['-C', dest, 'remote', 'get-url', 'origin'], { windowsHide: true, timeout: 5_000 }).then(({ stdout }) => stdout.trim()).catch(() => '');
      if (origin && remoteRepositoryIdentity(origin) === remoteRepositoryIdentity(url)) return { localPath: dest };
      throw new RepoCloneError('The destination folder belongs to a different repository. Add its local folder or choose another repository.', 409);
    }
    throw new RepoCloneError(`Destination already exists and is not a git repository: ${dest}`, 409);
  }

  assertNotKnowledgeSource(dest);
  await mkdir(root, { recursive: true });

  const execOpts = { windowsHide: true, timeout: CLONE_TIMEOUT_MS, env: childEnvironment({ env: { GH_NO_UPDATE_NOTIFIER: '1', GIT_TERMINAL_PROMPT: '0' } }) };
  assertNotKnowledgeSource(dest);

  if (isGitHubUrl(url)) {
    try {
      await execFileAsync('gh', ['repo', 'clone', url, dest], execOpts);
      return { localPath: dest };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
        throw new RepoCloneError(`Clone failed: ${stderr.split('\n').pop() || 'gh repo clone error'}`, 502);
      }
      // gh missing — fall through to plain git (works for public repos).
    }
  }

  assertNotKnowledgeSource(dest);
  try {
    await execFileAsync('git', ['clone', '--', url, dest], execOpts);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    throw new RepoCloneError(`Clone failed: ${stderr.split('\n').pop() || 'git clone error'}`, 502);
  }

  return { localPath: dest };
}
