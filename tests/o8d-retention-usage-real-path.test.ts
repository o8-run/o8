import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterAll, expect, it } from 'vitest';

// One registered repository; the default worktree root does not exist yet.
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'o8-retention-repo-')));
writeFileSync(join(repo, 'README.md'), 'Retention fixture\n');
writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({ version: 1,
  repos: [{ id: 'retention-fixture', name: 'retention-fixture', localPath: repo, isGitRepo: false }] }));

const { GET } = await import('@/app/api/worktrees/retention-usage/route');
const { matchNativeHttpRoute, nativeSurfaceRoutes } = await import('@/lib/ws-server/native-http-registry');
const { getSqlite } = await import('@/lib/db');

afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

it('registers the production retention GET for the native storage settings caller', async () => {
  const route = nativeSurfaceRoutes.settings.find(route => route.path === '/api/worktrees/retention-usage');
  expect(route, 'settings retention GET registration').toBeDefined();
  expect(route!.methods).toEqual(['GET']);
  expect(await route!.load()).toMatchObject({ GET });
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    expect(matchNativeHttpRoute('/api/worktrees/retention-usage', method)).toBeUndefined();
  }
});

it('measures storage while a provider key write holds the store lock, without creating the worktree root', async () => {
  getSqlite(); // Startup opens the database; the GET must not add to the data directory.
  expect(existsSync(join(dataDir, 'worktrees'))).toBe(false);
  // A key write holds this lock for its whole transaction. Each du, df or volume
  // query on the locked boundary would block the event loop for the lock's 1 s
  // timeout. Opening the holder creates the lock file when startup did not.
  const holder = new Database(join(dataDir, '.provider-keys.lock'));
  const files = readdirSync(dataDir, { recursive: true }).map(String).sort();
  holder.exec('BEGIN EXCLUSIVE');
  let response: Response;
  const started = performance.now();
  try {
    response = await GET(new NextRequest('http://localhost:3001/api/worktrees/retention-usage',
      { headers: { host: 'localhost:3001' } }));
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  expect(performance.now() - started).toBeLessThan(2_500);
  expect(response.status).toBe(200);
  // The host volume is measured through df and the volume identity query.
  expect(await response.json()).toMatchObject({ hostAccountingStatus: 'observed', repos: [],
    storagePressure: { repositories: [{ id: 'retention-fixture' }] } });
  expect(existsSync(join(dataDir, 'worktrees'))).toBe(false);
  expect(readdirSync(dataDir, { recursive: true }).map(String).sort()).toEqual(files);
});
