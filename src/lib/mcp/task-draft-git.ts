import { execFile } from '@/lib/providers/child-process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { taskDraftRoot } from './task-draft-store';
import { TaskDraftError } from './task-draft-contract';

const exec = promisify(execFile);

/** Local probes/checkouts cannot execute configured hooks, filters or monitors. */
export async function taskDraftGitOptions(repo: string): Promise<string[]> {
  const hooks = join(taskDraftRoot(), 'empty-hooks');
  mkdirSync(hooks, { recursive: true, mode: 0o700 });
  if (readdirSync(hooks).length) throw new TaskDraftError('workspace_unavailable', 409);
  const options = ['--no-optional-locks', '-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false',
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
  let filters = '';
  try {
    filters = (await exec('git', [...options, '-C', repo, 'config', '--name-only', '--get-regexp',
      '^filter\..*\.(clean|smudge|process|required)$'], { timeout: 5000, maxBuffer: 512_000 })).stdout;
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw new TaskDraftError('workspace_unavailable', 409);
  }
  for (const key of new Set(filters.trim().split('\n').filter(Boolean))) {
    if (!/^filter\..+\.(clean|smudge|process|required)$/.test(key)) throw new TaskDraftError('workspace_unavailable', 409);
    options.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
  }
  return options;
}

export async function taskDraftGit(repo: string, args: string[]): Promise<string> {
  return (await exec('git', [...await taskDraftGitOptions(repo), '-C', repo, ...args], { timeout: 10_000, maxBuffer: 512_000 })).stdout;
}
