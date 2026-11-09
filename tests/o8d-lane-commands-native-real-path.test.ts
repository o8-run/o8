import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

// o8 next sends its lane commands (stop, archive, create_pr, merge) to POST /api/lanes. With Next
// stopped the WS listener must run them itself. The gate grants a worker GET only on this path, so
// every lesser credential is refused before the dispatcher, and the operator's commands change
// the persisted lane.
it.skipIf(process.platform === 'win32')('runs lane commands natively with Next stopped, operator-only (#5576)', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-lane-commands-')));
  const device = 'lane-commands-fixture-device-0123456789abcdef';
  const worker = 'lane-commands-fixture-worker-0123456789abcdef';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'worker-token'), worker);
  let server: Awaited<ReturnType<typeof startParityReference>> | undefined;
  try {
    server = await startParityReference({ nativeHttp: true, directory, startupTimeoutMs: 120_000 });
    await server.stopNext();
    const origin = server.url.replace('ws:', 'http:').replace('/ws', '');
    const env = { ...process.env, O8_DATA_DIR: directory, CORTEX_IDE_DATA_DIR: directory,
      CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'), WS_TOKEN: server.token };
    const seeded = await promisify(execFile)(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', '--eval', `
      const { createLane } = require('./src/lib/lane/registry.ts');
      const { mintPacketWorkerToken } = require('./src/lib/auth/packet-worker-token.ts');
      const root = process.env.CORTEX_IDE_DATA_DIR;
      const lane = createLane({ repoPath: root, branch: 'fixture-lane-commands', runtime: 'codex' });
      const owned = createLane({ repoPath: root, branch: 'fixture-lane-owned', runtime: 'codex', packetId: 'fixture-lane-commands' });
      console.log('seed ' + JSON.stringify({ laneId: lane.id, ownedId: owned.id, packetToken: mintPacketWorkerToken(owned.packetId) }));
      require('./src/lib/db/index.ts').closeDb();
    `], { env });
    const { laneId, ownedId, packetToken } = JSON.parse(seeded.stdout.split('\n')
      .find(line => line.startsWith('seed '))!.slice(5)) as { laneId: string; ownedId: string; packetToken: string };
    const command = (body: Record<string, unknown>, headers: Record<string, string> = {}) => fetch(`${origin}/api/lanes`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    // Every lesser credential is refused, with local markers forged as well.
    const forged = { 'x-o8-client-addr': '127.0.0.1', 'x-o8d-peer': '127.0.0.1' };
    expect((await command({ verb: 'stop', laneId }, forged)).status).toBe(401);
    expect((await command({ verb: 'stop', laneId }, { ...forged, authorization: `Bearer ${device}` })).status).toBe(403);
    expect((await command({ verb: 'stop', laneId }, { ...forged, authorization: `Bearer ${worker}` })).status).toBe(403);
    // A packet worker is refused at the gate even on its own lane.
    const own = await command({ verb: 'archive', laneId: ownedId }, { ...forged, authorization: `Bearer ${packetToken}` });
    expect(own.status).toBe(403);
    expect(await own.json()).toMatchObject({ error: 'Worker token is not authorized for this endpoint.' });

    const operator = { authorization: `Bearer ${server.token}` };
    const stopped = await command({ verb: 'stop', laneId, actor: 'user' }, operator);
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ ok: true, laneId, lane: { status: 'paused' } });
    const archived = await command({ verb: 'archive', laneId }, operator);
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ ok: true, laneId, lane: { status: 'archived' } });

    // The persisted lane, read back through the native lane read; the refused archive left its lane alone.
    const lanes = await (await fetch(`${origin}/api/lanes?active=false`, { headers: operator })).json() as { lanes: Array<{ id: string; status: string }> };
    expect(lanes.lanes.find(lane => lane.id === laneId)?.status).toBe('archived');
    const untouched = lanes.lanes.find(lane => lane.id === ownedId);
    expect(untouched).toBeDefined();
    expect(untouched?.status).not.toBe('archived');
  } finally {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 180_000);
