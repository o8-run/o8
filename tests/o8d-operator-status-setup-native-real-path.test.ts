import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// Each process stamps its own CLI sign-in probe time; nothing else may differ.
function stable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, entry) => key === 'checkedAt' && typeof entry === 'number' ? 0 : entry);
}

// The o8 MCP server's operator status and agent setup, served by the WS listener
// with Next stopped: the same answers as the TS handlers in this process on the
// same data directory. Setup writes are checked only as refusals here.
it.skipIf(process.platform === 'win32')('serves operator status and agent setup natively with the TS answer', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-operator-status-')));
  const device = 'operator-status-fixture-device-0123456789abcdef';
  const worker = 'operator-status-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const operator = { authorization: `Bearer ${server.token}` };
    const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) => fetch(`${origin}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });

    // Operator only over the native transport, even with forged loopback markers.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    for (const [method, path, body] of [['GET', '/api/operator/status'], ['GET', '/api/setup/agent'], ['POST', '/api/setup/agent', {}]] as const) {
      expect([method, path, (await send(method, path, forged, body)).status]).toEqual([method, path, 401]);
      for (const token of [device, worker]) {
        expect([method, path, (await send(method, path, { ...forged, authorization: `Bearer ${token}` }, body)).status]).toEqual([method, path, 403]);
      }
    }

    Object.assign(process.env, { HOME: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token });
    delete process.env.O8_DATA_DIR;
    const status = await import('@/app/api/operator/status/route');
    const setup = await import('@/app/api/setup/agent/route');
    const local = (method: string, path: string, body?: unknown) => new NextRequest(`http://127.0.0.1${path}`, { method,
      headers: { ...operator, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

    for (const path of ['/api/operator/status', '/api/operator/status?sessionKey=fixture-missing']) {
      const native = await send('GET', path, operator);
      const ts = await status.GET(local('GET', path));
      expect([path, native.status]).toEqual([path, ts.status]);
      expect(stable(await native.json())).toEqual(stable(await ts.json()));
    }

    for (const path of ['/api/setup/agent', '/api/setup/agent?view=request']) {
      const native = await send('GET', path, operator);
      const ts = await setup.GET(local('GET', path));
      expect([path, native.status, native.headers.get('cache-control')]).toEqual([path, ts.status, ts.headers.get('cache-control')]);
      const body = await native.json() as { schema?: string; runtimes?: unknown[]; request?: unknown };
      if (path.endsWith('request')) expect(body).toEqual({ request: null });
      else expect([body.schema, (body.runtimes ?? []).length > 0]).toEqual(['o8/setup/v1', true]);
      expect(stable(body)).toEqual(stable(await ts.json()));
    }

    // Refused writes match without changing the operator's setup.
    for (const body of [[], { leadModel: 7 }]) {
      const native = await send('POST', '/api/setup/agent', operator, body);
      const ts = await setup.POST(local('POST', '/api/setup/agent', body));
      expect([JSON.stringify(body), native.status, await native.json()]).toEqual([JSON.stringify(body), ts.status, await ts.json()]);
    }
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
