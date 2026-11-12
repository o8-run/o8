import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createLane } from '@/lib/lane/registry';
import { mintPacketWorkerToken, bindPacketWorkerTokenProcess } from '@/lib/auth/packet-worker-token';
import { mintReadOnlyWorkerToken } from '@/lib/auth/read-only-worker-token';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { getDataDir } from '@/lib/data-dir-migration';

export async function boot() {
const directory = getDataDir();
await withLockedState(state => {
  for (const id of ['packet-a', 'packet-b']) {
    state.packets.push({ id, title: id, summary: 'fixture', workspaceTargetPath: directory } as OrchestratorPacket);
    createLane({ repoPath: directory, branch: id, runtime: 'codex', packetId: id });
  }
  return state;
});
const worker = mintPacketWorkerToken('packet-a');
// A harmless owned process provides the real process-marker proof.
const marker = 'worker-task-native.fixture.ts';
const deviceWorker = mintPacketWorkerToken('packet-a', { processMarker: marker });
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  env: { ...process.env, O8_OWNED_RUN_MARKER: marker }, stdio: 'ignore',
});
if (!child.pid) throw new Error('Fixture child failed');
bindPacketWorkerTokenProcess(deviceWorker, { pid: child.pid, processMarker: marker });
const readOnly = mintReadOnlyWorkerToken('fixture-read-only');
const device = 'worker-task-fixture-device';
writeFileSync(join(directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
writeFileSync(join(directory, 'fixture-auth.json'), JSON.stringify({ worker, deviceWorker, readOnly, device }));
await import('../../src/ws-server');

}
