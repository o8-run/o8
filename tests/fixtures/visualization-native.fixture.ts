import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLane } from '@/lib/lane/registry';
import { mintPacketWorkerToken } from '@/lib/auth/packet-worker-token';
import { mintReadOnlyWorkerToken } from '@/lib/auth/read-only-worker-token';
import { getDataDir } from '@/lib/data-dir-migration';

export async function boot() {
  const directory = getDataDir();
  for (const id of ['packet-a', 'packet-b']) createLane({ repoPath: directory, branch: id, runtime: 'codex', packetId: id });
  const worker = mintPacketWorkerToken('packet-a');
  const readOnly = mintReadOnlyWorkerToken('visualization-fixture');
  const device = 'visualization-fixture-device';
  writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(directory, 'fixture-auth.json'), JSON.stringify({ worker, readOnly, device }));
  await import('../../src/ws-server');
}
