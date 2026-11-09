import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// The desktop agent bridge's shared agent controls over the native transport with Next
// stopped. The path is in no middleware allowlist, so the panelGateMiddleware floor admits
// only the operator ws-token over native (worker/device 403, anonymous 401); the handler's
// authorize() re-checks the same way. A valid body with no clientMutationId lets the operator
// case reach the handler past authorize() and stop at the clientMutationId guard (400), so no
// real control action is executed. The refusal cases carry a valid body too, so the 401/403 is
// unambiguously the auth gate and not body validation.
it.skipIf(process.platform === 'win32')('serves shared agent controls natively, operator-only, and refuses the rest (#5243)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-agent-control-')));
  const device = 'agent-control-fixture-device-0123456789abcdef';
  const worker = 'agent-control-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const body = { ref: { kind: 'session', id: 'agentctl-fixture-session' }, action: { kind: 'interrupt' } };
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const act = (headers: Record<string, string>) => fetch(`${origin}/api/agent-control/action`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    // Middleware floor over native (forged loopback markers are inert under the unverified-proxy
    // stamp): only the operator ws-token is admitted; every lesser credential is refused before
    // the control plane.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    expect((await act(forged)).status).toBe(401); // anonymous
    expect((await act({ ...forged, authorization: `Bearer ${device}` })).status).toBe(403); // enrolled device
    expect((await act({ ...forged, authorization: `Bearer ${worker}` })).status).toBe(403); // dispatched worker

    // Operator passes the middleware floor AND the handler's authorize(); the request then stops
    // at the clientMutationId guard (400) before any control action runs, native == in-process TS.
    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token });
    delete process.env.O8_DATA_DIR;
    const handler = await import('@/app/api/agent-control/action/route');
    const operator = { authorization: `Bearer ${server.token}` };
    const native = await act(operator);
    const ts = await handler.POST(new NextRequest('http://127.0.0.1/api/agent-control/action', {
      method: 'POST', headers: { 'content-type': 'application/json', ...operator }, body: JSON.stringify(body) }));
    expect([native.status, await native.json()]).toEqual([ts.status, await ts.json()]);
    expect(native.status).toBe(400);
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
