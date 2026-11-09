import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// The o8 MCP and CLI lease tools call /api/leases on the API port. With Next stopped the WS
// listener serves it with the same rules: the operator takes and releases leases, a packet worker
// reads them but cannot mutate without a proved process binding or touch a governed namespace,
// and other credentials are refused.
it.skipIf(process.platform === 'win32')('serves resource leases natively with Next stopped (#5576)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-leases-')));
  const device = 'leases-fixture-device-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const env = { ...process.env, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory,
      CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token };
    const seeded = await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
      const { mintPacketWorkerToken } = require('./src/lib/auth/packet-worker-token.ts');
      console.log('seed ' + mintPacketWorkerToken('fixture-leases-worker'));
      require('./src/lib/db/index.ts').closeDb();
    `], { env });
    const packetWorker = seeded.stdout.split('\n').find(line => line.startsWith('seed '))!.slice(5);
    const call = (bearer: string | null, body?: Record<string, unknown>, query = '') => fetch(`${origin}/api/leases${query}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const resource = 'fixture:native-lease';
    const owner = { id: 'fixture-owner', label: 'Fixture owner', pid: process.pid };
    const claimToken = 'fixture-lease-claim-value-0123456789';

    const acquired = await call(server.token, { action: 'acquire', resource, owner, claimToken, ttlMs: 60_000 });
    expect(acquired.status).toBe(200);
    expect(await acquired.json()).toMatchObject({ ok: true, result: { state: 'acquired' } });
    const contender = await call(server.token, { action: 'acquire', resource,
      owner: { ...owner, id: 'fixture-contender' }, claimToken: 'fixture-contender-claim-0123456789' });
    expect(contender.status).toBe(409);

    // A packet worker reads the lease, but its mutations are refused by the handler.
    const status = await call(packetWorker, undefined, `?resource=${encodeURIComponent(resource)}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ ok: true, lease: { resource } });
    const unbound = await call(packetWorker, { action: 'acquire', resource: 'fixture:worker-lease', owner, claimToken });
    expect(unbound.status).toBe(409);
    expect(await unbound.json()).toMatchObject({ error: { code: 'worker_process_unbound' } });
    const governed = await call(packetWorker, { action: 'acquire', resource: 'repo-tree:fixture', owner, claimToken });
    expect(governed.status).toBe(409);
    expect(await governed.json()).toMatchObject({ result: { reason: 'reserved_namespace' } });

    expect((await call(null)).status).toBe(401);
    expect((await call(device)).status).toBe(403);

    const released = await call(server.token, { action: 'release', resource, owner, claimToken });
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ ok: true });
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
