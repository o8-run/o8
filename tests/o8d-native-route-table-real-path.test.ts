import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { seedSessionFixture, startSessionServer } from '../scripts/o8d/parity';
import { seedChatListEdges } from '../scripts/o8d/chat-list-fixture';

const targetDir = join(process.cwd(), 'crates/o8d/target/session-reads');
const binary = process.env.O8D_TEST_BINARY ?? process.env.O8D_BINARY ?? join(targetDir, 'debug', process.platform === 'win32' ? 'o8d.exe' : 'o8d');
beforeAll(async () => {
  if (process.env.O8D_TEST_BINARY || process.env.O8D_BINARY) return;
  await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--target-dir', targetDir],
    { maxBuffer: 64 * 1024 * 1024 });
}, 900_000);

it('uses the shared GET table through the public socket with Next stopped', async () => {
  const allRoutes = JSON.parse(readFileSync('crates/o8d/native-routes.json', 'utf8')) as Array<{
    path: string; methods: string[]; fallback: boolean; reason: string; state: string; test: string;
  }>;
  // Each added group proves its own fixture in the test named by the table.
  const table = allRoutes.filter(route => route.test === 'tests/o8d-native-route-table-real-path.test.ts'
    || route.test === 'tests/o8d-rust-startup-real-path.test.ts' || route.path === '/api/v2/chat-history/list');
  expect(table.map(route => route.path).sort()).toEqual([
    '/api/mobile/history', '/api/mobile/orchestrator/threads', '/api/orchestrator/composer-queue', '/api/panel/ws-info', '/api/setup/identity', '/api/v2/chat-history', '/api/v2/chat-history/list',
  ]);
  for (const route of table) {
    expect(route.methods).toEqual(['GET']);
    expect(route.fallback).toBe(true);
    const startup = ['/api/panel/ws-info', '/api/setup/identity'].includes(route.path);
    const chatList = route.path === '/api/v2/chat-history/list';
    expect(route.state).toBe(startup || chatList ? 'rust-with-fallback' : 'red');
    expect(route.test).toBe(startup ? 'tests/o8d-rust-startup-real-path.test.ts' : chatList ? 'tests/o8d-rust-chat-list-real-path.test.ts' : 'tests/o8d-native-route-table-real-path.test.ts');
    expect(route.reason.length).toBeGreaterThan(0);
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8d-route-table-')));
  let server: Awaited<ReturnType<typeof startSessionServer>> | undefined;
  try {
    await seedSessionFixture(directory);
    seedChatListEdges(directory);
    writeFileSync(join(directory, 'instance-id'), 'fixture-table-instance');
    writeFileSync(join(directory, 'boot-id'), 'fixture-table-boot');
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
      expect(refused.status).toBe(path === '/api/setup/identity' ? 200 : 401);
      expect(refused.headers.get('x-o8d-native')).toBeNull();
      await refused.arrayBuffer();
    }
    const other = await fetch(server.origin + '/api/runtime/capabilities', { headers: { authorization: `Bearer ${server.token}` } });
    expect(other.status).toBe(200);
    if (!allRoutes.some(route => route.path === '/api/runtime/capabilities')) expect(other.headers.get('x-o8d-native')).toBeNull();
    await other.arrayBuffer();
    // Best-effort telemetry can skip a busy sample or trail the final reply.
    const countsPath = join(directory, 'o8d-request-counts.jsonl');
    const required = [...table.flatMap(({ path }) => [{ path, status: 200 },
      { path, status: path === '/api/setup/identity' ? 200 : 401 }]),
      { path: '/api/runtime/capabilities', status: 200 }];
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const observed = existsSync(countsPath) ? readFileSync(countsPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      const missing = required.filter(item => !observed.some(record => record.route === item.path && record.status === item.status));
      if (!missing.length) break;
      for (const item of missing) {
        const response = await fetch(server.origin + item.path + (queries[item.path] ?? ''), {
          headers: { authorization: item.status === 401 ? 'Bearer wrong' : `Bearer ${server.token}` },
        });
        expect(response.status).toBe(item.status);
        await response.arrayBuffer();
      }
    }
    await server.stop();
    server = undefined;
    const raw = readFileSync(join(directory, 'o8d-request-counts.jsonl'), 'utf8');
    const records = raw.trim().split('\n').map(line => JSON.parse(line));
    for (const { path } of table) {
      expect(records).toContainEqual(expect.objectContaining({ route: path, method: 'GET', status: 200 }));
      expect(records).toContainEqual(expect.objectContaining({ route: path, method: 'GET', status: path === '/api/setup/identity' ? 200 : 401 }));
    }
    expect(records).toContainEqual(expect.objectContaining({ route: '/api/runtime/capabilities', method: 'GET', status: 200 }));
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(['durationBucket', 'method', 'route', 'status']);
      expect(['lt10ms', 'lt100ms', 'lt1s', 'gte1s']).toContain(record.durationBucket);
    }
    expect(raw).not.toContain('thoughts-review');
    expect(raw).not.toContain('Bearer');
    expect(raw).not.toContain('spoofed');
  } finally { await server?.stop(); rmSync(directory, { recursive: true, force: true }); }
}, 180_000);
