import { refreshCloseProcessObservation } from '@/lib/runtime/close-process-observation';
import { timeClosePhase } from '@/lib/orchestrator/close-timing';
import { orphanCloseOwner, readOrphanCloseOwner, refuseOrphanClose, withOrphanCloseContext } from '@/lib/orchestrator/close-orphaned-owner';
import { readdir } from 'node:fs/promises';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { readWorktreeMetaSnapshot } from '@/lib/worktree/metadata-store';
import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';
import { canonicalRepoRoot } from '@/lib/worktree/root-layout';
import { readWorkspacePreservation, verifyPreservedArtifactsAtPath } from './preservation-store';
import { getWorkspaceRetirementPreservationId } from './workspace-materialization-retirement';
import { admitStandaloneRetirement, verifyStandaloneRetirement } from './standalone-retirement-authority';
import { withPacketLifecycleSpawnLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { assertManagedRetirementQuiescence } from './retirement-process-authority';
import { UnbankedArtifactSourceError } from './ignored-artifact-io';
import type { CapturedPurgeProcessWitness } from './exact-directory-purge';
import { assertWarmPacketSeal, type WarmPacketSeal } from '@/lib/worktree/warm-packet-integrity';
import { allowWorktreeRemoval, probeLiveProcessInside } from '@/lib/worktree/live-process-guard';
import { readCapturedPurgeCwdSnapshot } from './exact-directory-purge';

export type ManagedRetirementReason = 'terminal' | 'creation-rollback' | 'warm-pristine' | 'empty-orphan';

/** Older claims may predate durable orphan authority while a warm close owns them. */
export async function requiresPausedOrphanVerification(authority: Record<string, unknown> | null): Promise<boolean> {
  if (authority?.warmSeal) return true;
  if (authority?.retirementReason !== 'terminal') return false;
  if (authority.orphanCloseOwner !== undefined) return true;
  if (typeof authority.preservationId !== 'string') throw new Error('Terminal retirement has no preservation owner.');
  const { payload } = await readWorkspacePreservation(authority.preservationId);
  return !!(payload.laneId && orphanCloseOwner(payload.laneId));
}

/** Crash replay must retain the same lifecycle exclusion as the original terminal. */
export async function withRetirementAuthorityLock<T>(
  authority: Record<string, unknown> | null,
  operation: () => Promise<T>,
): Promise<T> {
  if (authority?.retirementReason !== 'terminal') return operation();
  if (typeof authority.preservationId !== 'string') throw new Error('Terminal retirement has no preservation owner.');
  const { payload } = await readWorkspacePreservation(authority.preservationId);
  if (authority.orphanCloseOwner !== undefined) {
    const owner = readOrphanCloseOwner(authority.orphanCloseOwner);
    if (owner.packetId !== payload.packetId || owner.laneId !== payload.laneId
      || owner.repositoryUuid !== payload.repositoryUuid || owner.sourcePath !== payload.identity.canonicalPath
      || owner.device !== payload.identity.device || owner.inode !== payload.identity.inode) {
      throw new Error('Durable orphan close authority belongs to another preservation owner.');
    }
    return withPacketLifecycleSpawnLock(payload.packetId, () => withOrphanCloseContext(payload.packetId, operation, owner));
  }
  return withPacketLifecycleSpawnLock(payload.packetId, operation);
}

export async function admitRetirementAuthority(input: {
  repositoryPath: string;
  worktreeId: string;
  directoryPath: string;
  identity: WorktreeMaterializationIdentity;
  reason: ManagedRetirementReason;
}): Promise<Record<string, unknown>> {
  if (input.reason === 'empty-orphan') return { retirementReason: input.reason };
  if (input.reason === 'creation-rollback' || input.reason === 'warm-pristine') {
    const metadata = (await readWorktreeMetaSnapshot(input.repositoryPath))[input.worktreeId];
    if (!metadata || metadata.claudeManaged
      || (metadata.status !== 'creating' && metadata.status !== 'setup') || !metadata.creationOwner
      || metadata.materializationIdentity?.device !== input.identity.device
      || metadata.materializationIdentity.inode !== input.identity.inode) {
      throw new Error('Creation rollback has no matching durable creation authority.');
    }
    if (metadata.warmTransfer) throw new Error('Transferred warm workspace requires preservation before retirement.');
    const warm = metadata.warmPool;
    if ((input.reason === 'warm-pristine') !== !!warm) throw new Error('Warm retirement requires its own pristine-content authority.');
    if (warm && (metadata.packetId || metadata.laneId || metadata.sessionKey)) throw new Error('Warm retirement no longer owns an unused workspace.');
    if (warm && !warm.seal) throw new Error('Unsealed warm workspace must remain retained.');
    const authority = { retirementReason: input.reason, creationOwner: metadata.creationOwner,
      repositoryPath: canonicalRepoRoot(input.repositoryPath), worktreeId: input.worktreeId,
      sourceDevice: input.identity.device, sourceInode: input.identity.inode,
      ...(warm ? { warmSeal: warm.seal } : {}) };
    await verifyCreationAuthority(authority);
    if (warm) await assertWarmPacketSeal(input.directoryPath, input.identity, warm.seal);
    return authority;
  }
  const preservationId = getWorkspaceRetirementPreservationId(input.directoryPath);
  if (!preservationId) return admitStandaloneRetirement(input);
  const { payload } = await readWorkspacePreservation(preservationId);
  if (canonicalRepoRoot(payload.repositoryPath) !== canonicalRepoRoot(input.repositoryPath)
    || payload.worktreeId !== input.worktreeId || payload.identity.device !== input.identity.device
    || payload.identity.inode !== input.identity.inode) {
    throw new Error('Terminal preservation belongs to another exact workspace owner.');
  }
  const orphan = payload.laneId ? orphanCloseOwner(payload.laneId) : null;
  return { retirementReason: 'terminal', preservationId, ...(orphan ? { orphanCloseOwner: orphan } : {}) };
}

async function verifyCreationAuthority(authority: Record<string, unknown>): Promise<void> {
  const owner = authority.creationOwner as { pid?: unknown; identity?: unknown } | undefined;
  if (!owner || typeof owner.pid !== 'number' || !isMetadataLockProcessIdentity(owner.identity)) {
    throw new Error('Creation retirement lost its durable process owner.');
  }
  if (typeof authority.repositoryPath !== 'string' || typeof authority.worktreeId !== 'string') {
    throw new Error('Creation retirement has no durable manager identity.');
  }
  const metadata = (await readWorktreeMetaSnapshot(authority.repositoryPath))[authority.worktreeId];
  const identity = metadata?.materializationIdentity;
  if (!metadata || metadata.claudeManaged || (metadata.status !== 'creating' && metadata.status !== 'setup')
    || metadata.creationOwner?.pid !== owner.pid || !metadata.creationOwner
    || !sameMetadataLockProcessIdentity(metadata.creationOwner.identity, owner.identity)
    || !identity || identity.device !== authority.sourceDevice || identity.inode !== authority.sourceInode) {
    throw new Error('Creation retirement manager authority changed after admission.');
  }
  const warm = metadata.warmPool;
  if (metadata.warmTransfer || !!warm !== !!authority.warmSeal
    || (warm && (metadata.packetId || metadata.laneId || metadata.sessionKey || JSON.stringify(warm.seal) !== JSON.stringify(authority.warmSeal)))) {
    throw new Error('Warm retirement lost its original content seal.');
  }
  const observed = await probeMetadataLockProcessIdentity(owner.pid);
  if (observed.state === 'unknown'
    || (observed.state === 'live' && sameMetadataLockProcessIdentity(observed.identity, owner.identity)
      && owner.pid !== process.pid)) {
    throw new Error('Creation retirement still has a live or unknown creator.');
  }
}

async function verifyRetirementAuthorityNative(input: {
  authority: Record<string, unknown> | null;
  sourcePath: string;
  candidatePath: string;
  identity: WorktreeMaterializationIdentity;
  verifyContents: boolean;
  capturedPurge?: CapturedPurgeProcessWitness;
}): Promise<void> {
  const reason = input.authority?.retirementReason;
  if (reason === 'standalone-clean') {
    const authority = input.authority!;
    if (typeof authority.repositoryPath !== 'string' || typeof authority.worktreeId !== 'string') {
      throw new Error('Standalone retirement has no durable manager process authority.');
    }
    await assertManagedRetirementQuiescence({
      repositoryPath: authority.repositoryPath, worktreeId: authority.worktreeId,
      sourcePath: input.sourcePath, candidatePath: input.candidatePath, identity: input.identity,
    });
    return verifyStandaloneRetirement({ ...input, authority });
  }
  if (reason === 'creation-rollback' || reason === 'warm-pristine') {
    await verifyCreationAuthority(input.authority!);
    if (input.verifyContents && input.authority!.warmSeal) {
      await assertWarmPacketSeal(input.candidatePath, { ...input.identity, canonicalPath: input.candidatePath }, input.authority!.warmSeal as WarmPacketSeal);
    }
    if (input.authority!.warmSeal) {
      if (input.capturedPurge) refreshCloseProcessObservation();
      const clear = input.capturedPurge
        ? (await probeLiveProcessInside(input.candidatePath, { snapshot: await readCapturedPurgeCwdSnapshot(input.capturedPurge, input.candidatePath) })).status === 'clear'
        : await allowWorktreeRemoval(input.candidatePath, { logPrefix: 'warm-retirement' });
      if (!clear) throw new Error('Warm retirement is live or unknown; retaining the tree.');
    }
    return;
  }
  if (reason === 'empty-orphan') return;
  const preservationId = input.authority?.preservationId;
  if (reason !== 'terminal' || typeof preservationId !== 'string'
    || getWorkspaceRetirementPreservationId(input.sourcePath) !== preservationId) {
    throw new Error('Exact retirement lacks its durable preservation or creation reason.');
  }
  const { receipt, payload } = await readWorkspacePreservation(preservationId);
  if (receipt.sourceDevice !== input.identity.device || receipt.sourceInode !== input.identity.inode) {
    throw new Error('Exact retirement preservation materialization changed.');
  }
  const orphan = (payload.laneId ? orphanCloseOwner(payload.laneId) : null)
    ?? (input.authority?.orphanCloseOwner === undefined ? null : readOrphanCloseOwner(input.authority.orphanCloseOwner));
  let artifactFailure: unknown = null;
  try {
    // Discard receipts may omit dirty source. Check orphan source even during
    // purge replay; a partially purged Git tree conservatively remains held.
    let verifiedOrphanArtifacts = false;
    if (orphan?.laneId) {
      let entries: string[];
      try {
        entries = await readdir(input.candidatePath).catch((error: NodeJS.ErrnoException) => {
          if (!input.verifyContents && error.code === 'ENOENT') return [];
          throw error;
        });
      } catch {
        refuseOrphanClose(orphan.laneId, 'unbanked source or uncertain source/snapshot revision; preserve the edits before retrying');
      }
      if (entries.length > 0 || input.verifyContents) {
        // The capture helper checks clean source, index flags, the exact
        // revision and ignored content in one pinned read before native proof.
        try {
          await verifyPreservedArtifactsAtPath(preservationId, input.candidatePath, {
            ...input.identity, canonicalPath: input.candidatePath,
          }, { requireCleanSource: true });
        } catch (error) {
          if (error instanceof UnbankedArtifactSourceError) {
            refuseOrphanClose(orphan.laneId, 'unbanked source or uncertain source/snapshot revision; preserve the edits before retrying');
          }
          refuseOrphanClose(orphan.laneId, 'ignored artifacts changed or their preserved content is uncertain; preserve the edits before retrying');
        }
        verifiedOrphanArtifacts = true;
      }
    }
    if (input.verifyContents && !verifiedOrphanArtifacts) {
      try {
        await verifyPreservedArtifactsAtPath(preservationId, input.candidatePath, {
          ...input.identity, canonicalPath: input.candidatePath,
        });
      } catch (error) {
        if (orphan?.laneId) {
          refuseOrphanClose(orphan.laneId, 'ignored artifacts changed or their preserved content is uncertain; preserve the edits before retrying');
        }
        throw error;
      }
    }
  } catch (error) { artifactFailure = error; }
  // Settle artifact readers before the final native snapshot. The paused
  // purge helper is the only permitted holder; immutable owner checks still
  // run against current durable state immediately before continuation.
  if (input.capturedPurge) refreshCloseProcessObservation();
  const owner = await assertManagedRetirementQuiescence({
    repositoryPath: payload.repositoryPath, worktreeId: payload.worktreeId,
    sourcePath: input.sourcePath, candidatePath: input.candidatePath, identity: input.identity,
    capturedPurge: input.capturedPurge,
  });
  if (owner.repositoryUuid !== payload.repositoryUuid || owner.packetId !== payload.packetId || owner.laneId !== payload.laneId
    || !(owner.orphanedClose && owner.sessionKey === null && payload.handoff.sessionIdentities.length === 0
      || payload.handoff.sessionIdentities.some((identity) => identity.kind === 'owned-session'
        && identity.identity === owner.sessionKey))) {
    throw new Error('Terminal preservation process owner changed after capture.');
  }
  if (artifactFailure) throw artifactFailure;
}

export function verifyRetirementAuthority(...args: Parameters<typeof verifyRetirementAuthorityNative>): ReturnType<typeof verifyRetirementAuthorityNative> {
  return timeClosePhase('verifyRetirementAuthority', () => verifyRetirementAuthorityNative(...args));
}
