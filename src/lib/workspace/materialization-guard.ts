import { getLane } from '@/lib/lane/registry';
import { readStandingLane } from '@/lib/lane/standing-store';
import path from 'node:path';

import { findLaneByPacket } from '@/lib/lane/registry';
import { listRepos } from '@/lib/repos/registry';
import type {
  OwnedWorkspaceSpawnDecision,
  OwnedWorkspaceSpawnGuardInput,
} from '@/lib/runtimes/shared/owned-session/workspace-spawn-guard';
import { canonicalRepoRoot, canonicalWorktreeNamespace, isManagedPacketWorktreeId } from '@/lib/worktree/root-layout';
import { listWorkspaceSnapshotsByPacketId } from '@/lib/worktree/snapshot-state';
import type { WorkspaceSnapshotRecord } from '@/lib/worktree/snapshot-state';
import { materializeReplacementWorkspace } from './replacement-materialization';
import { assertManagedWorkspaceMaterialization } from './managed-materialization-identity';
import { hasActiveWorkspaceArtifactRestore } from './artifact-restore-state';

interface MaterializationGuardDependencies {
  listRepos: () => Promise<Array<{ id: string; localPath: string }>>;
  assertManagedWorkspaceMaterialization: typeof assertManagedWorkspaceMaterialization;
  /**
   * Durable packet -> source-repo truth. A transient repo is intentionally
   * never written to the saved registry, so `listRepos` alone can never reach
   * the repository that actually created the packet's worktree.
   */
  findLaneByPacket: (packetId: string) => { id: string; repoPath: string } | null;
}

const DEFAULT_DEPENDENCIES: MaterializationGuardDependencies = {
  listRepos,
  assertManagedWorkspaceMaterialization,
  findLaneByPacket,
};

/** Durable gate used under an owned session's surface lock before any process spawn. */
export async function inspectOwnedWorkspaceMaterialization(
  input: OwnedWorkspaceSpawnGuardInput,
  dependencies = DEFAULT_DEPENDENCIES,
): Promise<OwnedWorkspaceSpawnDecision> {
  const sessionPacketId = input.sessionPacketId?.trim() || null;
  const bindingPacketId = input.binding?.packetId?.trim() || null;
  if (sessionPacketId && bindingPacketId && sessionPacketId !== bindingPacketId) {
    return { status: 'unknown', note: 'Owned workspace packet identity is inconsistent, so the run was refused.' };
  }
  const packetId = bindingPacketId ?? sessionPacketId;
  if (!packetId) return { status: 'available', source: 'no-snapshot' };
  if (!input.binding) {
    return { status: 'unknown', note: 'Packet-bound owned workspace binding is missing, so the run was refused.' };
  }

  let snapshots: WorkspaceSnapshotRecord[];
  try {
    if (hasActiveWorkspaceArtifactRestore(packetId, input.binding.cwd)) {
      return { status: 'held', state: 'restoring', note: 'Artifact recovery is incomplete; resume its exact receipt before starting another run.' };
    }
    snapshots = listWorkspaceSnapshotsByPacketId(packetId);
  } catch {
    return { status: 'unknown', note: 'Owned workspace snapshot truth could not be verified, so the run was refused.' };
  }
  if (snapshots.length === 0) {
    const bindingPath = canonicalWorktreeNamespace(input.binding.cwd);
    if (canonicalWorktreeNamespace(input.repoPath) !== bindingPath) {
      return { status: 'unknown', note: 'Owned workspace binding does not match its managed repository path.' };
    }
    try {
      const repositories = (await dependencies.listRepos()).filter((repo) => (
        input.binding!.repositoryUuid === null || repo.id === input.binding!.repositoryUuid
      ));
      const matches: Array<Awaited<ReturnType<typeof assertManagedWorkspaceMaterialization>>> = [];
      const refusals: string[] = [];
      for (const repository of repositories) {
        try {
          matches.push(await dependencies.assertManagedWorkspaceMaterialization(
            repository.localPath,
            bindingPath,
          ));
        } catch (error) {
          // This repository does not own the exact managed path.
          refusals.push(error instanceof Error ? error.message : String(error));
        }
      }
      // Narrow fallback, reached only when no registered repository owns the
      // path. A transient repo is deliberately absent from the saved registry,
      // so the packet's own durable lane names the source repo that created
      // this worktree. The lane row is manager truth written at packet
      // creation -- never a caller-supplied cwd -- and the path must still
      // name THIS packet's managed worktree slot and prove the exact manager
      // receipt below, so an arbitrary cwd cannot authorize itself.
      let packetRefusal: string | null = null;
      if (matches.length === 0 && input.binding.repositoryUuid === null
        && (isManagedPacketWorktreeId(path.basename(bindingPath), packetId)
          || (() => {
            const lane = input.laneId ? getLane(input.laneId) : null;
            const standing = lane ? readStandingLane(lane.id) : null;
            return Boolean(lane && standing && !standing.stopped && !standing.removed
              && lane.packetId === packetId && lane.sessionKey === input.surfaceId
              && lane.worktreePath && canonicalWorktreeNamespace(lane.worktreePath) === bindingPath
              && standing.tasks.some(task => task.id === packetId && ['dispatching', 'running', 'done'].includes(task.phase)));
          })())) {
        const lane = dependencies.findLaneByPacket(packetId);
        const laneRepoPath = lane?.repoPath?.trim() ? canonicalRepoRoot(lane.repoPath) : null;
        // A packet-bound launch always carries its lane id, so a blank one is
        // missing launch identity rather than a permissible omission.
        const launchLaneId = input.laneId?.trim() || null;
        const laneIdentityHolds = launchLaneId !== null && launchLaneId === lane?.id;
        const alreadyConsulted = repositories.some((repo) => (
          canonicalRepoRoot(repo.localPath) === laneRepoPath
        ));
        if (laneRepoPath && laneIdentityHolds && !alreadyConsulted) {
          try {
            matches.push(await dependencies.assertManagedWorkspaceMaterialization(
              laneRepoPath,
              bindingPath,
            ));
          } catch (error) {
            packetRefusal = error instanceof Error ? error.message : String(error);
          }
        }
      }
      if (matches.length !== 1) {
        // A single consulted repository refused for one exact, auditable
        // reason. Reporting registry ambiguity instead would send the
        // operator to the repo list rather than the replaced directory.
        throw new Error(packetRefusal ?? (matches.length === 0 && refusals.length === 1
          ? refusals[0]!
          : 'Managed workspace ownership is absent or ambiguous across registered repositories.'));
      }
      const materializationIdentity = matches[0]!;
      return { status: 'available', source: 'materialized', materializationIdentity };
    } catch (error) {
      return {
        status: 'unknown',
        note: error instanceof Error ? error.message : 'Managed workspace ownership could not be verified.',
      };
    }
  }
  if (snapshots.length !== 1) {
    return { status: 'unknown', note: 'Owned workspace snapshot truth is ambiguous, so the run was refused.' };
  }

  let snapshot = snapshots[0]!;
  const bindingPath = canonicalWorktreeNamespace(input.binding.cwd);
  const retiredReplacementLaunch = input.mode === 'launch' && snapshot.state === 'retired';
  if (canonicalWorktreeNamespace(input.repoPath) !== bindingPath
    || (!retiredReplacementLaunch && canonicalWorktreeNamespace(snapshot.originalPath) !== bindingPath)
    || (input.binding.repositoryUuid !== null
      && input.binding.repositoryUuid !== snapshot.repositoryUuid)) {
    return { status: 'unknown', note: 'Owned workspace snapshot identity does not match the durable session binding, so the run was refused.' };
  }
  if (input.mode === 'launch' && (
    snapshot.state === 'parked'
    || snapshot.state === 'materialized'
    || snapshot.state === 'retired'
  )) {
    const laneId = input.laneId?.trim();
    const runtimeId = input.runtimeId?.trim();
    if (!laneId || !runtimeId) {
      return { status: 'unknown', note: 'Replacement launch identity is incomplete, so the run was refused.' };
    }
    try {
      snapshot = await materializeReplacementWorkspace(snapshot, {
        laneId,
        packetId,
        workspacePath: bindingPath,
        runtimeId,
        surfaceId: input.surfaceId,
      });
    } catch (error) {
      return {
        status: 'unknown',
        note: error instanceof Error ? error.message : 'Replacement workspace truth could not be verified.',
      };
    }
  }
  if (snapshot.state === 'materialized') {
    try {
      const repo = (await dependencies.listRepos()).find((entry) => entry.id === snapshot.repositoryUuid);
      if (!repo) throw new Error('Managed workspace repository is absent.');
      const materializationIdentity = await dependencies.assertManagedWorkspaceMaterialization(
        repo.localPath,
        bindingPath,
      );
      return { status: 'available', source: 'materialized', materializationIdentity };
    } catch (error) {
      return {
        status: 'unknown',
        note: error instanceof Error ? error.message : 'Managed workspace ownership could not be verified.',
      };
    }
  }
  return {
    status: 'held',
    state: snapshot.state,
    note: `Owned workspace is ${snapshot.state}; restore it to materialized state before starting another run.`,
  };
}
