import { execFile } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, get } from 'node:http';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { firstDifference, normalize, runSessionParity, seedSessionFixture, send, SESSION_READ_PATHS, startSessionServer } from '../scripts/o8d/parity';

// CI ships no daemon: build the session-reads feature set into its own target
// directory so a sibling surface test's experimental-ws build cannot replace it.
const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? process.env.O8D_BINARY ?? join(targetDir, 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
beforeAll(async () => {
  if (process.env.O8D_TEST_BINARY || process.env.O8D_BINARY) return;
  await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--target-dir', targetDir],
    { maxBuffer: 64 * 1024 * 1024 });
}, 900_000);
it('records TS session reads and replays them natively with zero differences and Next stopped', async () => {
  expect(await runSessionParity(binary, false)).toMatchObject({ requests: 20, differences: 0 });
}, 180_000);

it('preserves auth refusals, TS writes, other routes and flag-off behavior through the public socket', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-parity-auth-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    for (const enabled of [false, true]) {
      server = await startSessionServer(directory, enabled, binary);
      for (const path of SESSION_READ_PATHS) {
        for (const credential of ['', 'wrong', 'o8ro_fixture']) {
          const response = await send(server, path, { authorization: credential ? `Bearer ${credential}` : '',
            'x-o8d-session-read': 'authorize', 'x-o8d-bridge': 'spoofed', 'x-o8d-peer': '127.0.0.1' });
          expect(response.status).toBe(credential.startsWith('o8ro_') ? 403 : 401);
        }
      }
      const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
      const response = await fetch(`${server.origin}/api/v2/chat-history`, { method: 'POST', headers,
        body: JSON.stringify({ tabId: 'thoughts-parity-write', messages: [], backend: 'claude', model: 'claude-code', repoPath: join(directory, 'fixture-repo') }) });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-o8d-native-session-read')).toBeNull();
      expect((await send(server, '/api/v2/chat-history?tabId=thoughts-parity-write')).body).toMatchObject({ messages: [], backend: 'claude' });
      for (const method of ['POST', 'PATCH', 'DELETE']) {
        const write = await fetch(`${server.origin}/api/orchestrator/composer-queue`, { method, headers, body: '{}' });
        expect(write.status).toBe(400);
        expect(write.headers.get('x-o8d-native-session-read')).toBeNull();
      }
      const unsupported = await send(server, '/api/mobile/history?sessionKey=unsupported');
      expect(unsupported.status).toBe(400);
      expect(unsupported.native).toBe(false);
      const other = await send(server, '/api/panel/projects');
      expect(other.status).toBe(200);
      expect(other.native).toBe(false);
      await server.stop(); server = undefined;
    }
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);

it('reclassifies native reads after a TS request on a keep-alive client', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-parity-keepalive-')));
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    server = await startSessionServer(directory, true, binary);
    const read = (path: string) => new Promise<{ status: number | undefined; native: boolean }>((resolve, reject) => {
      const request = get(server!.origin + path, { agent, headers: { authorization: `Bearer ${server!.token}` } }, response => {
        response.resume();
        response.once('end', () => resolve({ status: response.statusCode, native: response.headers['x-o8d-native-session-read'] === '1' }));
        response.once('error', reject);
      });
      request.once('error', reject);
    });
    expect(await read('/api/panel/projects')).toEqual({ status: 200, native: false });
    expect(await read('/api/v2/chat-history?tabId=thoughts-review')).toEqual({ status: 200, native: true });
  } finally { agent.destroy(); await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);

it('prints the first semantic difference without dropping timestamps, revisions, IDs or nulls', () => {
  expect(firstDifference(normalize({ requestId: 'a', timestamp: 1 }), normalize({ requestId: 'b', timestamp: 2 }))).toContain('$/timestamp');
  for (const field of ['id', 'revision', 'inboxRevision', 'savedAt', 'lastMessageAt', 'createdAt']) {
    expect(firstDifference(normalize({ [field]: 'a' }), normalize({ [field]: 'b' }))).toContain(`$/${field}`);
  }
  expect(firstDifference({ a: null }, {})).toContain('missing');
  expect(firstDifference({ constructor: null }, {})).toContain('missing');
  expect(firstDifference([1, 2], [2, 1])).toContain('$/0');
});

it('defers DB-bound and JSON-only network threads to the TS projection owner', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-parity-network-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    const { default: Database } = await import('better-sqlite3');
    const { ensureV77BotNetworkThreadSchema } = await import('@/lib/db/v77-bot-network-thread-migration');
    const db = new Database(join(directory, 'cortex-ide.db'));
    try {
      ensureV77BotNetworkThreadSchema(db);
      db.prepare('INSERT INTO bot_network_threads (thread_id, repo_path, participants_json, title, created_at) VALUES (?, ?, ?, ?, ?)')
        .run('thoughts-network-binding', join(directory, 'fixture-repo'), '[]', 'Fixture network', '2026-10-01T00:00:00.000Z');
    } finally { db.close(); }
    writeFileSync(join(directory, 'chat-history', 'thoughts-network-json.json'), JSON.stringify({
      source: 'bot-network', repoPath: join(directory, 'fixture-repo'), messages: [],
    }));
    server = await startSessionServer(directory, true, binary);
    const history = await send(server, '/api/mobile/history?' + new URLSearchParams({ sessionKey: ' llm-chat:thoughts-network-binding ' }));
    expect(history.native).toBe(false);
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({ sessionKey: 'llm-chat:thoughts-network-binding', transcript: [] });
    unlinkSync(join(directory, 'chat-history', 'thoughts-network-binding.json'));
    const projected = await send(server, '/api/v2/chat-history?tabId=thoughts-network-binding');
    expect(projected.native).toBe(false);
    expect(projected.status).toBe(200);
    expect(projected.body).toMatchObject({ source: 'bot-network', messages: [] });
    const queue = await send(server, '/api/orchestrator/composer-queue?' + new URLSearchParams({
      repoPath: join(directory, 'fixture-repo'), threadId: 'thoughts-network-json', backend: 'claude',
    }));
    expect(queue.native).toBe(false);
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
