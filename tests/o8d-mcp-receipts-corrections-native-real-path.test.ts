import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// The o8 MCP server's packet receipts, worker corrections and PR stack, served by
// the WS listener with Next stopped: the same answers as the TS handlers in this
// process on the same data directory. No call here reaches GitHub or a worker.
it.skipIf(process.platform === 'win32')('serves packet receipts, worker corrections and the PR stack natively with the TS answer', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-mcp-receipts-')));
  const device = 'mcp-receipts-fixture-device-0123456789abcdef';
  const worker = 'mcp-receipts-fixture-worker-0123456789abcdef';
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
    for (const [method, path, body] of [['GET', '/api/orchestrator/receipts?packetId=fixture'], ['POST', '/api/orchestrator/receipts', {}],
      ['GET', '/api/orchestrator/worker-corrections'], ['POST', '/api/orchestrator/worker-corrections', {}],
      ['GET', '/api/panel/pr-stack?repo=fixture/repo&number=1']] as const) {
      expect([method, path, (await send(method, path, forged, body)).status]).toEqual([method, path, 401]);
      for (const token of [device, worker]) {
        expect([method, path, (await send(method, path, { ...forged, authorization: `Bearer ${token}` }, body)).status]).toEqual([method, path, 403]);
      }
    }

    Object.assign(process.env, { CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token });
    delete process.env.O8_DATA_DIR;
    const receipts = await import('@/app/api/orchestrator/receipts/route');
    const corrections = await import('@/app/api/orchestrator/worker-corrections/route');
    const stack = await import('@/app/api/panel/pr-stack/route');
    const handlers: Record<string, Record<string, unknown>> = {
      '/api/orchestrator/receipts': receipts, '/api/orchestrator/worker-corrections': corrections, '/api/panel/pr-stack': stack,
    };
    const target = `repoPath=${encodeURIComponent(directory)}&threadId=thoughts-fixture`;
    const cases: Array<[method: string, path: string, body?: unknown]> = [
      ['GET', '/api/orchestrator/receipts?packetId=fixture-missing'],
      ['GET', '/api/orchestrator/receipts'],
      ['POST', '/api/orchestrator/receipts', { packetId: 'fixture-missing' }],
      ['POST', '/api/orchestrator/receipts', {}],
      ['GET', `/api/orchestrator/worker-corrections?${target}`],
      ['GET', '/api/orchestrator/worker-corrections'],
      ['POST', '/api/orchestrator/worker-corrections', { id: 'fixture-correction', repoPath: directory, threadId: 'thoughts-fixture' }],
      // Refused before any GitHub read.
      ['GET', '/api/panel/pr-stack?repo=not-a-repo&number=1'],
      ['GET', '/api/panel/pr-stack?repo=fixture/repo&number=0'],
    ];
    const statuses: number[] = [];
    for (const [method, path, body] of cases) {
      const native = await send(method, path, operator, body);
      const handler = handlers[new URL(path, 'http://127.0.0.1').pathname]![method] as (request: NextRequest) => Promise<Response>;
      const ts = await handler(new NextRequest(`http://127.0.0.1${path}`, { method,
        headers: { ...operator, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
      expect([method, path, native.status, await native.json()]).toEqual([method, path, ts.status, await ts.json()]);
      statuses.push(native.status);
    }
    // The cases reach the handlers past their auth: receipts read SQLite, corrections read the saved chat.
    expect(statuses).toEqual([200, 400, 404, 400, 409, 409, 409, 400, 400]);
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
