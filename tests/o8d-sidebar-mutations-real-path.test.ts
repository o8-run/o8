import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

const binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/debug/o8d');
let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let workspaceA: string;
let workspaceB: string;
const ownedRoot = process.env.CORTEX_IDE_OWNED_CODEX_ROOT!;
const ownedIds: string[] = [];
beforeAll(async () => {
  if (!process.env.O8D_TEST_BINARY) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
  server = await startParityReference({ o8d: true, binary, nativeHttp: true });
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  await server.stopNext();
  workspaceA = join(server.directory, 'workspace-a');
  workspaceB = join(server.directory, 'workspace-b');
  for (const directory of [workspaceA, workspaceB, join(server.directory, 'chat-history')]) mkdirSync(directory, { recursive: true });
}, 180_000);
afterAll(async () => {
  await server?.stop();
  for (const id of ownedIds) for (const root of [ownedRoot, `${ownedRoot}-archive`]) rmSync(join(root, id), { recursive: true, force: true });
});
function history(id: string, workspace: string) {
  const file = join(server.directory, 'chat-history', `${id}.json`);
  writeFileSync(file, JSON.stringify({ repoPath: workspace, title: 'Saved fixture', messages: [], archivedAt: null }));
  return file;
}
function owned(id: string, workspace: string) {
  ownedIds.push(id);
  const directory = join(ownedRoot, id);
  mkdirSync(join(directory, 'runs'), { recursive: true });
  writeFileSync(join(directory, 'session.json'), JSON.stringify({ surfaceId: `codex-owned:${id}`,
    sessionDir: directory, cwd: workspace, repoPath: workspace, title: 'Owned fixture',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recentRuns: [] }));
  return directory;
}
function request(path: string, method: string, workspace: string, body?: unknown) {
  const url = new URL(origin + path);
  url.searchParams.set('workspace', workspace);
  return fetch(url, { method, headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function originalRoute(path: string, method: string, workspace: string, body?: unknown) {
  const route = path.startsWith('/api/runtime/archive') ? './src/app/api/runtime/archive/route.ts' : './src/app/api/v2/chat-history/route.ts';
  const url = new URL('http://127.0.0.1' + path);
  url.searchParams.set('workspace', workspace);
  const result = await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
    (async () => {
      const { NextRequest } = require('next/server');
      const handler = require(${JSON.stringify(route)})[${JSON.stringify(method)}];
      const response = await handler(new NextRequest(${JSON.stringify(url.href)}, {
        method: ${JSON.stringify(method)}, headers: { 'content-type': 'application/json' },
        ${body === undefined ? '' : `body: ${JSON.stringify(JSON.stringify(body))},`}
      }));
      console.log(JSON.stringify({ fixtureStatus: response.status }));
      require('./src/lib/db/index.ts').closeDb();
    })().catch(() => { process.exitCode = 1; });
  `], { env: { ...process.env, NODE_ENV: 'test', O8_DATA_DIR: server.directory, CORTEX_IDE_DATA_DIR: server.directory,
    CORTEX_IDE_DB_PATH: join(server.directory, 'cortex-ide.db') }, timeout: 20_000 });
  return JSON.parse(result.stdout.split('\n').find(line => line.startsWith('{"fixtureStatus":'))!).fixtureStatus as number;
}

it.each([
  ['rename', { title: 'Renamed fixture' }], ['pin', { pinned: true }], ['star', { starred: true }],
  ['archive', { archivedAt: '2026-01-01T00:00:00.000Z' }], ['restore', { archivedAt: null }],
])('serves the native sidebar %s PATCH through o8d with Next stopped', async (name, patch) => {
  const id = `thoughts-round1-${name}`;
  const file = history(id, workspaceA);
  const response = await request('/api/v2/chat-history', 'PATCH', workspaceA, { tabId: id, ...(patch as object) });
  expect(response.status).toBe(200);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject(patch as object);
});

it('refuses cross-workspace history DELETE through o8d because nothing native calls it', async () => {
  const id = 'thoughts-round1-delete-bridge';
  const file = history(id, workspaceB);
  const before = readFileSync(file, 'utf8');
  const response = await request(`/api/v2/chat-history?tabId=${id}`, 'DELETE', workspaceA);
  expect(response.status).toBe(405);
  expect(readFileSync(file, 'utf8')).toBe(before);
  expect((await request('/api/v2/chat-history?tabId=thoughts-round1-absent', 'DELETE', workspaceA)).status).toBe(405);
});

it('keeps cross-workspace PATCH and POST from rewriting or reassigning saved history', async () => {
  const id = 'thoughts-round1-patch-other';
  const file = history(id, workspaceB);
  const before = readFileSync(file, 'utf8');
  for (const method of ['PATCH', 'POST']) {
    const response = await request('/api/v2/chat-history', method, workspaceA, {
      tabId: id, title: 'Rejected fixture', repoPath: workspaceA, messages: [], archivedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(response.status).toBe(404);
    expect(readFileSync(file, 'utf8')).toBe(before);
  }
  expect((await request('/api/v2/chat-history', 'PATCH', workspaceA,
    { tabId: 'thoughts-round1-unknown', archivedAt: '2026-01-01T00:00:00.000Z' })).status).toBe(404);
  expect(existsSync(join(server.directory, 'chat-history/thoughts-round1-unknown.json'))).toBe(false);
});

it('enforces workspace and unknown-id refusal in the original history DELETE handler too', async () => {
  const id = 'thoughts-round1-delete-original';
  const file = history(id, workspaceB);
  expect(await originalRoute(`/api/v2/chat-history?tabId=${id}`, 'DELETE', workspaceA)).toBe(404);
  expect(existsSync(file)).toBe(true);
  expect(await originalRoute(`/api/v2/chat-history?tabId=${id}`, 'DELETE', workspaceB)).toBe(200);
  expect(existsSync(file)).toBe(false);
  expect(await originalRoute(`/api/v2/chat-history?tabId=${id}`, 'DELETE', workspaceB)).toBe(404);
});

it('refuses cross-workspace owned archive before moving a directory or binding a receipt', async () => {
  const id = 'round1-archive-bridge';
  const directory = owned(id, workspaceB);
  const body = { sessionKey: `codex-owned:${id}`, clientMutationId: 'round1-archive-bridge' };
  const before = readFileSync(join(directory, 'session.json'), 'utf8');
  expect((await request('/api/runtime/archive', 'POST', workspaceA, body)).status).toBe(404);
  expect(readFileSync(join(directory, 'session.json'), 'utf8')).toBe(before);
  expect(existsSync(join(`${ownedRoot}-archive`, id))).toBe(false);
  expect((await request('/api/runtime/archive', 'POST', workspaceB, body)).status).toBe(200);
  expect(existsSync(directory)).toBe(false);
  expect(existsSync(join(`${ownedRoot}-archive`, id, 'session.json'))).toBe(true);
  expect((await request('/api/runtime/archive', 'POST', workspaceA, body)).status).toBe(404);
  const replay = await request('/api/runtime/archive', 'POST', workspaceB, body);
  expect(replay.status).toBe(200);
  expect(replay.headers.get('x-o8-idempotency-replayed')).toBe('1');
  expect((await request('/api/runtime/archive', 'POST', workspaceA,
    { sessionKey: 'codex-owned:round1-missing', clientMutationId: 'round1-missing' })).status).toBe(404);
});

it('enforces the same workspace refusal in the original runtime archive handler', async () => {
  const id = 'round1-archive-original';
  const directory = owned(id, workspaceB);
  const body = { sessionKey: `codex-owned:${id}`, clientMutationId: 'round1-archive-original' };
  expect(await originalRoute('/api/runtime/archive', 'POST', workspaceA, body)).toBe(404);
  expect(existsSync(join(directory, 'session.json'))).toBe(true);
});
