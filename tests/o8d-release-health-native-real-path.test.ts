import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// The updater's kill-switch check, served by the WS listener with Next stopped.
// It fetches a fixed public manifest, so this test checks only what does not
// depend on the network: the operator gate and the fail-open answer.
it.skipIf(process.platform === 'win32')('serves the release-health check natively with Next stopped, failing open', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-release-health-')));
  const device = 'release-health-fixture-device-0123456789abcdef';
  const worker = 'release-health-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const call = (path: string, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, { headers });

    // Operator only over the native transport, even with forged loopback markers.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    for (const path of ['/api/panel/release-health', '/api/panel/release-health?version=0.1.0']) {
      expect([path, (await call(path, forged)).status]).toEqual([path, 401]);
      for (const token of [device, worker]) {
        expect([path, (await call(path, { ...forged, authorization: `Bearer ${token}` })).status]).toEqual([path, 403]);
      }
    }

    const operator = { authorization: `Bearer ${server.token}` };
    // No version to judge: the production handler fails open without fetching.
    for (const path of ['/api/panel/release-health', '/api/panel/release-health?version=%20']) {
      const response = await call(path, operator);
      expect([path, response.status, response.headers.get('cache-control'), await response.json()])
        .toEqual([path, 200, 'no-store, max-age=0', { pulled: false }]);
    }
    // A version: the manifest answer, or the fail-open answer when it cannot be read.
    const judged = await call('/api/panel/release-health?version=0.1.0', operator);
    expect([judged.status, judged.headers.get('cache-control')]).toEqual([200, 'no-store, max-age=0']);
    expect(typeof (await judged.json() as { pulled: unknown }).pulled).toBe('boolean');
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
