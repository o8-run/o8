import path from 'node:path';
import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { hasCanonicalReleaseEvidence } from '@/lib/orchestrator/packet-release-truth';
import { assertInboxCanSettle, inboxPackets, runtimeInboxIdentity } from '@/lib/inbox/subjects';
import { readInboxState } from '@/lib/inbox/store';
import type { InboxSubject } from '@/lib/inbox/settlement-state';
import type { WorkspaceSnapshotRecord } from '@/lib/worktree/snapshot-state';

/** Status alone never proves completion or ownership. A null path needs snapshot proof below. */
function canonicalCompletedOwner(lane: Lane, packets: OrchestratorPacket[]) {
  if (lane.status !== 'completed' || lane.ownership !== 'managed' || !lane.packetId || !lane.sessionKey) return null;
  const packet = packets.find(candidate => candidate.id === lane.packetId);
  const binding = packet?.lane;
  if (!packet || packet.status !== 'released' || packet.releaseState !== 'released' || !hasCanonicalReleaseEvidence(packet)
    || packet.queueState !== 'held' || !binding || binding.laneId !== lane.id
    || binding.sessionKey !== lane.sessionKey || !binding.worktreePath || !binding.repoPath
    || path.resolve(binding.repoPath) !== path.resolve(lane.repoPath)
    || (lane.worktreePath !== null && path.resolve(binding.worktreePath) !== path.resolve(lane.worktreePath))) return null;
  return { packet, releaseHead: packet.releaseStatePayload?.headSha?.trim() || null };
}

function snapshotMatchesOwner(lane: Lane, packet: OrchestratorPacket, snapshot: WorkspaceSnapshotRecord): boolean {
  return snapshot.packetId === packet.id && snapshot.laneId === lane.id
    && path.resolve(snapshot.originalPath) === path.resolve(packet.lane!.worktreePath!)
    && snapshot.branch === lane.branch
    && snapshot.sessionIdentities.some(identity => identity.kind === 'owned-session' && identity.identity === lane.sessionKey);
}

/** The immutable generation, Git truth and session proof stay pinned through lifecycle transitions. */
export function sameWorkspaceSnapshot(current: WorkspaceSnapshotRecord, pinned: WorkspaceSnapshotRecord): boolean {
  return current.repositoryUuid === pinned.repositoryUuid && current.packetId === pinned.packetId
    && current.snapshotGeneration === pinned.snapshotGeneration && current.snapshotFingerprint === pinned.snapshotFingerprint
    && current.headCommit === pinned.headCommit && current.laneId === pinned.laneId
    && JSON.stringify(current.sessionIdentities) === JSON.stringify(pinned.sessionIdentities);
}

export function assertSettledCompletedWorkspace(lane: Lane,
  expected?: { subject: InboxSubject; settledAt: string; releaseHead: string | null },
  snapshot?: WorkspaceSnapshotRecord | null) {
  // NEW parking always needs the current materialized lane association.
  if (!lane.worktreePath) throw new Error('Completed parking requires its current materialized lane path.');
  const packets = inboxPackets();
  const proof = canonicalCompletedOwner(lane, packets);
  if (!proof) throw new Error('Completed workspace no longer has its exact canonical packet owner.');
  const subject = runtimeInboxIdentity({ sessionKey: lane.sessionKey!, workspace: lane.repoPath }, packets, [lane]).inboxSubject;
  const state = readInboxState(subject);
  if (state.settledOverride !== 'settled' || !state.settledAt || (expected
    && (JSON.stringify(subject) !== JSON.stringify(expected.subject) || state.settledAt !== expected.settledAt))) {
    throw new Error('Completed workspace thread is no longer settled at this parking boundary.');
  }
  if ((expected && proof.releaseHead !== expected.releaseHead)
    || (snapshot && (!snapshotMatchesOwner(lane, proof.packet, snapshot)
      || (proof.releaseHead !== null && proof.releaseHead !== snapshot.headCommit)))) {
    throw new Error('Completed workspace snapshot or canonical release HEAD changed.');
  }
  assertInboxCanSettle(subject, []);
  return { ...proof, subject, settledAt: state.settledAt };
}

export interface CompletedRestorePin {
  snapshot: WorkspaceSnapshotRecord;
  releaseHead: string | null;
}

/** Shared parked membership and Restore proof, including a maintenance-cleared lane path.
 * A restoring state is accepted only against the caller's already-pinned parked generation.
 */
export function completedParkedWorkspace(lane: Lane, snapshot: WorkspaceSnapshotRecord,
  packets = inboxPackets(), pinned?: CompletedRestorePin) {
  if (snapshot.state !== 'parked' && !(snapshot.state === 'restoring' && pinned)) return null;
  const proof = canonicalCompletedOwner(lane, packets);
  if (!proof || !snapshotMatchesOwner(lane, proof.packet, snapshot)
    || (proof.releaseHead !== null && proof.releaseHead !== snapshot.headCommit)
    || (pinned && (pinned.snapshot.state !== 'parked' || !sameWorkspaceSnapshot(snapshot, pinned.snapshot)
      || proof.releaseHead !== pinned.releaseHead))) return null;
  return { ...proof, snapshot };
}

/** Explicit Restore does not require a settled override; Unsettle never restores by itself. */
export function canRestoreCompletedWorkspace(lane: Lane, snapshot: WorkspaceSnapshotRecord): boolean {
  return completedParkedWorkspace(lane, snapshot) !== null;
}
