import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, expect, it } from 'vitest';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';

// A fixture repository with one managed worktree holding the last attempt's learnings.
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'o8-last-turn-')));
const worktree = join(repo, '.claude', 'worktrees', 'last-turn-fixture');
const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture',
  '-c', 'user.email=fixture@example.invalid', ...args], { stdio: 'ignore' });
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
writeFileSync(join(repo, 'README.md'), 'Fixture\n');
git('add', 'README.md');
git('commit', '-q', '-m', 'Fixture');
git('worktree', 'add', '-q', '-b', 'last-turn-fixture', worktree);
mkdirSync(join(worktree, '.o8'));
writeFileSync(join(worktree, '.o8', 'attempt-learnings.md'), [
  '# Attempt learnings', '', '```json',
  JSON.stringify({ attempt: 1, timestamp: '2026-11-08T10:00:00.000Z',
    filesChanged: ['src/last-turn-fixture.ts'], summary: 'Fixture attempt' }),
  '```', '',
].join('\n'));
const metadataRoot = resolveWorktreeRootLayout(repo).primaryBase;
mkdirSync(metadataRoot, { recursive: true });
writeFileSync(join(metadataRoot, '.meta.json'), JSON.stringify({ version: 1, worktrees: {
  'last-turn-fixture': { id: 'last-turn-fixture', agentType: 'claude', baseBranch: 'main', createdAt: 1,
    claudeManaged: true, taskName: 'Fixture', branchName: 'last-turn-fixture' },
} }));
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;

const { GET } = await import('@/app/api/review/last-turn/route');
const { matchNativeHttpRoute, nativeSurfaceRoutes } = await import('@/lib/ws-server/native-http-registry');
const { getSqlite } = await import('@/lib/db');

afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

it('registers the production last-turn GET for the native diff caller', async () => {
  const route = nativeSurfaceRoutes.diff.find(route => route.path === '/api/review/last-turn');
  expect(route, 'diff last-turn GET registration').toBeDefined();
  expect(route!.methods).toEqual(['GET']);
  expect(await route!.load()).toMatchObject({ GET });
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    expect(matchNativeHttpRoute('/api/review/last-turn', method)).toBeUndefined();
  }
});

it('reads the last turn while a provider key write holds the store lock, and writes nothing', async () => {
  getSqlite(); // Startup opens the database; the GET must not add to the data directory.
  const files = readdirSync(dataDir).sort();
  const worktreeFiles = readdirSync(worktree).sort();
  // A key write holds this lock for its whole transaction. Each Git launch on the
  // locked boundary would block for the lock's 1 s timeout before it fails.
  const holder = new Database(join(dataDir, '.provider-keys.lock'));
  holder.exec('BEGIN EXCLUSIVE');
  let response: Response;
  const started = performance.now();
  try {
    response = await GET(new Request(`http://localhost:3001/api/review/last-turn?${new URLSearchParams({ workspace: repo })}`));
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ filePaths: ['src/last-turn-fixture.ts'], worktreePath: worktree,
    timestamp: '2026-11-08T10:00:00.000Z', attempt: 1 });
  expect(readdirSync(dataDir).sort()).toEqual(files);
  expect(readdirSync(worktree).sort()).toEqual(worktreeFiles);
  expect(readdirSync(join(repo, '.git'))).not.toContain('index.lock');
});

it('answers an empty scope without a workspace', async () => {
  const response = await GET(new Request('http://localhost:3001/api/review/last-turn'));
  expect(await response.json()).toEqual({ filePaths: [], worktreePath: null });
});
