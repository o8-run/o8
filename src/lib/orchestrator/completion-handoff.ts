import { completionOutcomeId, hasForgottenPacketOutcome, isOutcomeForgotten } from '@/lib/cortex/outcome-exclusion';
import { readMemoryRevision } from '@/lib/cortex/memory-revision';
import 'server-only';
import { execFileSync } from '@/lib/providers/child-process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { laneGit, laneGitInvocation } from '@/lib/lane/lane-git';
import { getSqlite } from '@/lib/db';
import { findLatestLaneByPacket, getLane, listLanes } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import { ownedRoots } from '@/lib/runtimes/shared/owned-session-index';
import { archiveRootForOwnedSessionRoot } from '@/lib/runtimes/shared/owned-session/archive';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session';
import { probeLaneSessionAlive } from '@/lib/lane/owned-session-liveness';
import { packetSteerHoldReason } from '@/lib/lane/packet-stop-hold';
import { canonicalRepoRoot } from '@/lib/worktree/root-layout';
import { readManagedWorkspaceMaterialization } from '@/lib/workspace/managed-materialization-identity';
import { guardedWorkspaceInvocation, withWorktreeMaterializationExecution } from '@/lib/worktree/materialization-execution';
import { withWorktreeMetaTransaction } from '@/lib/worktree/metadata-store';
import { publishCompletionHandoff, readCompletionHandoff, type CompletionHandoffRecord } from '@/lib/workspace/completion-handoff-store';
import { readOrchestratorControlPlaneState, withControlPlaneLock } from '@/lib/orchestrator/control-plane';
import { findMissionRegistryEntryByPacketId } from '@/lib/orchestrator/mission-registry';
import { packetReleaseGeneration, packetReleaseIdentityIsCurrent } from '@/lib/orchestrator/release-ownership';
import { outcomeFromPacketSelfReview } from '@/lib/orchestrator/context-relay-outcome';
import type { OrchestratorPacket, PacketContext } from '@/lib/orchestrator/types';
import { completionContextRecovery } from './completion-handoff-recovery';
import { SupersededCompletionError } from '@/lib/supervisor/completion-turn';

export const packetCompletionContextStore = new Map<string, PacketContext>();
const captures = new WeakMap<PacketContext, CompletionHandoffCapture>();

function ownerPacket(packetId: string): { packet: OrchestratorPacket; missionId: string | null } | null {
  const current = readOrchestratorControlPlaneState();
  const packet = current.packets.find((entry) => entry.id === packetId);
  if (packet) return { packet, missionId: current.missionId ?? null };
  const entry = findMissionRegistryEntryByPacketId(packetId);
  const registered = entry?.mission.packets.find((candidate) => candidate.id === packetId);
  return registered ? { packet: registered, missionId: entry!.id } : null;
}

function turnCursor(laneId: string): number {
  return (getSqlite().prepare(`SELECT rowid FROM lane_events WHERE lane_id = ?
    AND verb IN ('steered_packet', 'steer_run_admitted', 'steer_failed', 'runtime_process_exit')
    ORDER BY rowid DESC LIMIT 1`).get(laneId) as { rowid: number } | undefined)?.rowid ?? 0;
}

/** Bind the supervisor callback before its first async completion operation. */
export function completionHandoffTurnCheck(lane: Lane) {
  const initial = lane.packetId ? ownerPacket(lane.packetId) : null;
  let generation = initial ? packetReleaseGeneration(initial.packet, lane.id) : null;
  const check = () => {
    if (!lane.packetId) return;
    const current = ownerPacket(lane.packetId);
    if (!initial) { if (current) throw new SupersededCompletionError(); return; }
    if (!generation || !current || current.missionId !== initial.missionId
      || !packetReleaseIdentityIsCurrent(current.packet, lane.id, generation, true)) {
      throw new SupersededCompletionError();
    }
  };
  return {
    check,
    // Only the existing guarded retry transaction may advance its own attempt.
    acceptRetryGeneration(packet: OrchestratorPacket): void {
      if (!initial) return;
      if (packet.id !== initial.packet.id || packet.attemptCount !== (initial.packet.attemptCount ?? 0) + 1
        || packet.storageAdmissionEpoch !== initial.packet.storageAdmissionEpoch
        || packet.status !== 'queued' || packet.queueState !== 'queued' || packet.lane !== null
        || packet.workspaceTargetPath !== initial.packet.workspaceTargetPath || packet.branchTarget !== initial.packet.branchTarget) {
        throw new SupersededCompletionError();
      }
      generation = packetReleaseGeneration(packet, lane.id);
    },
  };
}

function sameDirectory(identity: CompletionHandoffRecord['identity']): void {
  const stat = lstatSync(identity.canonicalPath);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.device || stat.ino !== identity.inode
    || realpathSync(identity.canonicalPath) !== identity.canonicalPath) {
    throw new Error('Completion source materialization changed.');
  }
}

function providerRun(lane: Lane, repositoryUuid: string) {
  const root = ownedRoots().find((entry) => lane.sessionKey?.startsWith(entry.marker));
  if (!root || !lane.sessionKey) throw new Error('Completion has no owned provider archive.');
  const id = lane.sessionKey.slice(root.marker.length);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw new Error('Completion provider identity is invalid.');
  for (const base of [root.root, archiveRootForOwnedSessionRoot(root.root)]) {
    const metadataPath = path.join(base, id, 'session.json');
    let fd: number;
    try { fd = openSync(metadataPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 2 * 1024 * 1024 || stat.mode & 0o022
        || (process.getuid && stat.uid !== process.getuid())) throw new Error('Provider metadata ownership or size is unsafe.');
      const content = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < content.length) {
        const count = readSync(fd, content, offset, content.length - offset, offset);
        if (!count) throw new Error('Provider metadata was truncated during capture.');
        offset += count;
      }
      const after = fstatSync(fd), named = lstatSync(metadataPath);
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs
        || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino) {
        throw new Error('Provider metadata changed during capture.');
      }
      const session = JSON.parse(content.toString('utf8')) as OwnedSessionRecord;
      const run = session.recentRuns?.[0];
      if (session.surfaceId !== lane.sessionKey || session.packetId !== lane.packetId
        || session.laneId !== lane.id || session.activeRun || !run?.id || !run.finishedAt || run.outcome === 'running'
        || !session.workspaceBinding || (session.workspaceBinding.repositoryUuid !== null
          && session.workspaceBinding.repositoryUuid !== repositoryUuid)
        || session.workspaceBinding.packetId !== lane.packetId
        || session.workspaceBinding.logicalWorkspaceId !== `packet:${lane.packetId}`
        || path.resolve(session.workspaceBinding.cwd) !== path.resolve(lane.worktreePath!)
        || path.resolve(session.cwd) !== path.resolve(lane.worktreePath!)) {
        throw new Error('Completion provider run is live or belongs to another owner.');
      }
      return { runId: run.id, finishedAt: run.finishedAt, outcome: run.outcome,
        threadId: session.threadId ?? null, metadataPath,
        stdoutPath: run.stdoutPath, stderrPath: run.stderrPath };
    } finally { closeSync(fd); }
  }
  throw new Error('Completion provider archive dependency is absent.');
}

export interface CompletionHandoffCapture {
  lane: Lane;
  repositoryUuid: string;
  missionId: string | null;
  owner: CompletionHandoffRecord['owner'];
  managed: Awaited<ReturnType<typeof readManagedWorkspaceMaterialization>>;
  provider: ReturnType<typeof providerRun>;
}

function checkOwner(capture: CompletionHandoffCapture): void {
  const lane = getLane(capture.lane.id), latest = findLatestLaneByPacket(capture.lane.packetId!);
  const owner = ownerPacket(capture.lane.packetId!);
  const owners = listLanes().filter((candidate) => candidate.worktreePath
    && path.resolve(candidate.worktreePath) === capture.managed.identity.canonicalPath
    && canonicalRepoRoot(candidate.repoPath) === canonicalRepoRoot(capture.lane.repoPath));
  if (owners.length !== 1 || owners[0].id !== capture.lane.id || !lane || latest?.id !== lane.id || lane.sessionKey !== capture.lane.sessionKey
    || lane.packetId !== capture.lane.packetId || lane.worktreePath !== capture.lane.worktreePath
    || ['paused', 'archived', 'merging'].includes(lane.status) || !owner
    || ['operator_stopped', 'archived'].includes(packetSteerHoldReason(capture.lane.packetId!) ?? '')
    || owner.missionId !== capture.missionId
    || !packetReleaseIdentityIsCurrent(owner.packet, lane.id, capture.owner.generation, true)
    || (owner.packet.lane?.sessionKey && owner.packet.lane.sessionKey !== lane.sessionKey)
    || turnCursor(lane.id) !== capture.owner.turnCursor) {
    throw new SupersededCompletionError();
  }
}

/** Capture owner/generation/materialization BEFORE waiting for the transcript. */
export async function beginCompletionHandoffCapture(lane: Lane | null, sessionKey: string): Promise<CompletionHandoffCapture | null> {
  if (!lane?.packetId || !lane.worktreePath || lane.sessionKey !== sessionKey
    || !ownedRoots().some((root) => sessionKey.startsWith(root.marker))) return null;
  const owner = ownerPacket(lane.packetId);
  if (!owner) return null;
  const generation = packetReleaseGeneration(owner.packet, lane.id);
  const cursor = turnCursor(lane.id);
  const repo = await findRepoByLocalPath(lane.repoPath);
  if (!repo) return null; // Transient/discovered contexts retain their existing relay behavior.
  const managed = await readManagedWorkspaceMaterialization(repo.localPath, lane.worktreePath);
  const owners = listLanes().filter((candidate) => candidate.worktreePath
    && path.resolve(candidate.worktreePath) === managed.identity.canonicalPath
    && canonicalRepoRoot(candidate.repoPath) === canonicalRepoRoot(repo.localPath));
  // Match the retirement exact-owner policy, including normal launch's null UUID.
  if (owners.length !== 1 || owners[0].id !== lane.id || managed.metadata.status !== 'ready'
    || !managed.metadata.materializationParentIdentity
    || path.join(managed.metadata.materializationParentIdentity.canonicalPath, managed.metadata.id) !== managed.identity.canonicalPath
    || managed.metadata.sessionKey !== sessionKey || managed.metadata.branchName !== lane.branch) {
    throw new Error('Completion manager receipt belongs to another session or branch.');
  }
  const provider = providerRun(lane, repo.id);
  const capture: CompletionHandoffCapture = { lane, repositoryUuid: repo.id, missionId: owner.missionId,
    managed, provider, owner: { generation, turnCursor: cursor, attempt: owner.packet.attemptCount ?? 0,
      storageEpoch: owner.packet.storageAdmissionEpoch ?? 0, runId: provider.runId, finishedAt: provider.finishedAt } };
  checkOwner(capture);
  return capture;
}

function bounded(value: string | undefined, limit = 1200): string {
  return (value ?? '').trim().slice(0, limit);
}

function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }

async function sourceFacts(capture: CompletionHandoffCapture) {
  return withWorktreeMaterializationExecution(capture.lane.worktreePath!, capture.managed.identity, async () => {
    const git = async (args: string[]) => {
      const { stdout } = await laneGit(capture.lane.worktreePath!, capture.lane.repoPath, args,
        { timeout: 5000, maxBuffer: 512 * 1024 });
      return stdout.trim();
    };
    const revision = await git(['rev-parse', '--verify', 'HEAD']);
    const treeSha = await git(['rev-parse', '--verify', 'HEAD^{tree}']);
    if (await git(['status', '--porcelain', '--untracked-files=normal']) !== ''
      || await git(['rev-parse', '--verify', 'HEAD']) !== revision) {
      throw new Error('Completion source is dirty or moved during capture.');
    }
    return { revision, treeSha };
  });
}

/** Publish only an accepted completion, before its terminal transition can retire source. */
export async function persistCapturedCompletionHandoff(context: PacketContext, outcome: string, checkAccepted: () => void, targetState?: CompletionHandoffRecord['acceptedState']): Promise<boolean> {
  const capture = captures.get(context);
  if (!capture) return false; // Hand-authored/legacy contexts have no source authority.
  checkOwner(capture);
  checkAccepted();
  const managed = await readManagedWorkspaceMaterialization(capture.lane.repoPath, capture.lane.worktreePath!);
  if (JSON.stringify(managed.identity) !== JSON.stringify(capture.managed.identity)
    || managed.metadata.sessionKey !== capture.lane.sessionKey) throw new Error('Completion materialization owner changed.');
  return withWorktreeMetaTransaction(capture.lane.repoPath, async (transaction) => {
    const metadata = (await transaction.readAll())[capture.managed.metadata.id];
    if (!metadata || metadata.status !== 'ready' || metadata.sessionKey !== capture.lane.sessionKey
      || metadata.branchName !== capture.managed.metadata.branchName
      || JSON.stringify(metadata.materializationParentIdentity) !== JSON.stringify(capture.managed.metadata.materializationParentIdentity)
      || JSON.stringify(metadata.materializationIdentity) !== JSON.stringify(capture.managed.identity)) {
      throw new Error('Completion manager ownership changed before publication.');
    }
    // Unknown liveness is insufficient for a durable completion claim.
    if (await probeLaneSessionAlive(capture.lane) !== false) throw new Error('Completion runtime quiescence is unverified.');
    const facts = await sourceFacts(capture);
    if (context.headSha && facts.revision !== context.headSha) throw new Error('Completion revision differs from captured context.');
    const provider = providerRun(capture.lane, capture.repositoryUuid);
    if (JSON.stringify(provider) !== JSON.stringify(capture.provider)) throw new Error('Completion provider run changed during capture.');
    if (outcome === 'no_changes' && provider.outcome !== 'finished') throw new Error('Read-only completion provider did not finish successfully.');
    const compact: PacketContext = { sourceOutcomeId: context.sourceOutcomeId ?? completionOutcomeId(context), sourceOutcomeFingerprint: context.sourceOutcomeFingerprint, packetId: context.packetId, sessionKey: context.sessionKey,
      memoryRevision: context.memoryRevision, projectId: context.projectId, headSha: facts.revision, completedAt: capture.owner.finishedAt,
      ...(context.diffFingerprint ? { diffFingerprint: bounded(context.diffFingerprint, 128) } : {}),
      model: bounded(context.model, 120), summary: bounded(context.summary),
      changedFiles: context.changedFiles.slice(0, 16).map((file) => bounded(file, 240)),
      ...(context.selfReview ? { selfReview: { ...context.selfReview,
        summary: bounded(context.selfReview.summary), outcome: bounded(context.selfReview.outcome),
        residual: bounded(context.selfReview.residual), recurrenceProtection: bounded(context.selfReview.recurrenceProtection, 320),
        issuesFound: context.selfReview.issuesFound?.slice(0, 8).map((entry) => bounded(entry, 240)),
        evidence: context.selfReview.evidence?.slice(0, 8).map((entry) => bounded(entry, 320)) } } : {}) };
    const source = quote(capture.managed.identity.canonicalPath);
    const acceptedState = targetState ?? (outcome === 'no_changes' ? 'completed' : getLane(capture.lane.id)?.status);
    if (acceptedState !== 'reviewing' && acceptedState !== 'completed' && acceptedState !== 'failed') {
      throw new Error('Completion has no accepted state.');
    }
    const record: CompletionHandoffRecord = { schema: 'o8/worker-completion-handoff/v1',
      repositoryUuid: capture.repositoryUuid, packetId: context.packetId, laneId: capture.lane.id,
      missionId: capture.missionId, sessionKey: context.sessionKey, worktreeId: capture.managed.metadata.id,
      identity: capture.managed.identity, acceptedState, owner: capture.owner, context: compact,
      handoff: { ...facts, outcome, remainingWork: bounded(context.selfReview?.residual) || 'Inspect the retained lane reports before deciding what remains.',
        evidence: { laneId: capture.lane.id, references: [
          `lane:${capture.lane.id}; turn:${capture.owner.turnCursor}; run:${provider.runId}`,
          `provider metadata: ${provider.metadataPath}`, `provider stdout: ${provider.stdoutPath}`,
          ...(context.selfReview?.evidence?.slice(0, 8).map((entry) => bounded(entry, 320)) ?? []),
        ] }, sessionIdentities: [{ kind: 'runtime-session', identity: context.sessionKey, runtime: capture.lane.runtime },
          { kind: 'runtime-run', identity: provider.runId }, ...(provider.threadId ? [{ kind: 'provider-thread', identity: provider.threadId }] : [])],
        recoveryInstructions: `No verified portable recovery bundle is attached to this completion handoff. Recovery depends on the live held/retained workspace ${capture.managed.identity.canonicalPath} and the provider archive (${provider.metadataPath}); retain both until private Git/artifact preservation is verified. Verify source with: test "$(git -C ${source} rev-parse HEAD)" = ${quote(facts.revision)} && test "$(git -C ${source} rev-parse 'HEAD^{tree}')" = ${quote(facts.treeSha)}. To copy committed source into a new empty recovery directory: git clone --no-local --no-checkout -- ${source} '<empty-successor-path>' && git -C '<empty-successor-path>' checkout --detach ${quote(facts.revision)}. This does not copy ignored artifacts or provider history. After retirement, use the separately verified private workspace preservation receipt and bundle; this handoff alone never authorizes removal.` } };
    getSqlite().transaction(() => publishCompletionHandoff(record, () => {
      checkOwner(capture);
      checkAccepted();
      sameDirectory(capture.managed.identity);
      if (capture.managed.metadata.materializationParentIdentity) sameDirectory(capture.managed.metadata.materializationParentIdentity);
      if (JSON.stringify(providerRun(capture.lane, capture.repositoryUuid)) !== JSON.stringify(provider)) {
        throw new Error('Completion provider owner changed before publication.');
      }
      const git = (args: string[]) => {
        const safe = laneGitInvocation(capture.lane.worktreePath!, capture.lane.repoPath, args);
        const invocation = guardedWorkspaceInvocation('git', safe.args, capture.managed.identity);
        return execFileSync(invocation.command, invocation.args, { cwd: capture.lane.worktreePath!,
          encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], env: safe.env }).trim();
      };
      if (git(['rev-parse', 'HEAD', 'HEAD^{tree}']) !== `${facts.revision}\n${facts.treeSha}`
        || git(['status', '--porcelain', '--untracked-files=normal']) !== '') {
        throw new Error('Completion head, tree or source cleanliness changed before publication.');
      }
    })).immediate();
    return true;
  });
}

export async function finishCompletionHandoffCapture(context: PacketContext, capture: CompletionHandoffCapture | null): Promise<void> {
  if (capture) {
    checkOwner(capture);
    captures.set(context, capture);
    const lane = getLane(capture.lane.id);
    if (lane && ['reviewing', 'completed', 'failed'].includes(lane.status)) {
      await withControlPlaneLock(() => persistCapturedCompletionHandoff(context,
        (lane.status === 'reviewing' ? null : lane.outcome) ?? outcomeFromPacketSelfReview(context.selfReview), () => {
          if (getLane(lane.id)?.status !== lane.status) throw new Error('Completion acceptance state changed.');
        }));
    }
  }
  const current = findLatestLaneByPacket(context.packetId);
  if (current?.sessionKey && current.sessionKey !== context.sessionKey) return;
  packetCompletionContextStore.set(context.packetId, context);
}

async function readUnfilteredCompletionContext(packetId: string): Promise<PacketContext | null> {
  const id = packetId.trim();
  if (!id) return null;
  const cached = packetCompletionContextStore.get(id);
  let currentCapturedContext: PacketContext | null = null;
  if (cached) {
    const capture = captures.get(cached);
    if (!capture) return cached;
    // Managed contexts always read the immutable receipt and current recovery truth.
    try { checkOwner(capture); currentCapturedContext = cached; } catch { /* Read current durable truth below. */ }
  }
  const lane = findLatestLaneByPacket(id);
  if (!lane) return null;
  const repo = await findRepoByLocalPath(lane.repoPath);
  const record = repo ? readCompletionHandoff(repo.id, id) : null;
  const owner = ownerPacket(id);
  if (!record) return currentCapturedContext;
  if (!owner || record.laneId !== lane.id || record.sessionKey !== lane.sessionKey
    || !packetReleaseIdentityIsCurrent(owner.packet, lane.id, record.owner.generation, true)
    || turnCursor(lane.id) !== record.owner.turnCursor) return null;
  return completionContextRecovery(record);
}

/** Receipts and the process cache are audit evidence, not authority to recall forgotten memory. */
export async function readPacketCompletionContext(packetId: string): Promise<PacketContext | null> {
  const context = await readUnfilteredCompletionContext(packetId);
  if (!context || isOutcomeForgotten(context.sourceOutcomeId ?? completionOutcomeId(context), context.sourceOutcomeFingerprint)
    || (!context.sourceOutcomeFingerprint && hasForgottenPacketOutcome(context.packetId))
    || hasForgottenPacketOutcome(context.packetId, true)) return null;
  if ((context.memoryRevision ?? '0') === readMemoryRevision()) return context;
  // Review lessons can be flattened operator corrections with no per-fragment ID.
  return { ...context, attemptLearnings: undefined, review: undefined, reviewFindings: undefined, patterns: undefined, conflictZones: undefined };
}
