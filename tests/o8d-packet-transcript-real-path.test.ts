import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

// A fixture Codex home: the transcript read reaches it through `sqlite3 -readonly`.
const root = mkdtempSync(join(tmpdir(), 'o8-packet-transcript-'));
const codexHome = join(root, 'codex-home');
const threadId = 'native-transcript-thread';
const rolloutDir = join(codexHome, 'sessions', '2026', '11', '08');
const rollout = join(rolloutDir, `rollout-2026-11-08T10-00-00-${threadId}.jsonl`);
mkdirSync(rolloutDir, { recursive: true });
writeFileSync(rollout, [
  { type: 'session_meta', payload: { id: threadId } },
  { type: 'event_msg', timestamp: '2026-11-08T10:00:01Z', payload: { type: 'user_message', message: 'Fixture question' } },
  { type: 'event_msg', timestamp: '2026-11-08T10:00:02Z', payload: { type: 'agent_message', message: 'Fixture answer' } },
].map(line => JSON.stringify(line)).join('\n') + '\n');
const stateDb = join(codexHome, 'state_5.sqlite');
const db = new Database(stateDb);
db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER,
  rollout_path TEXT, git_branch TEXT, git_sha TEXT, git_origin_url TEXT,
  first_user_message TEXT, model TEXT, archived INTEGER);`);
db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  .run(threadId, 'Fixture thread', codexHome, 1, rollout, '', '', '', 'Fixture question', '', 0);
db.close();
vi.stubEnv('CODEX_HOME', codexHome);
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;

const { GET } = await import('@/app/api/orchestrator/packet-transcript/route');
const { matchNativeHttpRoute, nativeSurfaceRoutes } = await import('@/lib/ws-server/native-http-registry');
const { getSqlite } = await import('@/lib/db');

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const request = (query: string) => new NextRequest(`http://localhost:3001/api/orchestrator/packet-transcript?${query}`,
  { headers: { host: 'localhost:3001' } });

it('registers the production transcript GET for the native sidebar caller', async () => {
  const route = nativeSurfaceRoutes.sidebar.find(route => route.path === '/api/orchestrator/packet-transcript');
  expect(route, 'sidebar transcript GET registration').toBeDefined();
  expect(route!.methods).toEqual(['GET']);
  expect(await route!.load()).toMatchObject({ GET });
  expect(matchNativeHttpRoute('/api/orchestrator/packet-transcript', 'GET')).toBeDefined();
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    expect(matchNativeHttpRoute('/api/orchestrator/packet-transcript', method)).toBeUndefined();
  }
});

it('reads a Codex transcript while a provider key write holds the store lock, and writes nothing', async () => {
  getSqlite(); // Startup opens the database; the GET must not add to the data directory.
  // A key write holds this lock for its whole transaction. A locked child launch
  // would wait for it, time out and lose the transcript. Opening the holder
  // creates the lock file when startup did not (Linux), so it is not counted
  // as a write by the GET; its journal exists only while the lock is held.
  const holder = new Database(join(dataDir, '.provider-keys.lock'));
  const files = readdirSync(dataDir).sort();
  holder.exec('BEGIN EXCLUSIVE');
  const before = digest(stateDb);
  let response: Response;
  try {
    response = await GET(request(`sessionKey=codex:${threadId}&tail=1&limit=50`));
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ sessionKey: `codex:${threadId}`, terminalReason: null });
  expect(JSON.stringify(body.events)).toContain('Fixture answer');

  expect(readdirSync(dataDir).sort()).toEqual(files);
  expect(digest(stateDb)).toBe(before);
  expect(readdirSync(codexHome).sort()).toEqual(['sessions', 'state_5.sqlite']);
});

it('keeps the missing-id refusal', async () => {
  const response = await GET(request('tail=1'));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: { code: 'packet_id_required' } });
});
