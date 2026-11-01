/** Authored packet metadata, read back through the production state route. */
import type { OrchestratorPacket } from '../../../src/lib/orchestrator/types';

export async function seedSidebarMarkers(repo: string) {
  const { createEmptyOrchestratorMissionState } = await import('../../../src/lib/orchestrator/store');
  const { writeOrchestratorControlPlaneState } = await import('../../../src/lib/orchestrator/control-plane');
  const packets: OrchestratorPacket[] = [{ id: 'sidebar-branch', referenceLabel: 'S1', title: 'Branch fixture', summary: '',
      workspaceTargetPath: repo, branchTarget: 'fixture-branch', runtime: 'pi', orchestratorThreadId: 'thoughts-sidebar-0019',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', releaseState: 'pending', status: 'awaiting_review',
      blockedReason: null, lane: null, review: null, attemptCount: 1 }];
  if (process.argv.includes('--sidebar-merged')) {
    const { markPacketReleased } = await import('../../../src/lib/orchestrator/packet-release-truth');
    markPacketReleased(packets[0], { source: 'approve_and_merge', mergeCommit: 'a'.repeat(40) });
  }
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'sidebar-markers', repoPath: repo,
    packets, updatedAt: new Date().toISOString() });
}
