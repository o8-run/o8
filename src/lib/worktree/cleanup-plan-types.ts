import type { WorktreeMaterializationIdentity } from './materialization-identity';

export interface CleanupPlanEntry {
  id: string;
  kind: 'workspace' | 'generated-output';
  worktreeId: string;
  workspacePath: string;
  identity: WorktreeMaterializationIdentity | null;
  eligible: boolean;
  reason: string | null;
  fingerprint: string;
  completion: { laneId: string; packetId: string; status: string; updatedAt: string } | null;
  head: string | null;
  branch: string | null;
  createdAt: number;
  resourceId?: string;
  resourceVersion?: number;
  outputIdentity?: WorktreeMaterializationIdentity;
  bankDigest?: string;
  dependencies: string[];
  estimate: { logicalBytes: number | null; exclusiveBytes: null };
  recovery: { ref?: string; bankPath?: string; recoveryPath?: string };
}

export interface CleanupPlanOutcome {
  entryId: string;
  state: 'started' | 'removed' | 'held';
  startedAt: number;
  finishedAt?: number;
  reason?: string;
  removedPaths?: string[];
  recovery?: CleanupPlanEntry['recovery'] & { preservationId?: string | null };
}

export interface WorkspaceCleanupPlan {
  schema: 'o8/workspace-cleanup-plan/v1';
  id: string;
  repositoryPath: string;
  repositoryId: string;
  repositoryIdentity: WorktreeMaterializationIdentity;
  createdAt: number;
  expiresAt: number;
  fingerprint: string;
  entries: CleanupPlanEntry[];
  truncated: boolean;
  status: 'preview' | 'running' | 'settled';
  selection: string[] | null;
  approvedAt: number | null;
  outcomes: CleanupPlanOutcome[];
  observedFreeSpace: Array<{ observedAt: number; availableBytes: number }>;
}
