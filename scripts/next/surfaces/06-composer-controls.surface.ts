/** Owned composer controls fixture; calls the existing production route handlers. */
import childProcess, { execFileSync } from 'node:child_process';
import { mock } from 'node:test';
const realSync = childProcess.execFileSync;
const realFile = childProcess.execFile;
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import type { SurfaceContext, SurfaceRoutes } from '../surface-routes';

export async function prepare({ root }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--composer-controls')) return {};
  // Keep Settings' no-runtime boundary. Only Git inside this disposable root
  // uses the real process implementation; no operator path or provider runs.
  const deniedSync = childProcess.execFileSync;
  const deniedFile = childProcess.execFile;
  const ownedGit = (file: string, args?: readonly string[]) => file === 'git' && args?.[0] === '-C' && args[1]?.startsWith(root + '/');
  mock.method(childProcess, 'execFileSync', (file: string, args?: readonly string[], ...rest: unknown[]) => Reflect.apply(ownedGit(file, args) ? realSync : deniedSync, childProcess, [file, args, ...rest]));
  mock.method(childProcess, 'execFile', (file: string, args?: readonly string[], ...rest: unknown[]) => Reflect.apply(ownedGit(file, args) ? realFile : deniedFile, childProcess, [file, args, ...rest]));
  const profile = join(root, 'composer-profile');
  mkdirSync(profile);
  Object.defineProperty(os, 'homedir', { value: () => profile });
  syncBuiltinESMExports();
  return {};
}
export default async function register({ repo }: SurfaceContext): Promise<SurfaceRoutes> {
  if (!process.argv.includes('--composer-controls')) return {};
  execFileSync('git', ['-C', repo, 'branch', '-M', 'main']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@o8.invalid', 'commit', '--allow-empty', '-qm', 'Composer fixture base']);
  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feature/composer']);
  writeFileSync(join(repo, 'composer-fixture.txt'), 'A branch with an unmerged change.\n');
  execFileSync('git', ['-C', repo, 'add', '--', 'composer-fixture.txt']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@o8.invalid', 'commit', '-qm', 'Composer fixture change']);
  execFileSync('git', ['-C', repo, 'checkout', '-q', 'main']);
  const { addRepo } = await import('../../../src/lib/repos/registry');
  await addRepo(repo);
  const { createPromptLibraryEntry } = await import('../../../src/lib/prompt-library/store');
  createPromptLibraryEntry({ title: 'Review a change', body: 'Review the patch and report the checks.', tags: ['review'], scope: 'global', repoPath: null });
  const repos = await import('../../../src/app/api/panel/repos/route');
  const branches = await import('../../../src/app/api/panel/branches/route');
  const prompts = await import('../../../src/app/api/prompt-library/route');
  const use = await import('../../../src/app/api/prompt-library/[id]/use/route');
  const rules = await import('../../../src/app/api/orchestrator/session-rules/route');
  const directives = await import('../../../src/app/api/cortex/directives/route');
  const archive = await import('../../../src/app/api/orchestrator/archive/route');
  return {
    priority: 6,
    admit: ({ url, method, body }) => {
      if (url.pathname === '/api/panel/branches') {
        if (method === 'GET') return url.searchParams.get('path') === repo ? 200 : 400;
        try { return (JSON.parse(body) as { path?: unknown }).path === repo ? 200 : 400; } catch { return 400; }
      }
      if (url.pathname === '/api/orchestrator/session-rules' && method === 'POST') {
        try {
          const value = JSON.parse(body) as { text?: string; threadId?: string };
          if (value.text === "Keep the operator's scope") return 403;
          return value.threadId?.startsWith('thoughts-composer-') ? 200 : 400;
        } catch { return 400; }
      }
      return 200;
    },
    routes: {
      'GET /api/panel/repos': repos.GET,
      'GET /api/panel/branches': branches.GET,
      'POST /api/panel/branches': branches.POST,
      'GET /api/prompt-library': prompts.GET,
      'POST /api/prompt-library': prompts.POST,
      'GET /api/orchestrator/session-rules': rules.GET,
      'POST /api/orchestrator/session-rules': rules.POST,
      'DELETE /api/orchestrator/session-rules': rules.DELETE,
      'GET /api/cortex/directives': directives.GET,
      'GET /api/orchestrator/archive': archive.GET,
    },
    match: (method, path) => {
      const id = path.match(/^\/api\/prompt-library\/([^/]+)\/use$/)?.[1];
      if (method === 'POST' && id) return request => use.POST(request, { params: Promise.resolve({ id }) });
      return undefined;
    },
  };
}
