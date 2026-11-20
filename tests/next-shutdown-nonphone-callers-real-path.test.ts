import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
import { seedSessionFixture } from '../scripts/o8d/parity';


const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-nonphone-owners-')));
let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let account: Server;
const accountCalls: Array<{ path: string; body: Record<string, unknown> }> = [];
let device: string;
const worker = 'fixture-owner-worker-0123456789abcdef';
const previewPath = '/api/panel/link-preview?url=https%3A%2F%2Fgithub.com%2Ffixture%2Fpreview';

beforeAll(async () => {
  await seedSessionFixture(directory);
  const repo = join(directory, 'fixture-repo');
  writeFileSync(join(directory, 'repos.json'), JSON.stringify({ version: 1, repos: [{
    id: 'owner-fixture', name: 'Owner fixture', localPath: repo, addedAt: '2026-11-17T00:00:00Z',
  }] }));
  writeFileSync(join(directory, 'workspace-lifecycle.json'), JSON.stringify({ version: 1, records: [{
    id: 'stored-workspace', repo: 'Owner fixture', repoPath: repo, workspacePath: repo, branch: 'main',
    workspaceStatus: 'done', archivedAt: '2026-11-17T00:00:00Z', firstSeenAt: '2026-11-17T00:00:00Z', lastSeenAt: '2026-11-17T00:00:00Z',
    lastActivityAt: '2026-11-17T00:00:00Z', unreadCount: 1,
  }] }));
  writeFileSync(join(directory, 'worker-token'), worker);
  const seeded = await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '-e',
    "import('./src/lib/mobile/device-registry.ts').then(m => { const api = m.default ?? m; console.log('DEVICE:' + api.enrollDevice({ identityPublicKey: 'fixture-owner-key' }).deviceToken); })"],
  { env: { ...process.env, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), HOME: directory, NODE_ENV: 'test' }, timeout: 30_000 });
  device = /DEVICE:([a-f0-9]+)/.exec(seeded.stdout)![1];
  const bin = join(directory, 'bin'); mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/bin/sh\nif [ "$1" = api ] && [ "$2" = repos/fixture/preview ]; then\n  echo preview >> "$(dirname "$0")/../gh-calls"\n  printf \'{"full_name":"fixture/preview","description":"owned preview","stargazers_count":7,"forks_count":2,"language":"TypeScript"}\\n\'\nelse\n  exit 1\nfi\n');
  chmodSync(gh, 0o700);
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
  account = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    accountCalls.push({ path: request.url!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    const payload = request.url?.endsWith('/poll') ? { status: 'pending' } : {
      deviceCode: 'fixture-one-time-secret', userCode: 'FIXTURE', verificationUrl: 'https://fixture.invalid/approve',
      expiresAt: new Date(Date.now() + 300_000).toISOString(), interval: 5,
    };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  });
  await new Promise<void>(resolve => account.listen(0, '127.0.0.1', resolve));
  const accountAddress = account.address();
  if (!accountAddress || typeof accountAddress === 'string') throw new Error('Missing account fixture port');
  vi.stubEnv('O8_PROXY_URL', `http://127.0.0.1:${accountAddress.port}`);
  server = await startParityReference({ directory, nativeHttp: true, apiOnListener: true });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
}, 90_000);

afterAll(async () => { await server?.stop(); if (account?.listening) { account.closeAllConnections(); await new Promise<void>(resolve => account.close(() => resolve())); } vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

const auth = () => ({ authorization: `Bearer ${server.token}` });
it('serves the remaining live desktop, CLI and worker routes without Next and retains their bearer gates', async () => {
  const paths = ['/api/panel/link-preview', '/api/panel/workspaces', '/api/orchestrator/delegate'];
  for (const path of paths) {
    for (const token of ['', 'wrong', device, worker]) {
      expect((await fetch(origin + path, { headers: { authorization: `Bearer ${token}` } })).status, path)
        .toBe(token === device || token === worker ? 403 : 401);
    }
  }
  const preview = await fetch(origin + previewPath, { headers: auth() });
  expect(preview.status).toBe(200);
  expect(await preview.json()).toMatchObject({ ok: true, preview: { repo: 'fixture/preview', stars: 7 } });
  const workspaces = await fetch(origin + '/api/panel/workspaces', { headers: auth() });
  expect(workspaces.status).toBe(200);
  expect(await workspaces.json()).toMatchObject({ lifecycle: { records: [{ id: 'stored-workspace' }] } });
  const catalog = await fetch(origin + '/api/orchestrator/delegate', { headers: auth() });
  expect(catalog.status).toBe(200);
  expect(await catalog.json()).toMatchObject({ workers: expect.any(Array) });
  for (const path of ['/api/panel/auth/device/link', '/api/browser/engine/capture']) {
    for (const token of ['', 'wrong', device, worker]) {
      expect((await fetch(origin + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).status, path)
        .toBe(token === device || token === worker ? 403 : 401);
    }
  }
  const link = '/api/panel/auth/device/link';
  const post = (path: string, body: unknown, extra: Record<string, string> = {}) => fetch(origin + path, {
    method: 'POST', headers: { ...auth(), 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
  });
  expect((await post(link, { action: 'start' })).status).toBe(200);
  const polled = await post(link, { action: 'poll' });
  expect(polled.status).toBe(200);
  expect(await polled.json()).toMatchObject({ ok: true, status: 'pending' });
  expect(accountCalls.find(call => call.path === '/account/device/link/poll')?.body.deviceCode).toBe('fixture-one-time-secret');
  expect((await post(link, { action: 'poll' }, { 'x-o8-relay-forward': '1', 'x-o8-client-addr': '127.0.0.1' })).status).toBe(403);
  expect((await post('/api/browser/engine/capture', {})).status).toBe(400);
}, 60_000);
