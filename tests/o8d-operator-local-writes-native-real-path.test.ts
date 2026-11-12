import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// Saved SSH machines, the Local ACP connection, the file card's writes and Workspace Notes writes
// through o8d with Next stopped (#5243). Every request forges the local-address headers a caller
// could send; the credential, not the address, has to decide.
let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let repo: string;
const device = 'operator-local-writes-fixture-device';
const worker = 'operator-local-writes-fixture-worker';
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' };
const refused = [['', 401], ['wrong-token', 401], [device, 403], [worker, 403]] as const;

function call(method: string, path: string, token: string | undefined, body?: unknown, extra: Record<string, string> = {}) {
  const bearer = token === undefined ? server.token : token;
  return fetch(`${origin}${path}`, {
    method,
    headers: { ...forged, ...extra, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  repo = join(server.directory, 'notes-repo');
  mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
}, 120_000);
afterAll(async () => { await server?.stop(); });

it('lists saved SSH machines for the local operator only', async () => {
  const listing = await call('GET', '/api/panel/ssh-machines', undefined);
  expect(listing.status).toBe(200);
  expect(await listing.json()).toEqual({ schema: 'o8/panel/ssh-machines/v1', machines: [] });
  expect((await call('GET', '/api/panel/ssh-machines?machine=missing', undefined)).status).toBe(404);
  expect((await call('POST', '/api/panel/ssh-machines', undefined, { machineId: 'missing', sessionId: 's' })).status).toBe(404);
  // The operator bearer replayed by a same-host relay is a remote caller: the local-only gate holds.
  for (const method of ['GET', 'POST']) {
    const relayed = await call(method, '/api/panel/ssh-machines', undefined, method === 'POST' ? { machineId: 'm', sessionId: 's' } : undefined,
      { 'x-o8-relay-forward': '1' });
    expect(relayed.status, `relayed ${method}`).toBe(403);
    expect((await relayed.json()).error.code).toBe('local_only');
    for (const [token, status] of refused) {
      expect((await call(method, '/api/panel/ssh-machines', token, method === 'POST' ? { machineId: 'm', sessionId: 's' } : undefined)).status,
        `${method} with ${token || 'no bearer'}`).toBe(status);
    }
  }
});

it('saves the Local ACP connection for the operator and refuses every other caller', async () => {
  const file = join(server.directory, 'local-acp.json');
  const connection = { name: 'Fixture agent', command: '/usr/bin/true', args: ['--stdio'], useOpenRouter: false };
  for (const [token, status] of refused) {
    expect((await call('GET', '/api/runtime/acp-connection', token)).status, `GET with ${token || 'no bearer'}`).toBe(status);
    expect((await call('POST', '/api/runtime/acp-connection', token, { connection })).status, `POST with ${token || 'no bearer'}`).toBe(status);
  }
  expect(existsSync(file)).toBe(false);
  expect(await (await call('GET', '/api/runtime/acp-connection', undefined)).json()).toEqual({ connection: null, envLocked: false });
  const saved = await call('POST', '/api/runtime/acp-connection', undefined, { connection });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ connection });
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(connection);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(await (await call('GET', '/api/runtime/acp-connection', undefined)).json()).toEqual({ connection, envLocked: false });
  expect((await call('POST', '/api/runtime/acp-connection', undefined, { connection: { ...connection, command: 'a\nb' } })).status).toBe(400);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(connection);
});

it('saves an existing file from the file card and keeps its guards', async () => {
  const path = join(server.directory, 'card.txt');
  writeFileSync(path, 'before\n');
  for (const [token, status] of refused) {
    expect((await call('PUT', '/api/panel/file-io', token, { path, content: 'stolen\n', force: true })).status, `PUT with ${token || 'no bearer'}`).toBe(status);
    expect((await call('POST', '/api/panel/file-io', token, { action: 'pick' })).status, `POST with ${token || 'no bearer'}`).toBe(status);
  }
  expect(readFileSync(path, 'utf8')).toBe('before\n');
  const stale = await call('PUT', '/api/panel/file-io', undefined, { path, content: 'stale\n', expectedMtimeMs: 1 });
  expect(stale.status).toBe(409);
  expect((await stale.json()).error).toBe('changed-on-disk');
  expect(readFileSync(path, 'utf8')).toBe('before\n');
  const saved = await call('PUT', '/api/panel/file-io', undefined, { path, content: 'after\n', expectedMtimeMs: statSync(path).mtimeMs });
  expect(saved.status).toBe(200);
  expect(readFileSync(path, 'utf8')).toBe('after\n');
  // Edit-existing only, absolute paths only, and no chooser for an unknown action.
  expect((await call('PUT', '/api/panel/file-io', undefined, { path: join(server.directory, 'new.txt'), content: 'x' })).status).toBe(404);
  expect(existsSync(join(server.directory, 'new.txt'))).toBe(false);
  expect((await call('PUT', '/api/panel/file-io', undefined, { path: 'relative.txt', content: 'x' })).status).toBe(400);
  expect((await call('POST', '/api/panel/file-io', undefined, { action: 'open' })).status).toBe(400);
  expect((await call('DELETE', '/api/panel/file-io', undefined, { path })).status).toBe(405);
});

it('writes Workspace Notes for the operator and a paired device, and holds a worker to its own lane', async () => {
  const notes = join(repo, 'o8.md');
  const route = `/api/repo-spec?repoPath=${encodeURIComponent(repo)}`;
  for (const [token, status] of [['', 401], ['wrong-token', 401], [worker, 403]] as const) {
    expect((await call('PUT', route, token, { content: 'stolen' })).status, `PUT with ${token || 'no bearer'}`).toBe(status);
    expect((await call('POST', `${route}&action=comment`, token, { body: 'stolen' })).status, `POST with ${token || 'no bearer'}`).toBe(status);
  }
  expect(existsSync(notes)).toBe(false);
  const saved = await call('PUT', route, undefined, { content: '# Notes\n\nFirst line.\n' });
  expect(saved.status).toBe(200);
  const { contentHash } = await saved.json();
  expect(readFileSync(notes, 'utf8')).toBe('# Notes\n\nFirst line.\n');
  const conflict = await call('PUT', route, undefined, { content: 'lost', expectedHash: 'not-the-hash' });
  expect(conflict.status).toBe(409);
  expect(readFileSync(notes, 'utf8')).toBe('# Notes\n\nFirst line.\n');
  const comment = await call('POST', `${route}&action=comment`, undefined, { body: 'Checked through o8d.' });
  expect(comment.status).toBe(200);
  expect(readFileSync(notes, 'utf8')).toContain('Checked through o8d.');
  // The phone's notes autosave is an existing device grant; it stays one over this transport.
  const phone = await call('PUT', route, device, { content: '# Notes\n\nFrom the phone.\n' });
  expect(phone.status).toBe(200);
  expect(readFileSync(notes, 'utf8')).toBe('# Notes\n\nFrom the phone.\n');
  expect(contentHash).toEqual(expect.any(String));
  const read = await call('GET', route, undefined);
  expect(read.status).toBe(200);
  expect((await read.json()).content).toBe('# Notes\n\nFrom the phone.\n');
});
