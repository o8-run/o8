import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// The shell's restart drain, served by the WS listener with Next stopped. Drain state is SQLite
// keyed by the app boot id, so a drain begun natively must hold back the cloud claims a separate
// TS instance makes on the same database with the same O8_BOOT_ID, and finalize must release the
// leases. Without O8_BOOT_ID the native module refuses, because Next's next claim would undo it.
it.skipIf(process.platform === 'win32')('drains cloud jobs natively for claims made by the other process', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-cloud-drain-')));
  const device = 'cloud-drain-fixture-device-0123456789abcdef';
  const worker = 'cloud-drain-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  const saved = { ...process.env };
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    // The shell gives both processes the same boot id; the WS child inherits it from here.
    Object.assign(process.env, { O8_BOOT_ID: `fixture-boot-${randomUUID()}` });
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const path = '/api/panel/cloud-jobs/drain';
    const operator = { authorization: `Bearer ${server.token}` };
    const send = (method: string, headers: Record<string, string>, body?: unknown) => fetch(`${origin}${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });

    // Operator only over the native transport, even with forged loopback markers.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    for (const [method, body] of [['GET'], ['POST', {}]] as const) {
      expect([method, (await send(method, forged, body)).status]).toEqual([method, 401]);
      for (const token of [device, worker]) {
        expect([method, (await send(method, { ...forged, authorization: `Bearer ${token}` }, body)).status]).toEqual([method, 403]);
      }
    }

    // The other process: the TS queue on the same database and boot id.
    Object.assign(process.env, { HOME: directory, CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db') });
    delete process.env.O8_DATA_DIR;
    const jobs = await import('@/lib/cloud/job-queue');
    const team = 'team_default';
    const launch = (id: string) => ({ cwd: directory, prompt: `fixture ${id}`, packetId: `packet-${id}` });
    jobs.enqueueCloudJob(team, 'job-leased', launch('leased'));
    jobs.enqueueCloudJob(team, 'job-waiting', launch('waiting'));
    jobs.enqueueCloudJob(team, 'job-later', launch('later'));
    expect(jobs.claimNextJob(team, 0, 'fixture-worker')?.id).toBe('job-leased');

    const read = async (response: Response) => [response.status, response.headers.get('cache-control'), await response.json()] as const;
    const status = (draining: boolean, activeLeases: number, pendingJobs: number) =>
      expect.objectContaining({ draining, activeLeases, pendingJobs });

    // Not draining yet: native GET reports what the TS queue reports.
    const [idleStatus, idleCache, idle] = await read(await send('GET', operator));
    expect([idleStatus, idleCache, idle]).toEqual([200, 'no-store, max-age=0', { ok: true, drain: jobs.getJobDrainStatus(team) }]);
    expect(idle.drain).toEqual(status(false, 1, 2));

    // A native drain holds back the other process's claims; the lease it already has stays.
    const [begun, , beginBody] = await read(await send('POST', operator, {}));
    expect([begun, beginBody.ok, beginBody.drain]).toEqual([200, true, status(true, 1, 2)]);
    expect(jobs.claimNextJob(team, 0, 'fixture-worker')).toBeNull();
    expect(jobs.getJobDrainStatus(team)).toEqual(status(true, 1, 2));

    // Finalize releases the lease back to pending, and claims stay held until the restart.
    const [finalized, , finalBody] = await read(await send('POST', operator, { finalize: true }));
    expect([finalized, finalBody.ok, finalBody.drain]).toEqual([200, true, status(true, 0, 3)]);
    expect(jobs.getJob(team, 'job-leased')?.status).toBe('pending');
    expect(jobs.claimNextJob(team, 0, 'fixture-worker')).toBeNull();
    const [, , after] = await read(await send('GET', operator));
    expect(after.drain).toEqual(jobs.getJobDrainStatus(team));

    // A malformed body is refused the same way it is on Next.
    expect((await send('POST', operator, { finalize: 'yes' })).status).toBe(400);

    // Without a shared boot id the native module refuses rather than begin a drain Next would undo.
    delete process.env.O8_BOOT_ID;
    const native = await import('@/lib/cloud/drain-native-route');
    for (const response of [await native.GET(), await native.POST(new Request(`http://127.0.0.1${path}`, { method: 'POST', body: '{}' }))]) {
      const [refused, cache, body] = await read(response);
      expect([refused, cache, body.ok, body.retryable]).toEqual([503, 'no-store, max-age=0', false, true]);
    }
  } finally {
    await server?.stop();
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
