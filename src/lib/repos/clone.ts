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
import { assertNotKnowledgeSource, normalizeKnowledgeWritePath } from '@/lib/cortex/knowledge/sources';

const execFileAsync = promisify(execFile);

const CLONE_TIMEOUT_MS = 180_000;
const MAX_URL_LENGTH = 2_048;

export class RepoCloneError extends Error {
  constructor(message: string, readonly statusCode: number = 400) {
    super(message);
    this.name = 'RepoCloneError';
  }
}

// `scheme://userinfo@` where userinfo runs to the LAST `@` before the next
// `/` or whitespace, so a password containing `@` cannot leak its tail.
const SCHEME_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi;

/**
 * Collect the credential-bearing userinfo from the caller's clone URL so we can
 * strip it from an error line by exact value, independent of how git/gh echo
 * it. Handles `https://user:token@host` (username can itself be a token) and
 * the scp-like ssh form `token@host:path`. Both raw and percent-decoded forms
 * are returned, since the shell/caller value and git's echoed value may differ.
 */
function cloneUrlCredentials(sourceUrl: string): string[] {
  const values = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    values.add(raw);
    try { values.add(decodeURIComponent(raw)); } catch { /* malformed escape */ }
  };
  try {
    const url = new URL(sourceUrl);
    add(url.username);
    add(url.password);
  } catch { /* scp-form / local path — handled below */ }
  const scp = /^([^/@\s]+)@[^/\s]+:/.exec(sourceUrl.trim());
  if (scp) for (const part of scp[1].split(':')) add(part);
  // Only strip values long enough to be a credential, so a one-character
  // username never mangles the whole diagnostic line.
  return [...values].filter((value) => value.length >= 3);
}

/**
 * A clone URL supplied by the caller may carry userinfo
 * (`https://user:token@host/path`), where the username itself can be a token
 * (`https://ghp_xxx@host`). Current git/gh redact that before printing stderr,
 * but older git versions and some transport error paths echo the URL verbatim,
 * and this stderr line is surfaced to the HTTP client (and may be logged or
 * captured downstream). Fail closed in two ways so a credential never escapes
 * in an error message: (1) structurally strip any `scheme://userinfo@`, with
 * userinfo split at the LAST `@` so a password containing `@` cannot leak its
 * tail; (2) remove the caller URL's exact username/password values, which also
 * covers scp-form ssh remotes the scheme rule does not match. Host and path
 * text are preserved so the message stays useful for diagnosis.
 */
function redactUrlUserinfo(line: string, sourceUrl: string): string {
  let out = line.replace(SCHEME_USERINFO_RE, '$1');
  for (const secret of cloneUrlCredentials(sourceUrl)) out = out.split(secret).join('[redacted]');
  return out;
}

function isGitHubUrl(cloneUrl: string) {
  return /^(https:\/\/github\.com\/|git@github\.com:)/i.test(cloneUrl);
}

function deriveRepoName(cloneUrl: string, explicitName?: string | null) {
  // Strip any `scheme://userinfo@` first: a path-less authenticated URL would
  // otherwise fold the credential into the derived name, which then appears in
  // the destination-collision error (and on disk). Host/path are unaffected.
  const withoutUserinfo = cloneUrl.replace(SCHEME_USERINFO_RE, '$1');
  const raw = explicitName?.trim()
    || withoutUserinfo.replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/i, '')
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
  return normalizeKnowledgeWritePath(path.join(os.homedir(), 'Developer'));
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
        throw new RepoCloneError(`Clone failed: ${redactUrlUserinfo(stderr.split('\n').pop() || 'gh repo clone error', url)}`, 502);
      }
      // gh missing — fall through to plain git (works for public repos).
    }
  }

  assertNotKnowledgeSource(dest);
  try {
    // Local clones must own their metadata inodes so subsequent guarded writes
    // do not inherit shared object files from the source repository.
    await execFileAsync('git', ['clone', '--no-hardlinks', '--', url, dest], execOpts);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    throw new RepoCloneError(`Clone failed: ${redactUrlUserinfo(stderr.split('\n').pop() || 'git clone error', url)}`, 502);
  }

  return { localPath: dest };
}
