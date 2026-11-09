import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// o8 next's compare grid reads each candidate's committed file list from
// /api/orchestrator/comparison-diff. With Next stopped the WS listener serves it, operator-only,
// and the read leaves the candidate's repository unchanged.
it.skipIf(process.platform === 'win32')('serves the comparison diff natively with Next stopped (#5576)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-comparison-diff-')));
  const device = 'comparison-diff-fixture-device-0123456789abcdef';
  const worker = 'comparison-diff-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const repo = join(directory, 'candidate');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'comparison@example.test');
  git('config', 'user.name', 'Comparison Fixture');
  writeFileSync(join(repo, 'kept.ts'), 'export const kept = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'candidate');
  writeFileSync(join(repo, 'added.ts'), 'export const added = 2;\n');
  git('add', '.');
  git('commit', '-qm', 'candidate');
  writeFileSync(join(repo, 'uncommitted.ts'), 'wip\n');
  const gitState = () => readdirSync(join(repo, '.git'), { recursive: true }).map(String).sort()
    .map(file => `${file}:${statSync(join(repo, '.git', file)).mtimeMs}`);
  const before = gitState();
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const read = (query: string, bearer?: string) => fetch(`${origin}/api/orchestrator/comparison-diff?${query}`,
      { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    const query = `worktree=${encodeURIComponent(repo)}&base=main`;

    for (const [bearer, status] of [[undefined, 401], [device, 403], [worker, 403]] as const) {
      expect((await read(query, bearer)).status, bearer ?? 'anonymous').toBe(status);
    }
    const response = await read(query, server.token);
    expect(response.status).toBe(200);
    const body = await response.json() as { base: string; changedFiles: Array<{ path: string }> };
    // The candidate's committed change only, not its uncommitted work.
    expect(body.base).toBe('main');
    expect(body.changedFiles.map(file => file.path)).toEqual(['added.ts']);
    expect((await read(`worktree=${encodeURIComponent(repo)}&base=--output=x`, server.token)).status).toBe(400);
    expect(gitState()).toEqual(before);
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
