import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let directory: string;
const device = 'task-operator-device';
const worker = 'task-operator-worker';
const spectator = 'task-operator-spectator';
const verbs = ['claim', 'dispatch', 'archive', 'prune'] as const;
function call(path: string, token = server.token, body: unknown = {}, relay = false) {
  return fetch(`${origin}${path}`, { method: 'POST', headers: {
    'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
    'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1',
    ...(relay ? { 'x-o8-relay-forward': '1' } : {}),
  }, body: JSON.stringify(body) });
}
beforeAll(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-native-task-operators-')));
  execFileSync(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
    (async () => {
      const { mkdirSync } = require('node:fs');
      const { execFileSync } = require('node:child_process');
      const repo = ${JSON.stringify('REPO_PLACEHOLDER')};
      mkdirSync(repo);
      execFileSync('git', ['init', '-q', '-b', 'main', repo]);
      execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
      await require('./src/lib/repos/registry.ts').addRepo(repo);
    })().catch(() => process.exit(1));
  `.replace('"REPO_PLACEHOLDER"', JSON.stringify(join(directory, 'repo')))], { env: {
    ...process.env, HOME: directory, CORTEX_IDE_DATA_DIR: directory,
    CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), O8_DATA_DIR: directory,
  } });
  server = await startParityReference({ o8d: true, nativeHttp: true, directory });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
  writeFileSync(join(server.directory, 'broadcast-spectator-tokens'), createHash('sha256').update(spectator).digest('hex'));
}, 120_000);
afterAll(async () => { await server?.stop(); if (directory) rmSync(directory, { recursive: true, force: true }); });
it.each(verbs)('runs %s only for the operator, retaining the actual missing-task response', async verb => {
  for (const relay of [false, true]) {
    for (const [token, status] of [['', 401], ['wrong', 401], [device, 403], [worker, 403], [spectator, 403]] as const) {
      expect((await call(`/api/tasks/missing/${verb}`, token, {}, relay)).status).toBe(status);
    }
    const response = await call(`/api/tasks/missing/${verb}`, server.token, {}, relay);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('not found') });
  }
});
it('persists claim and archive through the native task handlers', async () => {
  const created = await call('/api/tasks', server.token, { title: 'Native task fixture', repoPath: join(server.directory, 'repo'), actor: 'orchestrator' });
  expect(created.status).toBe(201);
  const task = await created.json();
  const id = task.taskId;
  expect(id).toEqual(expect.any(String));
  const claim = await call(`/api/tasks/${id}/claim`);
  expect(claim.status).toBe(200);
  expect(await claim.json()).toMatchObject({ ok: true, taskId: id, action: 'claim' });
  expect((await call(`/api/tasks/${id}/prune`)).status).toBe(409);
  const archived = await call(`/api/tasks/${id}/archive`, server.token, { reason: 'fixture complete' });
  expect(archived.status).toBe(200);
  expect(await archived.json()).toMatchObject({ ok: true, taskId: id, action: 'archive' });
  const state = () => JSON.parse(readFileSync(join(server.directory, 'orchestrator-state.json'), 'utf8')).mission;
  expect(state().packets.find((packet: { id: string }) => packet.id === id).status).toBe('archived');
  const pruned = await call(`/api/tasks/${id}/prune`);
  expect(pruned.status).toBe(200);
  expect(await pruned.json()).toMatchObject({ ok: true, taskId: id, action: 'prune' });
  expect(state().packets.some((packet: { id: string }) => packet.id === id)).toBe(false);
});
