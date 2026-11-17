import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { seedSessionFixture, startSessionServer } from '../scripts/o8d/parity';

const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? process.env.O8D_BINARY ?? join(targetDir, 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
beforeAll(async () => {
  if (process.env.O8D_TEST_BINARY || process.env.O8D_BINARY) return;
  await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--target-dir', targetDir],
    { maxBuffer: 64 * 1024 * 1024 });
}, 900_000);

it('uses one four-route GET table through the public socket with Next stopped', async () => {
  const table = JSON.parse(readFileSync('crates/o8d/native-routes.json', 'utf8')) as Array<{
    path: string; methods: string[]; fallback: boolean; reason: string; state: string; test: string;
  }>;
  expect(table.map(route => route.path).sort()).toEqual([
    '/api/mobile/history', '/api/mobile/orchestrator/threads', '/api/orchestrator/composer-queue', '/api/v2/chat-history',
  ]);
  for (const route of table) {
    expect(route.methods).toEqual(['GET']);
    expect(route.fallback).toBe(true);
    expect(route.state).toBe('red');
    expect(route.test).toBe('tests/o8d-native-route-table-real-path.test.ts');
    expect(route.reason.length).toBeGreaterThan(0);
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-route-table-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    server = await startSessionServer(directory, true, binary);
    const queries: Record<string, string> = {
      '/api/mobile/history': '?sessionKey=llm-chat:thoughts-review',
      '/api/v2/chat-history': '?tabId=thoughts-review',
      '/api/orchestrator/composer-queue': '?' + new URLSearchParams({ repoPath: join(directory, 'fixture-repo'), threadId: 'thoughts-review', backend: 'claude' }),
    };
    for (const { path } of table) {
      const response = await fetch(server.origin + path + (queries[path] ?? ''), { headers: { authorization: `Bearer ${server.token}` } });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-o8d-native'), `Native route was not reached: ${path}`).toBe('1');
      expect(response.headers.get('x-o8d-native-session-read')).toBe('1');
      await response.arrayBuffer();
      const refused = await fetch(server.origin + path, { headers: { authorization: 'Bearer wrong',
        'x-o8d-session-read': 'authorize', 'x-o8d-bridge': 'spoofed', 'x-o8d-peer': '127.0.0.1' } });
      expect(refused.status).toBe(401);
      expect(refused.headers.get('x-o8d-native')).toBeNull();
      await refused.arrayBuffer();
    }
    const other = await fetch(server.origin + '/api/panel/ws-info', { headers: { authorization: `Bearer ${server.token}` } });
    expect(other.status).toBe(200);
    expect(other.headers.get('x-o8d-native')).toBeNull();
    await other.arrayBuffer();
    await server.stop();
    server = undefined;
    const raw = readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8');
    const records = raw.trim().split('\n').map(line => JSON.parse(line));
    for (const { path } of table) {
      expect(records).toContainEqual(expect.objectContaining({ route: path, method: 'GET', status: 200 }));
      expect(records).toContainEqual(expect.objectContaining({ route: path, method: 'GET', status: 401 }));
    }
    expect(records).toContainEqual(expect.objectContaining({ route: '__other__', method: 'GET', status: 200 }));
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(['durationBucket', 'method', 'route', 'status']);
      expect(['lt10ms', 'lt100ms', 'lt1s', 'gte1s']).toContain(record.durationBucket);
    }
    expect(raw).not.toContain('thoughts-review');
    expect(raw).not.toContain('Bearer');
    expect(raw).not.toContain('spoofed');
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
