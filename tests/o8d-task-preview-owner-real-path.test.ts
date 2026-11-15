import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// Build first: cargo build --locked --manifest-path crates/o8d/Cargo.toml --features experimental-ws
it.skipIf(process.platform === 'win32')('serves task preview with operator auth and closes previews in the WS owner', async () => {
  const binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/debug/o8d');
  if (!existsSync(binary)) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-task-preview-owner-')));
  const device = 'preview-fixture-device-0123456789abcdef';
  const worker = 'preview-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  // Seed only owned close callbacks, not the handler or its auth. The real preview
  // module must find these in the WS process for native and forwarded DELETEs.
  const log = join(directory, 'closed.jsonl');
  const preload = join(directory, 'preview-owner.cjs');
  writeFileSync(preload, `const fs = require('node:fs');
    globalThis.__o8PreviewServers = new Map(['native', 'forwarded'].map(id => [id, stop => {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ id, stop, pid: process.pid }) + '\\n');
      globalThis.__o8PreviewServers.delete(id);
    }]));`);
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ o8d: true, nativeHttp: true, directory, preload, startupTimeoutMs: 120_000,
      binary });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    expect((await (await fetch(`${origin}/health`)).json()).delivery.transport).toBe('o8d');
    const path = '/api/tasks/fixture-task/preview';
    const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' };
    const call = (method: string, headers: Record<string, string>, body: object = {}) => fetch(`${origin}${path}`, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    for (const method of ['POST', 'DELETE']) {
      for (const token of ['', 'wrong', device, worker]) {
        expect((await call(method, { ...forged, ...(token ? { authorization: `Bearer ${token}` } : {}) })).status)
          .toBe(token === device || token === worker ? 403 : 401);
      }
      expect((await call(method, { ...forged, 'x-o8-relay-forward': '1', authorization: `Bearer ${worker}` })).status).toBe(403);
    }
    const operator = { authorization: `Bearer ${server.token}` };
    const invalid = await call('POST', operator);
    expect([invalid.status, await invalid.json()]).toEqual([400, { error: 'Task, job and attempt are required.' }]);
    const missing = await call('POST', operator, { jobId: 'missing', attempt: 1 });
    expect([missing.status, await missing.json()]).toEqual([409, { error: 'No healthy preview belongs to this current attempt. Refresh the task.' }]);
    const deleted = await call('DELETE', operator, { id: 'native', keepService: true });
    expect([deleted.status, await deleted.json()]).toEqual([200, { ok: true }]);
    Object.assign(process.env, { O8_NEXT_O8D: '1', O8_API_PORT: '1', O8_WS_PORT: new URL(origin).port });
    const localState = globalThis as typeof globalThis & { __o8PreviewServers?: unknown };
    expect(localState.__o8PreviewServers).toBeUndefined();
    const next = await import('@/app/api/tasks/[taskId]/preview/route');
    for (const method of ['POST', 'DELETE'] as const) {
      const response = await next[method](new NextRequest(`http://127.0.0.1${path}`, { method,
        headers: { ...operator, 'content-type': 'application/json', host: '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' },
        body: JSON.stringify(method === 'DELETE' ? { id: 'forwarded', keepService: true } : {}) }),
      { params: Promise.resolve({ taskId: 'fixture-task' }) });
      expect(response.status).toBe(method === 'POST' ? 400 : 200);
    }
    expect(localState.__o8PreviewServers).toBeUndefined();
    expect(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))).toEqual([
      { id: 'native', stop: false, pid: server.pid }, { id: 'forwarded', stop: false, pid: server.pid },
    ]);
  } finally {
    await server?.stop();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
