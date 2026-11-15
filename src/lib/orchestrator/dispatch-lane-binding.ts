import { getLane } from '@/lib/lane/registry';
import {
  MCP_DISPATCH_TILE_SENTINEL,
  type OrchestratorLaneBinding,
  type OrchestratorPacket,
  type WorkerRouting,
} from '@/lib/orchestrator/types';

/**
 * The lane binding a dispatch stores on its packet. Stop verifies a lane against this stored owner
 * (packet-stop-hold.ts), so mission dispatch and the delegate route both write it from here. Kept out
 * of scheduling.ts so a caller does not load the whole scheduler for it.
 */
export function createLaneBinding(
  packet: OrchestratorPacket,
  laneId: string,
  sessionKey?: string | null,
  workerRouting?: WorkerRouting,
  dependencyMaterializationMode?: 'native' | 'image' | null,
): OrchestratorLaneBinding {
  // Read the SQLite lane row so the binding reflects what `updateLane` already
  // persisted (most importantly `worktreePath`, written in commands.ts during
  // `bind_worktree` / `launch_session`). Without this, MCP-dispatched packets
  // saw `worktreePath: null` on the binding even though a real worktree
  // existed, and the no_changes_produced check inspected the wrong tree.
  // tileId/tabId do not live on the lane row, but writing empty strings here
  // made every downstream truthy check (`hasInteractiveLane`, `hasLaneBinding`)
  // hide the Focus button for MCP-dispatched packets (#1113). The sentinel
  // keeps those checks truthy and is filtered out by the workspace tile-handle
  // lookup, so this never collides with a real workspace binding.
  const laneRow = getLane(laneId);
  return {
    tileId: MCP_DISPATCH_TILE_SENTINEL,
    tabId: MCP_DISPATCH_TILE_SENTINEL,
    repoPath: packet.workspaceTargetPath,
    worktreePath: laneRow?.worktreePath ?? null,
    runtime: workerRouting?.selectedRuntime ?? packet.runtime,
    model: laneRow?.model ?? workerRouting?.selectedModel ?? packet.model ?? packet.assignedModel ?? null,
    laneId,
    sessionKey: sessionKey ?? null,
    lastHeartbeatAt: null,
    lastEventAt: new Date().toISOString(),
    lastEventLabel: 'dispatch_started',
    dependencyMaterializationMode: dependencyMaterializationMode ?? null,
  };
}
