/** Authored packet metadata, read back through the production state route. */
export async function seedSidebarMarkers(repo: string) {
  const { createEmptyOrchestratorMissionState } = await import('../../../src/lib/orchestrator/store');
  const { writeOrchestratorControlPlaneState } = await import('../../../src/lib/orchestrator/control-plane');
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'sidebar-markers', repoPath: repo,
    packets: [{ id: 'sidebar-branch', referenceLabel: 'S1', title: 'Branch fixture', summary: '',
      workspaceTargetPath: repo, branchTarget: 'fixture-branch', runtime: 'pi', orchestratorThreadId: 'thoughts-sidebar-0019',
      dependencyLabels: [], dependencyPacketIds: [], queueState: 'held', releaseState: 'pending', status: 'awaiting_review',
      blockedReason: null, lane: null, review: null, attemptCount: 1 }], updatedAt: new Date().toISOString() });
}
