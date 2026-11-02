/** Authored packet metadata, read back through the production state route. */
import type { OrchestratorPacket } from '../../../src/lib/orchestrator/types';

/** Finish the authored fixture's canonical receipt only when the test releases it. */
export async function completeSidebarParking() {
  const { getWorkspaceSnapshot, transitionWorkspaceSnapshot } = await import('../../../src/lib/worktree/snapshot-state');
  let snapshot = getWorkspaceSnapshot('sidebar-parked-repo', 'sidebar-branch');
  if (!snapshot) throw new Error('Sidebar parking snapshot is missing.');
  const reclaimed = process.argv.includes('--sidebar-parked-unknown') ? null
    : process.argv.includes('--sidebar-parked-zero') ? 0
      : process.argv.includes('--sidebar-parked-negative') ? -1024 : 2_147_483_648;
  for (const state of ['parkable', 'hibernating', 'parked'] as const) {
    snapshot = transitionWorkspaceSnapshot({ repositoryUuid: snapshot.repositoryUuid, packetId: snapshot.packetId,
      transitionId: `sidebar-parked:${state}`, expectedState: snapshot.state, expectedVersion: snapshot.version,
      expectedGeneration: snapshot.snapshotGeneration, toState: state,
      receipt: state === 'parked' && reclaimed !== null ? { reclaimedAvailableBytes: reclaimed } : {} }).record!;
  }
  return snapshot;
}

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
  if (process.argv.includes('--sidebar-parked')) {
    const { createLane, setLaneStatus } = await import('../../../src/lib/lane/registry');
    const { createWorkspaceSnapshot } = await import('../../../src/lib/worktree/snapshot-state');
    const { inboxSubject, mutateInboxSettlement } = await import('../../../src/lib/inbox/store');
    const { readPersistedLlmChat } = await import('../../../src/lib/llm/chat-history-store');
    const packet = packets[0];
    const standalone = process.argv.includes('--sidebar-parked-runtime');
    const thread = standalone ? null : readPersistedLlmChat(packet.orchestratorThreadId!)?.history;
    if (!standalone && !thread?.repoPath) throw new Error('Parked sidebar thread must have a recorded workspace.');
    packet.runtime = standalone ? 'pi-builtin' : 'codex';
    if (standalone) packet.orchestratorThreadId = null;
    const sessionKey = standalone ? 'pi-builtin-owned:grid-runtime' : 'codex:sidebar-parked';
    const workspacePath = `${repo}/absent-packet-checkout`;
    const lane = createLane({ repoPath: repo, worktreePath: workspacePath, branch: packet.branchTarget!,
      runtime: packet.runtime, sessionKey, packetId: packet.id, baseCommit: 'a'.repeat(40) });
    setLaneStatus(lane.id, 'completed');
    packet.lane = { tileId: 'fixture', tabId: sessionKey, repoPath: repo, worktreePath: workspacePath,
      runtime: packet.runtime, sessionKey, laneId: lane.id };
    createWorkspaceSnapshot({ repositoryUuid: 'sidebar-parked-repo', packetId: packet.id,
      laneId: lane.id, originalPath: workspacePath, branch: packet.branchTarget!, baseCommit: 'a'.repeat(40),
      headCommit: 'b'.repeat(40), treeSha: 'c'.repeat(40), recoveryRef: 'refs/o8/workspace-snapshots/sidebar-branch',
      diffFingerprint: 'sidebar-parked-diff', sessionIdentities: [{ kind: 'owned-session', identity: sessionKey }],
      creationId: 'sidebar-parked:create' });
    if (!process.argv.includes('--sidebar-parking-pending')) {
      await completeSidebarParking();
      const subject = standalone ? inboxSubject('runtime', sessionKey, repo)
        : inboxSubject('conversation', packet.orchestratorThreadId!, thread!.repoPath);
      mutateInboxSettlement(subject, 'settle', () => {});
    }
  }
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'sidebar-markers', repoPath: repo,
    packets, updatedAt: new Date().toISOString() });
}
