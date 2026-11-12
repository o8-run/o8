import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

const routes = [
  ['POST', '/api/mobile/symon/text-turn', 400], ['DELETE', '/api/mobile/symon/text-turn', 400],
  ['GET', '/api/panel/symon/conversations', 200], ['POST', '/api/panel/symon/conversations/continue', 400],
  ['GET', '/api/panel/symon/conversations/transcript?key=app:missing', 404],
  ['POST', '/api/panel/symon/conversations/record', 400], ['POST', '/api/symon/managed-messages/inbound', 400],
  ['GET', '/api/panel/symon/messages-receiver', 200], ['POST', '/api/panel/symon/messages-receiver', 400],
] as const;
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1', 'x-o8-relay-forward': '1' };

describe.each([true, false])('WS brain owner, o8d=%s', o8d => {
  let server: Awaited<ReturnType<typeof startParityReference>>;
  let origin: string;
  const device = 'brain-fixture-device-credential'; const worker = 'brain-fixture-worker-credential'; const spectator = 'brain-fixture-spectator-credential';
  beforeAll(async () => {
    // Default mode is truly flag-unset as well as o8d=false.
    vi.stubEnv('O8_SYMON_FIXTURE_DEFAULT', o8d ? '0' : '1');
    try { server = await startParityReference({ o8d, nativeHttp: true, preload: './tests/fixtures/symon-brain-native-preload.cjs' }); }
    finally { vi.unstubAllEnvs(); }
    await server.stopNext();
    origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    writeFileSync(join(server.directory, 'worker-token'), worker);
    for (const [file, token] of [['mobile-device-tokens', device], ['broadcast-spectator-tokens', spectator]]) {
      writeFileSync(join(server.directory, file), createHash('sha256').update(token).digest('hex'));
    }
  }, 120_000);
  afterAll(async () => { await server?.stop(); });
  function call(method: string, path: string, token = server.token, body: unknown = {}) {
    return fetch(`${origin}${path}`, { method, headers: { ...forged, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body) });
  }
  it('keeps all route auth grants and shapes with Next stopped, including socket peer stamping', async () => {
    for (const [method, path, status] of routes) {
      expect((await call(method, path)).status, path).toBe(status);
      for (const [token, denied] of [['', 401], ['wrong', 401], [device, 403], [worker, 403], [spectator, 403]] as const) {
        expect((await call(method, path, token)).status, `${path} ${token}`).toBe(denied);
      }
    }
    if (!o8d) expect(existsSync(join(server.directory, 'cortex-owner-marked'))).toBe(false);
  });
  it('records and reads one durable conversation through Next forwarding without a Next brain', async () => {
    vi.stubEnv('O8_NEXT_O8D', undefined); vi.stubEnv('O8_WS_PORT', new URL(origin).port);
    try {
      const record = await import('@/app/api/panel/symon/conversations/record/route');
      expect((await record.POST(new Request(`${origin}/api/panel/symon/conversations/record`, { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'voice:fixture', requestId: 'record-1', entries: [{ role: 'user', text: 'Fixture record' }] }) }))).status).toBe(200);
      const transcript = await call('GET', '/api/panel/symon/conversations/transcript?key=voice:fixture');
      expect((await transcript.json()).transcript).toMatchObject([{ role: 'user', text: 'Fixture record' }]);
      const forwarding = [
        ['POST', '/api/mobile/symon/text-turn', 400, (await import('@/app/api/mobile/symon/text-turn/route')).POST],
        ['DELETE', '/api/mobile/symon/text-turn', 400, (await import('@/app/api/mobile/symon/text-turn/route')).DELETE],
        ['GET', '/api/panel/symon/conversations', 200, (await import('@/app/api/panel/symon/conversations/route')).GET],
        ['POST', '/api/panel/symon/conversations/continue', 400, (await import('@/app/api/panel/symon/conversations/continue/route')).POST],
        ['GET', '/api/panel/symon/conversations/transcript?key=app:missing', 404, (await import('@/app/api/panel/symon/conversations/transcript/route')).GET],
        ['POST', '/api/symon/managed-messages/inbound', 400, (await import('@/app/api/symon/managed-messages/inbound/route')).POST],
      ] as const;
      for (const [method, path, status, handler] of forwarding) {
        const response = await handler(new Request(`${origin}${path}`, { method, headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }));
        expect(response.status).toBe(status);
      }
      expect((globalThis as { __o8SymonBrain?: unknown }).__o8SymonBrain).toBeUndefined();
    } finally { vi.unstubAllEnvs(); }
  });
});

it.each([true, false])('WS alone resumes an unfinished turn once (old owner alive: %s)', async oldOwnerAlive => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-brain-handover-')));
  let holder: ChildProcess | undefined;
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    holder = spawn(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--require=tsx/cjs',
      'tests/fixtures/symon-brain-owner-child.cjs', join(directory, 'symon/durable.sqlite'), 'pending'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    // The pending child sends one receipt only after its input is durable and its model is in flight.
    expect(await Promise.race([once(holder, 'message').then(([message]) => message), once(holder, 'exit').then(() => { throw new Error('Pending brain fixture exited before its receipt'); })])).toMatchObject({ pending: true });
    if (!oldOwnerAlive) { const exited = once(holder, 'exit'); holder.kill('SIGKILL'); await exited; }
    server = await startParityReference({ o8d: false, nativeHttp: true, directory, preload: './tests/fixtures/symon-brain-native-preload.cjs' });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' };
    if (oldOwnerAlive) {
      expect((await fetch(`${origin}/api/panel/symon/conversations`, { headers })).status).toBe(503);
      expect(existsSync(join(directory, 'resume-calls.log'))).toBe(false);
      const exited = once(holder, 'exit'); holder.kill('SIGKILL'); await exited;
    } else {
      expect((await fetch(`${origin}/api/panel/symon/conversations`, { headers })).status).toBe(200);
    }
    const resumed = await fetch(`${origin}/api/panel/symon/conversations/continue`, { method: 'POST', headers,
      body: JSON.stringify({ key: 'app:recovery', requestId: 'recovery-1', text: 'Recover this turn' }) });
    expect(await resumed.json()).toMatchObject({ state: 'done', text: 'Recovered once.' });
    expect(readFileSync(join(directory, 'resume-calls.log'), 'utf8')).toBe('resume\n');
    const transcript = await (await fetch(`${origin}/api/panel/symon/conversations/transcript?key=app:recovery`, { headers })).json();
    expect(transcript.transcript.filter((entry: { role: string }) => entry.role === 'user')).toHaveLength(1);
  } finally {
    if (holder && holder.exitCode === null && holder.signalCode === null) { const exited = once(holder, 'exit'); holder.kill('SIGKILL'); await exited; }
    await server?.stop(); rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
