import 'server-only';

import { execFile } from '@/lib/providers/child-process';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { addRepo } from '@/lib/repos/registry';
import { reconcileProjectsWithRegistry } from '@/lib/repos/projects';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const execFileAsync = promisify(execFile);

interface RegisteredBootstrapRepo {
  repo: RepoRegistryEntry;
  projectId: string | null;
}

interface InitRepoResult extends RegisteredBootstrapRepo {
  initialized: boolean;
  initialCommit: boolean;
}

export class RepoInitError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); this.name = 'RepoInitError'; }
}

function expandHomePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function resolveTargetPath(inputPath: string): string {
  const expanded = expandHomePath(inputPath);
  if (!expanded) {
    throw new Error('repo path is required');
  }
  return path.resolve(expanded);
}

async function ensureDirectory(repoPath: string): Promise<void> {
  const existing = await stat(repoPath).catch(() => null);
  if (existing && !existing.isDirectory()) {
    throw new Error('repo path must be a directory');
  }
  await mkdir(repoPath, { recursive: true });
}

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 20_000,
  });
  return stdout.trim();
}

async function runGitCommit(repoPath: string, message: string): Promise<boolean> {
  try {
    await execFileAsync(
      'git',
      [
        '-C',
        repoPath,
        '-c',
        'user.name=o8',
        '-c',
        'user.email=o8@local',
        'commit',
        '-m',
        message,
      ],
      { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 20_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

async function hasCommit(repoPath: string): Promise<boolean> {
  try {
    await runGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

async function ensureGitRepo(repoPath: string): Promise<boolean> {
  if (await isGitRepo(repoPath)) {
    return false;
  }
  try {
    await execFileAsync('git', ['init', '-b', 'main', repoPath], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
    });
  } catch {
    await execFileAsync('git', ['init', repoPath], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      timeout: 20_000,
    });
    await runGit(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
  return true;
}

async function ensureInitialCommit(repoPath: string, name?: string): Promise<boolean> {
  if (await hasCommit(repoPath)) {
    return false;
  }
  const filename = name?.trim() ? 'README.md' : '.gitkeep';
  const contents = name?.trim() ? `# ${name.trim()}\n` : '';
  const filePath = path.join(repoPath, filename);
  if (!(await stat(filePath).catch(() => null))) {
    await writeFile(filePath, contents, 'utf8');
  }
  await runGit(repoPath, ['add', '--', filename]);
  const committed = await runGitCommit(repoPath, 'chore: initialize repository');
  if (!committed) {
    throw new Error('Failed to create the initial git commit.');
  }
  return true;
}

async function registerRepo(repoPath: string): Promise<RegisteredBootstrapRepo> {
  const repo = await addRepo(repoPath);
  const ledger = await reconcileProjectsWithRegistry();
  const project = ledger.projects.find((entry) => (
    entry.repoPaths.some((candidate) => path.resolve(candidate) === path.resolve(repo.localPath))
  ));
  return { repo, projectId: project?.id ?? ledger.activeProjectId ?? null };
}

export async function initRepo(inputPath: string, name?: string): Promise<InitRepoResult> {
  const repoPath = resolveTargetPath(inputPath);
  // Git treats a new subfolder of a checkout as the parent repository. Reject
  // that target before creating a folder or registering the wrong root.
  let ancestor = repoPath;
  while (!(await stat(ancestor).catch(() => null)) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
  const existingRoot = await runGit(ancestor, ['rev-parse', '--show-toplevel']).catch(() => null);
  if (existingRoot) {
    const target = await realpath(repoPath).catch(() => repoPath);
    if (path.resolve(existingRoot) !== path.resolve(target)) throw new RepoInitError('Choose a folder outside an existing repository. Use Local folder to connect that repository.');
  }
  await ensureDirectory(repoPath);
  const initialized = await ensureGitRepo(repoPath);
  const initialCommit = await ensureInitialCommit(repoPath, name);
  const registered = await registerRepo(repoPath);
  return { ...registered, initialized, initialCommit };
}
