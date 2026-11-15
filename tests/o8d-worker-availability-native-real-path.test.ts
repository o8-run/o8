import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';
let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true, startupTimeoutMs: 120_000 });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  writeFileSync(join(server.directory, 'worker-token'), 'availability-worker');
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update('availability-device').digest('hex'));
}, 180_000);
afterAll(async () => { await server?.stop(); });
it('routes the static availability read to its operator handler', async () => {
  const response = await fetch(`${origin}/api/tasks/worker-availability`, { headers: { authorization: `Bearer ${server.token}` } });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ available: expect.any(Boolean), connectedWorkers: expect.any(Number) });
  for (const [token, status] of [['', 401], ['wrong', 401], ['availability-worker', 403], ['availability-device', 403]] as const) {
    const denied = await fetch(`${origin}/api/tasks/worker-availability`, { headers: { authorization: `Bearer ${token}`, 'x-o8-client-addr': '127.0.0.1', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' } });
    expect(denied.status).toBe(status);
  }
});
