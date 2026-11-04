import 'server-only';

import { execFile } from '@/lib/providers/child-process';
import { childEnvironment } from '@/lib/providers/spawn-environment';
import { access, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { assertNotKnowledgeSource } from '@/lib/cortex/knowledge/sources';
import { getDefaultCloneRoot } from './clone';

/**
 * Create a GitHub repository with this machine's signed-in GitHub CLI and
 * clone it into the default projects folder, beside repositories that
 * `cloneRepoToDefaultLocation` adds. The caller registers the returned path.
 * gh owns authentication; nothing here reads or passes credentials.
 */
const execFileAsync = promisify(execFile);
const CREATE_TIMEOUT_MS = 180_000;
const VISIBILITIES = new Set(['public', 'private', 'internal']);

export class RepoCreateError extends Error {
  constructor(message: string, readonly statusCode: number = 400) {
    super(message);
    this.name = 'RepoCreateError';
  }
}

export async function createGitHubRepo(rawName: unknown, visibility: unknown): Promise<{ localPath: string }> {
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  // GitHub names: letters, digits, '.', '-' and '_'. A leading dash would be read as an option.
  // gh strips a .git suffix, which would clone into a different folder.
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/.test(name) || name === '.' || name === '..' || /\.git$/i.test(name)) {
    throw new RepoCreateError('Use a repository name of letters, numbers, ".", "-" or "_".');
  }
  if (typeof visibility !== 'string' || !VISIBILITIES.has(visibility)) {
    throw new RepoCreateError('Choose public, private or internal visibility.');
  }
  const root = getDefaultCloneRoot();
  const dest = path.join(root, name);
  assertNotKnowledgeSource(dest);
  if (await access(dest).then(() => true, () => false)) {
    throw new RepoCreateError(`A folder named ${name} already exists in ${root}. Choose another name.`, 409);
  }
  await mkdir(root, { recursive: true });
  try {
    await execFileAsync('gh', ['repo', 'create', name, `--${visibility}`, '--clone'], {
      cwd: root, windowsHide: true, timeout: CREATE_TIMEOUT_MS,
      env: childEnvironment({ env: { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } }),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RepoCreateError('The GitHub CLI (gh) is not installed on this machine.', 424);
    }
    // gh's own message says what to fix: sign in, or the name is taken.
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    throw new RepoCreateError(stderr.slice(-512) || 'gh repo create failed.', 502);
  }
  if (!(await stat(path.join(dest, '.git')).then(s => s.isDirectory(), () => false))) {
    throw new RepoCreateError(`gh created the repository but did not clone it into ${dest}.`, 502);
  }
  return { localPath: dest };
}
