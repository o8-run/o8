import { join } from 'node:path';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export async function seedWorkerTargets(directory: string) {
  const { createLane, updateLane } = await import('@/lib/lane/registry');
  const { withLockedState } = await import('@/lib/orchestrator/control-plane');
  const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
  await withLockedState(state => {
    for (const id of ['packet-a', 'packet-b', 'packet-no-pr', 'packet-merged']) state.packets.push({
      id, title: id, summary: 'fixture', status: 'running', workspaceTargetPath: join(directory, id), orchestratorThreadId: `thread-${id}`,
    } as OrchestratorPacket);
    return state;
  });
  const own = createLane({ repoPath: directory, branch: 'a', runtime: 'codex', packetId: 'packet-a' });
  const other = createLane({ repoPath: directory, branch: 'b', runtime: 'codex', packetId: 'packet-b' });
  updateLane(own.id, { prNumber: 11, outcomeNote: 'Pull request opened: https://github.com/fixture/own/pull/11' });
  updateLane(other.id, { prNumber: 22, outcomeNote: 'Pull request opened: https://github.com/fixture/other/pull/22' });
  // A lane whose PR number survives after merge settlement replaced the opened note.
  const merged = createLane({ repoPath: directory, branch: 'c', runtime: 'codex', packetId: 'packet-merged' });
  updateLane(merged.id, { prNumber: 33, outcomeNote: 'Merged' });
  return { own: own.id, other: other.id, merged: merged.id, worker: mintPacketWorkerToken('packet-a'),
    noPr: mintPacketWorkerToken('packet-no-pr'), mergedWorker: mintPacketWorkerToken('packet-merged') };
}
