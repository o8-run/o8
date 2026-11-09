import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// Symon Agent-Mode's SSH-transported tool relay over the native transport with Next stopped.
// The handler self-authenticates with a constant-time timingSafeEqual against the ws-token, and
// the path is in no middleware allowlist, so over native the panelGateMiddleware floor also admits
// only the operator ws-token. A body missing callId/tool is rejected (bad_request) BEFORE
// buildTransportedToolEval, so the operator case reaches the handler's own auth + validation
// without driving the remote webview — keeping every case deterministic.
it.skipIf(process.platform === 'win32')('serves the Symon transport tool relay natively, operator-ws-token-only, and refuses the rest (#5243)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-symon-transport-')));
  const device = 'symon-transport-fixture-device-0123456789abcdef';
  const worker = 'symon-transport-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  // Missing callId and tool -> the handler returns bad_request before any webview eval.
  const body = { sessionId: 'symon-transport-fixture-session' };
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const call = (headers: Record<string, string>) => fetch(`${origin}/api/symon/transport/tool`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    // Middleware floor over native (forged loopback markers are inert under the unverified-proxy
    // stamp): only the operator ws-token is admitted; a lesser credential never reaches the relay.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    expect((await call(forged)).status).toBe(401); // anonymous
    expect((await call({ ...forged, authorization: `Bearer ${device}` })).status).toBe(403); // enrolled device
    expect((await call({ ...forged, authorization: `Bearer ${worker}` })).status).toBe(403); // dispatched worker

    // Operator passes the middleware floor AND the handler's constant-time ws-token check, then the
    // request stops at the field validation (bad_request) before buildTransportedToolEval, so no
    // webview eval runs. native == in-process TS.
    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token });
    delete process.env.O8_DATA_DIR;
    const handler = await import('@/app/api/symon/transport/tool/route');
    const operator = { authorization: `Bearer ${server.token}` };
    const native = await call(operator);
    const ts = await handler.POST(new NextRequest('http://127.0.0.1/api/symon/transport/tool', {
      method: 'POST', headers: { 'content-type': 'application/json', ...operator }, body: JSON.stringify(body) }));
    expect([native.status, await native.json()]).toEqual([ts.status, await ts.json()]);
    expect((await (await call(operator)).json())).toMatchObject({ ok: false, error: 'bad_request' });
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
