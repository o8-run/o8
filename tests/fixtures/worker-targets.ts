import type { OrchestratorPacket } from '@/lib/orchestrator/types';

export async function seedWorkerTargets(directory: string) {
  const { createLane, updateLane } = await import('@/lib/lane/registry');
  const { withLockedState } = await import('@/lib/orchestrator/control-plane');
  const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
  await withLockedState(state => {
    for (const id of ['packet-a', 'packet-b', 'packet-no-pr']) state.packets.push({
      id, title: id, summary: 'fixture', status: 'running', workspaceTargetPath: directory,
    } as OrchestratorPacket);
    return state;
  });
  const own = createLane({ repoPath: directory, branch: 'a', runtime: 'codex', packetId: 'packet-a' });
  const other = createLane({ repoPath: directory, branch: 'b', runtime: 'codex', packetId: 'packet-b' });
  updateLane(own.id, { prNumber: 11, outcomeNote: 'Pull request opened: https://github.com/fixture/own/pull/11' });
  updateLane(other.id, { prNumber: 22, outcomeNote: 'Pull request opened: https://github.com/fixture/other/pull/22' });
  return { own: own.id, other: other.id, worker: mintPacketWorkerToken('packet-a'), noPr: mintPacketWorkerToken('packet-no-pr') };
}
