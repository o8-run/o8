import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it } from 'vitest';

// A registered repository with one saved thread and one compaction archive that mention the query.
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'o8-archive-repo-')));
writeFileSync(join(dataDir, 'repos.json'), JSON.stringify({ version: 1,
  repos: [{ id: 'archive-fixture', name: 'archive-fixture', localPath: repo, isGitRepo: false }] }));
mkdirSync(join(dataDir, 'chat-history'), { recursive: true });
writeFileSync(join(dataDir, 'chat-history', 'thoughts-archive-fixture.json'), JSON.stringify({
  title: 'Archive fixture', backend: 'pi', orchestratorVisible: true, repoPath: repo, savedAt: '2026-11-08T10:00:00.000Z',
  messages: [{ role: 'user', content: 'How does the lighthouse ledger rotate?' },
    { role: 'assistant', content: 'The lighthouse ledger rotates nightly.' }],
}));
mkdirSync(join(dataDir, 'orchestrator-archives'), { recursive: true });
writeFileSync(join(dataDir, 'orchestrator-archives', 'archive-fixture.json'), JSON.stringify({
  repoPath: repo, tabId: 'thoughts-archive-fixture', archivedAt: '2026-11-07T10:00:00.000Z',
  turns: [{ id: 'turn-1', role: 'assistant', content: 'Compacted: the lighthouse ledger moved to weekly.' }],
}));

const { GET } = await import('@/app/api/orchestrator/archive/route');
const { matchNativeHttpRoute, nativeSurfaceRoutes } = await import('@/lib/ws-server/native-http-registry');

afterAll(() => { rmSync(repo, { recursive: true, force: true }); });

const request = (query: Record<string, string>) => new NextRequest(
  `http://localhost:3001/api/orchestrator/archive?${new URLSearchParams(query)}`, { headers: { host: 'localhost:3001' } });

function snapshot(directory: string): string[] {
  return readdirSync(directory, { recursive: true }).map(String).sort().map(file => {
    try { return `${file}:${createHash('sha256').update(readFileSync(join(directory, file))).digest('hex')}`; }
    catch { return file; } // A directory.
  });
}

it('registers the production archive GET for the native composer caller', async () => {
  const route = nativeSurfaceRoutes.session.find(route => route.path === '/api/orchestrator/archive');
  expect(route, 'session archive GET registration').toBeDefined();
  expect(route!.methods).toEqual(['GET']);
  expect(await route!.load()).toMatchObject({ GET });
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    expect(matchNativeHttpRoute('/api/orchestrator/archive', method)).toBeUndefined();
  }
});

it('recalls saved thread and compaction matches for a registered repository without writing', async () => {
  const before = snapshot(dataDir);
  const response = await GET(request({ repoPath: repo, q: 'lighthouse ledger', limit: '4' }));
  expect(response.status).toBe(200);
  const { matches } = await response.json() as { matches: Array<{ source: string; preview: string }> };
  expect(matches.map(match => match.source).sort()).toEqual(['compaction', 'thread', 'thread']);
  expect(matches.map(match => match.preview).join(' ')).toContain('moved to weekly');
  expect(snapshot(dataDir)).toEqual(before);
});

it('keeps the registry boundary', async () => {
  const unregistered = await GET(request({ repoPath: tmpdir(), q: 'lighthouse' }));
  expect(unregistered.status).toBe(400);
  expect(await unregistered.json()).toEqual({ matches: [] });
});
