import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// A packet worker's o8 CLI heartbeats, reports, tails its events and reads or widens its scope
// through /api/lanes/[id]/{heartbeat,events,scope}, and reads its lane and diff, on the API port.
// With Next stopped the WS listener serves them all to the worker's bearer: it reaches only its
// own packet's lane, every other credential is refused, and each call changes the persisted lane
// or control-plane packet.
it.skipIf(process.platform === 'win32')('serves the packet worker lane routes natively with Next stopped (#5576)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-lane-worker-')));
  const device = 'lane-worker-fixture-device-0123456789abcdef';
  const legacyWorker = 'lane-worker-fixture-legacy-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), legacyWorker);
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const env = { ...process.env, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory,
      CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token };
    const seeded = await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
      (async () => {
        const { createLane } = require('./src/lib/lane/registry.ts');
        const { mintPacketWorkerToken } = require('./src/lib/auth/packet-worker-token.ts');
        const { withLockedState } = require('./src/lib/orchestrator/control-plane.ts');
        const root = process.env.CORTEX_IDE_DATA_DIR;
        const own = createLane({ repoPath: root, branch: 'fixture-lane-worker', runtime: 'codex', packetId: 'fixture-lane-worker' });
        const other = createLane({ repoPath: root, branch: 'fixture-lane-other', runtime: 'codex', packetId: 'fixture-lane-other' });
        await withLockedState((state) => {
          state.packets.push({ id: 'fixture-lane-worker', title: 'Fixture lane worker', summary: 'fixture', allowedFiles: ['src/fixture.ts'] });
          return state;
        });
        console.log('seed ' + JSON.stringify({ ownId: own.id, otherId: other.id, worker: mintPacketWorkerToken('fixture-lane-worker') }));
        require('./src/lib/db/index.ts').closeDb();
      })();
    `], { env });
    const { ownId, otherId, worker } = JSON.parse(seeded.stdout.split('\n')
      .find(line => line.startsWith('seed '))!.slice(5)) as { ownId: string; otherId: string; worker: string };
    const call = (bearer: string | null, path: string, body?: Record<string, unknown>) => fetch(`${origin}/api/lanes/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

    // The lane reads `o8 status` and `o8 packet diff` call, already served here, admit the worker.
    const ownLane = await call(worker, ownId);
    expect(ownLane.status).toBe(200);
    expect(await ownLane.json()).toMatchObject({ lane: { id: ownId } });
    const listed = await fetch(`${origin}/api/lanes?active=false`, { headers: { authorization: `Bearer ${worker}` } });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { lanes: Array<{ id: string }> }).lanes.map(lane => lane.id)).toEqual([ownId]);

    const heartbeat =await call(worker, `${ownId}/heartbeat`, { heartbeatAt: 1_700_000_000_000 });
    expect(heartbeat.status).toBe(200);
    expect(await heartbeat.json()).toMatchObject({ ok: true, heartbeatAt: 1_700_000_000_000, lane: { id: ownId } });

    const report = await call(worker, `${ownId}/events`, { verb: 'agent_report', event: 'progress', message: 'fixture progress note' });
    expect(report.status).toBe(200);
    expect(await report.json()).toMatchObject({ ok: true, statusChanged: false, event: { verb: 'agent_report' } });
    const tail = await call(worker, `${ownId}/events`);
    expect(tail.status).toBe(200);
    expect(JSON.stringify(await tail.json())).toContain('fixture progress note');

    const scope = await call(worker, `${ownId}/scope`);
    expect(scope.status).toBe(200);
    expect(await scope.json()).toMatchObject({ packetId: 'fixture-lane-worker', allowedPaths: ['src/fixture.ts'] });
    const widened = await call(worker, `${ownId}/scope`, { paths: ['src/extra.ts'], reason: 'fixture needs the extra file' });
    expect(widened.status).toBe(200);
    expect(await widened.json()).toMatchObject({ ok: true, expanded: true, allowedPaths: ['src/fixture.ts', 'src/extra.ts'] });

    // The worker cannot address another packet's lane on any of the routes.
    for (const [path, body] of [
      [otherId, undefined],
      [`${otherId}/diff`, undefined],
      [`${otherId}/heartbeat`, {}],
      [`${otherId}/events`, { verb: 'agent_report', event: 'progress' }],
      [`${otherId}/events`, undefined],
      [`${otherId}/scope`, undefined],
      [`${otherId}/scope`, { paths: ['src/other.ts'], reason: 'fixture reaches across packets' }],
    ] as const) {
      const refused = await call(worker, path, body);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: 'worker_packet_mismatch' } });
    }
    // A worker credential bound to no packet keeps panel auth; a loopback caller passes it, as under
    // Next, and the route then refuses the unbound credential.
    for (const [path, body] of [[`${ownId}/heartbeat`, {}], [ownId, undefined]] as const) {
      const refused = await call(legacyWorker, path, body);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: 'worker_packet_mismatch' } });
    }
    expect((await call(null, `${ownId}/heartbeat`, {})).status).toBe(401);
    expect((await call(device, `${ownId}/heartbeat`, {})).status).toBe(403);
    expect((await call(device, `${ownId}/scope`)).status).toBe(403);

    // The persisted lane, read back through the native lane read.
    const lane = await (await call(server.token, ownId)).json() as { lane: { lastHeartbeatAt: number; lastEventLabel: string } };
    expect(lane.lane).toMatchObject({ lastHeartbeatAt: 1_700_000_000_000, lastEventLabel: 'progress' });
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
