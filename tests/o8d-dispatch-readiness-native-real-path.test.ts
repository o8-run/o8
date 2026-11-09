import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// Every worker launch first probes GET /api/setup/status on the API base. With Next stopped the WS
// listener serves that port, so it must answer the probe or every dispatch is held as
// dispatch_backend_not_ready. The probe runs here as dispatch does, from the real readiness module.
it.skipIf(process.platform === 'win32')('answers the worker-dispatch readiness probe with Next stopped', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-dispatch-readiness-')));
  const device = 'dispatch-readiness-fixture-device-0123456789abcdef';
  const worker = 'dispatch-readiness-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const path = `${origin}/api/setup/status`;

    // The same gate as on Next: operator only, even with forged loopback markers.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    expect((await fetch(path, { headers: forged })).status).toBe(401);
    for (const token of [device, worker]) {
      expect((await fetch(path, { headers: { ...forged, authorization: `Bearer ${token}` } })).status).toBe(403);
    }

    // Dispatch's own probe, pointed at the API port the WS listener now serves.
    Object.assign(process.env, { HOME: directory, CORTEX_IDE_DATA_DIR: directory, O8_API_PORT: new URL(origin).port });
    delete process.env.O8_DATA_DIR;
    vi.resetModules();
    const { isDispatchBackendReady } = await import('@/lib/runtimes/shared/dispatch-readiness');
    const readiness = await isDispatchBackendReady(5_000);
    expect([readiness.ready, readiness.reason, readiness.status]).toEqual([true, 'http_200', 200]);
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
