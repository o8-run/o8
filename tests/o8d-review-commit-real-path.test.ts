import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

// A fixture repository whose pre-commit hook takes a while, as real hooks do.
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'o8-review-commit-')));
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Fixture');
git('config', 'user.email', 'fixture@example.invalid');
git('config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'README.md'), 'Fixture\n');
git('add', 'README.md');
git('commit', '-q', '-m', 'Fixture');
writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 1\n');
chmodSync(join(repo, '.git', 'hooks', 'pre-commit'), 0o755);

const { POST } = await import('@/app/api/review/commit/route');
const { matchNativeHttpRoute, nativeSurfaceRoutes } = await import('@/lib/ws-server/native-http-registry');

afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

const commit = (body: unknown) => POST(new Request('http://localhost:3001/api/review/commit', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

it('registers the production commit POST for the native diff Git bar', async () => {
  const route = nativeSurfaceRoutes.diff.find(route => route.path === '/api/review/commit');
  expect(route, 'diff commit POST registration').toBeDefined();
  expect(route!.methods).toEqual(['POST']);
  expect(await route!.load()).toMatchObject({ POST });
  for (const method of ['GET', 'PATCH', 'PUT', 'DELETE']) {
    expect(matchNativeHttpRoute('/api/review/commit', method)).toBeUndefined();
  }
});

it('commits the workspace without blocking the serving process during a slow hook', async () => {
  writeFileSync(join(repo, 'notes.md'), 'Committed from the diff panel\n');
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 100);
  let response: Response;
  try {
    response = await commit({ message: 'Commit `literal` $(text)', workspace: repo });
  } finally {
    clearInterval(timer);
  }
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ ok: true, hash: git('rev-parse', '--short', 'HEAD'), message: 'Commit `literal` $(text)' });
  expect(git('log', '-1', '--format=%s')).toBe('Commit `literal` $(text)');
  expect(git('status', '--porcelain')).toBe('');
  // The hook sleeps 1 s; a synchronous launch would starve this timer for all of it.
  expect(ticks).toBeGreaterThanOrEqual(5);
});

it('keeps the refusals', async () => {
  expect((await commit({ message: 'Nothing staged', workspace: repo })).status).toBe(400);
  expect((await commit({ message: ' ', workspace: repo })).status).toBe(400);
});
