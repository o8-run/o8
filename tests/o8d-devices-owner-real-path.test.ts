import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// Build first: cargo build --locked --manifest-path crates/o8d/Cargo.toml --features experimental-ws
it.skipIf(process.platform === 'win32')('serves device controls with one WS manager and the operator gate', async () => {
  const binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/debug/o8d');
  if (!existsSync(binary)) await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-ws']);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-devices-owner-')));
  const device = 'devices-fixture-device-0123456789abcdef';
  const worker = 'devices-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ o8d: true, nativeHttp: true, directory, startupTimeoutMs: 120_000,
      binary });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    expect((await (await fetch(`${origin}/health`)).json()).delivery.transport).toBe('o8d');
    const path = '/api/panel/devices';
    const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1' };
    const call = (method: string, headers: Record<string, string>) => fetch(`${origin}${path}`, {
      method, headers: { 'content-type': 'application/json', ...headers },
      ...(method === 'POST' ? { body: JSON.stringify({ action: 'refresh' }) } : {}),
    });
    for (const method of ['GET', 'POST']) {
      for (const token of ['', 'wrong', device, worker]) {
        expect((await call(method, { ...forged, ...(token ? { authorization: `Bearer ${token}` } : {}) })).status)
          .toBe(token === device || token === worker ? 403 : 401);
      }
      // Model a remote caller relayed from this host. Peer stamping must beat forged headers.
      expect((await call(method, { ...forged, 'x-o8-relay-forward': '1', authorization: `Bearer ${worker}` })).status).toBe(403);
      const result = await call(method, { authorization: `Bearer ${server.token}` });
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ phase: 'idle', tools: { hub: { installed: false } }, platforms: {
        ios: { available: expect.any(Boolean) }, android: { available: expect.any(Boolean) },
      }, controllers: [], controllerRevision: expect.any(Number) });
    }
    Object.assign(process.env, { O8_NEXT_O8D: '1', O8_API_PORT: '1', O8_WS_PORT: new URL(origin).port });
    const next = await import('@/app/api/panel/devices/route');
    const localState = globalThis as typeof globalThis & { __o8DeviceManager?: unknown };
    expect(localState.__o8DeviceManager).toBeUndefined();
    for (const method of ['GET', 'POST'] as const) {
      const response = await next[method](new Request(`http://127.0.0.1${path}`, { method,
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', 'x-o8-client-addr': '127.0.0.1', host: '127.0.0.1' },
        ...(method === 'POST' ? { body: '{"action":"refresh"}' } : {}) }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ phase: 'idle', controllers: [] });
    }
    expect(localState.__o8DeviceManager).toBeUndefined();
    // The owner's hand-off route accepts only the local operator credential.
    const owner = (headers: Record<string, string>) => fetch(`${origin}/api/devices/owner`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ args: { action: 'status' } }) });
    for (const token of ['', 'wrong', device, worker]) {
      expect((await owner({ ...forged, ...(token ? { authorization: `Bearer ${token}` } : {}) })).status).toBe(token === device || token === worker ? 403 : 401);
    }
    expect((await owner({ ...forged, 'x-o8-relay-forward': '1', authorization: `Bearer ${server.token}` })).status).toBe(403);
    expect((await (await owner({ authorization: `Bearer ${server.token}` })).json()).result.content[0].type).toBe('text');
    // Operator MCP and the worker device endpoint run in Next; their device tool
    // must reach the WS owner too, never a second idle manager here.
    const { getDataDir } = await import('@/lib/data-dir-migration');
    const tokenPath = join(getDataDir(), 'ws-token');
    const previousToken = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8') : null;
    writeFileSync(tokenPath, server.token, { mode: 0o600 });
    try {
      const { handleDevice } = await import('@/lib/mcp/operator-handlers/devices');
      const text = (result: Awaited<ReturnType<typeof handleDevice>>) => result.content.map(part => part.type === 'text' ? part.text : '').join('');
      const status = await handleDevice({ action: 'status' });
      expect(JSON.parse(text(status))).toMatchObject({ devices: [], controllers: [] });
      await expect(handleDevice({ action: 'acquire', deviceId: 'fixture-device' }, { worker: 'fixture-worker', conversation: 'fixture-thread', pid: process.pid }))
        .rejects.toMatchObject({ code: 'device_unavailable', status: 409 });
      expect(localState.__o8DeviceManager).toBeUndefined();
    } finally {
      if (previousToken === null) rmSync(tokenPath, { force: true }); else writeFileSync(tokenPath, previousToken);
    }
  } finally {
    await server?.stop();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
