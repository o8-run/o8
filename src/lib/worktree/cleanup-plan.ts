import { randomUUID } from 'node:crypto';
import { lstat, statfs } from 'node:fs/promises';
import path from 'node:path';

import { findRepoByLocalPath } from '@/lib/repos/registry';
import { withResourceLease } from '@/lib/leases/resource-lease-guard';
import { withManagedRetirementOwnership } from '@/lib/workspace/retirement-process-authority';
import { readExactWorkspaceClaim } from '@/lib/workspace/exact-workspace-claim-state';
import { currentGeneratedOutputResource, readGeneratedOutputResource } from '@/lib/workspace/generated-output-state';
import { retireGeneratedOutput } from '@/lib/workspace/generated-output-retirement';
import { verifyGeneratedOutputBank } from '@/lib/workspace/generated-output-bank';
import { verifyGeneratedOutputRecovery } from '@/lib/workspace/generated-output-recovery';
import { exactSnapshot, getWorkspaceRetirementPreservationId } from '@/lib/workspace/workspace-materialization-retirement';
import { readWorkspacePreservation } from '@/lib/workspace/preservation-store';
import { cleanupLaneWorktree } from '@/lib/lane/worktree-cleanup';
import { getLane } from '@/lib/lane/registry';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity } from './materialization-identity';
import { canonicalRepoRoot } from './root-layout';
import { getWorktreeManager } from './launch';
import { readMaintenanceState, writeMaintenanceState } from './maintenance-discovery';
import { cleanupFingerprint, cleanupPlanInventory, inspectCleanupWorkspace, inspectCleanupGenerated, readCleanupMetadata } from './cleanup-plan-inventory';
import type { CleanupPlanEntry, CleanupPlanOutcome, WorkspaceCleanupPlan } from './cleanup-plan-types';

export class CleanupPlanError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
const key = (id: string) => `cleanup-plan:${id}`;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
function save(plan: WorkspaceCleanupPlan) { writeMaintenanceState(key(plan.id), plan); return plan; }
export function readCleanupPlan(id: string): WorkspaceCleanupPlan {
  if (!validId(id)) throw new CleanupPlanError('Invalid cleanup plan.', 400);
  const plan = readMaintenanceState<WorkspaceCleanupPlan>(key(id));
  if (!plan || plan.schema !== 'o8/workspace-cleanup-plan/v1' || plan.id !== id) throw new CleanupPlanError('Cleanup plan was not found.', 404);
  return plan;
}

async function observeFreeSpace(plan: WorkspaceCleanupPlan) {
  try {
    const stat = await statfs(plan.repositoryPath);
    const observation = { observedAt: Date.now(), availableBytes: Number(stat.bavail) * Number(stat.bsize) };
    if (plan.observedFreeSpace.length < 2) plan.observedFreeSpace.push(observation);
    else plan.observedFreeSpace[1] = observation;
  } catch { /* Unknown is not zero; observed changes are never attributed exclusively to this plan. */ }
}

export async function previewCleanupPlan(repoPath: string): Promise<WorkspaceCleanupPlan> {
  if (!path.isAbsolute(repoPath) || repoPath.includes('\0') || repoPath.length > 4096) throw new CleanupPlanError('Select one absolute registered repository path.', 400);
  const repositoryPath = canonicalRepoRoot(repoPath);
  const repo = await findRepoByLocalPath(repositoryPath);
  if (!repo) throw new CleanupPlanError('Repository is not registered.', 400);
  const repositoryIdentity = await captureWorktreeMaterializationIdentity(repositoryPath);
  const inventory = await cleanupPlanInventory(repositoryPath);
  const createdAt = Date.now();
  const plan: WorkspaceCleanupPlan = { schema: 'o8/workspace-cleanup-plan/v1', id: randomUUID(),
    repositoryPath, repositoryId: repo.id, repositoryIdentity, ...inventory, createdAt, expiresAt: createdAt + 15 * 60_000,
    fingerprint: cleanupFingerprint({ repositoryPath, repositoryId: repo.id, repositoryIdentity, entries: inventory.entries }),
    status: 'preview', selection: null, approvedAt: null, outcomes: [], observedFreeSpace: [] };
  await observeFreeSpace(plan);
  return save(plan);
}

async function completedRecovery(plan: WorkspaceCleanupPlan, entry: CleanupPlanEntry): Promise<CleanupPlanOutcome['recovery'] | null> {
  const removedPath = entry.kind === 'workspace' ? entry.workspacePath : path.join(entry.workspacePath, '.next');
  if (await lstat(removedPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) return null;
  if (entry.kind === 'generated-output') {
    const resource = readGeneratedOutputResource(entry.resourceId!);
    if (resource?.state !== 'retired' || !resource.retirement || !resource.bank || resource.bank.digest !== entry.bankDigest
      || resource.workspace.device !== entry.identity?.device || resource.workspace.inode !== entry.identity?.inode
      || resource.owner?.repositoryPath !== plan.repositoryPath || resource.owner.worktreeId !== entry.worktreeId) return null;
    await verifyGeneratedOutputBank(resource.bank);
    await verifyGeneratedOutputRecovery(resource);
    return { bankPath: resource.bank.root.canonicalPath, recoveryPath: resource.recovery?.path };
  }
  const snapshot = exactSnapshot(entry.workspacePath);
  const preservationId = getWorkspaceRetirementPreservationId(entry.workspacePath);
  if (!snapshot || snapshot.state !== 'retired' || snapshot.repositoryUuid !== plan.repositoryId
    || snapshot.packetId !== entry.completion?.packetId || snapshot.laneId !== entry.completion?.laneId
    || snapshot.headCommit !== entry.head || !preservationId) return null;
  const preserved = await readWorkspacePreservation(preservationId);
  if (preserved.receipt.sourceDevice !== entry.identity?.device || preserved.receipt.sourceInode !== entry.identity?.inode
    || preserved.receipt.headCommit !== entry.head) return null;
  return { ref: snapshot.recoveryRef, preservationId };
}

function pendingClaim(plan: WorkspaceCleanupPlan, entry: CleanupPlanEntry, startedAt: number) {
  const claim = readExactWorkspaceClaim(entry.kind === 'workspace' ? 'managed-retirement' : 'generated-output-retirement',
    plan.repositoryPath, entry.resourceId ?? entry.worktreeId);
  const identity = entry.kind === 'workspace' ? entry.identity : entry.outputIdentity;
  const sourcePath = entry.kind === 'workspace' ? entry.workspacePath : path.join(entry.workspacePath, '.next');
  if (!claim || claim.sourcePath !== sourcePath || claim.createdAt < startedAt
    || claim.sourceIdentity?.device !== identity?.device || claim.sourceIdentity?.inode !== identity?.inode) return null;
  if (entry.kind === 'generated-output' && (!claim.authority || claim.authority.resourceId !== entry.resourceId
    || claim.authority.resourceVersion !== entry.resourceVersion || claim.authority.bankDigest !== entry.bankDigest)) return null;
  return claim;
}

async function executeEntry(plan: WorkspaceCleanupPlan, entry: CleanupPlanEntry, previous?: CleanupPlanOutcome) {
  return withManagedRetirementOwnership(plan.repositoryPath, entry.workspacePath, async (): Promise<CleanupPlanOutcome> => {
    const startedAt = previous?.startedAt ?? Date.now();
    const outcome: CleanupPlanOutcome = { entryId: entry.id, state: 'started', startedAt };
    let mutationStarted = false;
    const removedPath = entry.kind === 'workspace' ? entry.workspacePath : path.join(entry.workspacePath, '.next');
    const absent = () => lstat(removedPath).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
    const record = () => {
      const index = plan.outcomes.findIndex(item => item.entryId === entry.id);
      if (index < 0) plan.outcomes.push(outcome); else plan.outcomes[index] = outcome;
      save(plan);
    };
    try {
      await assertWorktreeMaterializationIdentity(plan.repositoryPath, plan.repositoryIdentity);
      if ((await findRepoByLocalPath(plan.repositoryPath))?.id !== plan.repositoryId) throw new Error('Registered repository identity changed.');
      if (previous?.state === 'started') {
        const recovered = await completedRecovery(plan, entry);
        if (recovered) {
          outcome.state = 'removed'; outcome.recovery = recovered;
          outcome.removedPaths = [entry.kind === 'workspace' ? entry.workspacePath : path.join(entry.workspacePath, '.next')];
          outcome.finishedAt = Date.now(); record(); return outcome;
        }
        if (await absent() && !pendingClaim(plan, entry, startedAt)) {
          mutationStarted = true;
          throw new Error('Removal is unresolved until its retained lifecycle recovery can be verified.');
        }
      }
      const resumingExactClaim = previous?.state === 'started' ? pendingClaim(plan, entry, startedAt) : null;
      if (Date.now() > plan.expiresAt && !resumingExactClaim) throw new Error('The preview expired before this lifecycle operation started.');
      if (!resumingExactClaim) {
        const metadata = (await readCleanupMetadata(plan.repositoryPath))[entry.worktreeId];
        const workspace = await inspectCleanupWorkspace(plan.repositoryPath, entry.worktreeId, metadata);
        const current = entry.kind === 'workspace' ? workspace : await inspectCleanupGenerated(workspace, plan.repositoryPath);
        if (!current?.eligible || current.fingerprint !== entry.fingerprint) throw new Error(current?.reason || 'Selected generation, source or completion evidence changed.');
        if (entry.kind === 'workspace') {
          if (currentGeneratedOutputResource(entry.workspacePath)
            || await lstat(path.join(entry.workspacePath, '.next')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
            throw new Error('A new, unregistered or held generated-output generation is not in the approved selection.');
          }
        }
      }
      for (const dependency of entry.dependencies) {
        if (!plan.outcomes.some(item => item.entryId === dependency && item.state === 'removed')) throw new Error('Selected generated-output consumer has not retired.');
      }
      record(); // Intent precedes the existing lifecycle operation, including every uncertain reply.
      mutationStarted = true;
      if (entry.kind === 'generated-output') await retireGeneratedOutput(entry.resourceId!);
      else {
        const lane = getLane(entry.completion!.laneId);
        if (!lane || !['completed', 'archived'].includes(lane.status) || lane.packetId !== entry.completion!.packetId) throw new Error('Terminal owner changed.');
        const removed = resumingExactClaim
          ? await getWorktreeManager(plan.repositoryPath).cleanup(entry.worktreeId, { deleteBranch: false,
            expectedCreation: { path: entry.workspacePath, branch: entry.branch!, createdAt: entry.createdAt } })
          : await cleanupLaneWorktree(lane, { terminal: true, deleteBranch: false });
        if (!removed) throw new Error('Existing lifecycle retained the workspace: ownership, consumers, preservation or process checks refused.');
      }
      if (await lstat(removedPath).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Selected path still exists after retirement.');
      const recovery = await completedRecovery(plan, entry);
      if (!recovery) throw new Error('Retirement completion lacks retained recovery evidence.');
      outcome.state = 'removed'; outcome.removedPaths = [removedPath]; outcome.recovery = recovery;
    } catch (error) {
      outcome.reason = error instanceof Error ? error.message : 'Cleanup could not be verified.';
      // A lost native reply is reconciled from retained lifecycle truth, never retried as a new deletion.
      const recovery = mutationStarted ? await completedRecovery(plan, entry).catch(() => null) : null;
      if (recovery) { outcome.state = 'removed'; outcome.recovery = recovery; outcome.removedPaths = [removedPath]; }
      else outcome.state = pendingClaim(plan, entry, startedAt)
        || (mutationStarted && await absent().catch(() => true)) ? 'started' : 'held';
    }
    if (outcome.state !== 'started') outcome.finishedAt = Date.now();
    record(); return outcome;
  }).catch(error => {
    // The wrapper can fail after its callback (for example while releasing ownership).
    // Preserve this attempt's recorded intent or completion, including recovery truth.
    const current = plan.outcomes.find(item => item.entryId === entry.id) ?? previous;
    const outcome: CleanupPlanOutcome = current ? { ...current } : { entryId: entry.id, state: 'held', startedAt: Date.now() };
    outcome.reason = error instanceof Error ? error.message : 'Lifecycle admission is unavailable.';
    if (outcome.state === 'held') outcome.finishedAt = Date.now();
    const index = plan.outcomes.findIndex(item => item.entryId === entry.id);
    if (index < 0) plan.outcomes.push(outcome); else plan.outcomes[index] = outcome;
    save(plan); return outcome;
  });
}

export async function executeCleanupPlan(input: { planId: string; fingerprint: string; selection: string[] }) {
  if (!validId(input.planId)) throw new CleanupPlanError('Invalid cleanup plan.', 400);
  const leased = await withResourceLease({ resource: `workspace-cleanup-plan:${input.planId}`,
    owner: { id: `cleanup:${input.planId}`, label: 'Reviewed workspace cleanup', pid: process.pid }, actor: 'operator', maxWaitMs: 1000 }, async () => {
    const plan = readCleanupPlan(input.planId);
    if (input.fingerprint !== plan.fingerprint || !Array.isArray(input.selection) || !input.selection.length
      || input.selection.length > 100 || new Set(input.selection).size !== input.selection.length
      || input.selection.some(id => typeof id !== 'string' || !plan.entries.some(entry => entry.id === id && entry.eligible))) {
      throw new CleanupPlanError('Fingerprint or selection does not match the reviewed plan.');
    }
    const selection = [...input.selection].sort();
    if (plan.selection && JSON.stringify(plan.selection) !== JSON.stringify(selection)) throw new CleanupPlanError('An approved selection cannot be changed; preview another plan.');
    if (selection.some(id => plan.entries.find(entry => entry.id === id)!.dependencies.some(dependency => !selection.includes(dependency)))) throw new CleanupPlanError('Select the generated-output consumers before their containing workspace.');
    if (plan.status === 'settled') return plan;
    if (!plan.selection) {
      if (Date.now() > plan.expiresAt) throw new CleanupPlanError('Cleanup preview expired; preview again.');
      plan.selection = selection; plan.approvedAt = Date.now(); plan.status = 'running'; save(plan);
    }
    const ordered = plan.entries.filter(entry => selection.includes(entry.id)).sort((a, b) =>
      Number(a.kind === 'workspace') - Number(b.kind === 'workspace') || a.id.localeCompare(b.id));
    let attempts = 0;
    for (const entry of ordered) {
      const previous = plan.outcomes.find(item => item.entryId === entry.id);
      if (previous && previous.state !== 'started') continue;
      if (entry.dependencies.some(id => !plan.outcomes.some(outcome => outcome.entryId === id && outcome.state !== 'started'))) continue;
      if (Date.now() > plan.expiresAt && !previous) {
        plan.outcomes.push({ entryId: entry.id, state: 'held', startedAt: Date.now(), finishedAt: Date.now(), reason: 'Approved preview expired before this entry started.' }); save(plan); continue;
      }
      await executeEntry(plan, entry, previous);
      if (++attempts === 5) break;
    }
    plan.status = selection.every(id => plan.outcomes.some(item => item.entryId === id && item.state !== 'started')) ? 'settled' : 'running';
    await observeFreeSpace(plan); return save(plan);
  });
  if (leased.state === 'refused') throw new CleanupPlanError('This cleanup plan is already running or its owner cannot be verified.');
  return leased.value;
}
