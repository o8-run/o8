import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

import { getSqlite } from '@/lib/db';
import { laneGit } from '@/lib/lane/lane-git';
import { getLane } from '@/lib/lane/registry';
import { getWorkspaceRetentionHold } from '@/lib/workspace/retention-holds';
import { currentGeneratedOutputResource } from '@/lib/workspace/generated-output-state';
import { verifyGeneratedOutputBank } from '@/lib/workspace/generated-output-bank';
import { verifyGeneratedOutputRecovery } from '@/lib/workspace/generated-output-recovery';
import { resolveWorktreeRootLayout } from './root-layout';
import { assertWorktreeMaterializationIdentity } from './materialization-identity';
import { readWorktreeMetaSnapshot } from './metadata-store';
import { WORKTREE_MAINTENANCE_POLICY, withWorktreeMaintenanceBudget } from './maintenance-budget';
import { probeLiveProcessInside } from './live-process-guard';
import { cleanupIgnoredFingerprint } from './cleanup-plan-ignored';
import type { WorktreeMetaEntry } from './types';
import type { CleanupPlanEntry } from './cleanup-plan-types';

export const cleanupFingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const CLEANUP_PLAN_LIMIT = 50;
export const readCleanupMetadata = (repositoryPath: string) => withWorktreeMaintenanceBudget({
  remainingBytes: WORKTREE_MAINTENANCE_POLICY.metadataBytes, readBytes: 0,
  rootBytes: WORKTREE_MAINTENANCE_POLICY.rootBytes, rootEntries: WORKTREE_MAINTENANCE_POLICY.rootEntries,
}, () => readWorktreeMetaSnapshot(repositoryPath));

/** Reads current manager ownership, never infers removal authority from a directory name. */
export async function inspectCleanupWorkspace(repositoryPath: string, worktreeId: string,
  entry: WorktreeMetaEntry | undefined, options: { allowedClaimOperationId?: string; omitDependencyMount?: boolean } = {}): Promise<CleanupPlanEntry> {
  const identity = entry?.materializationIdentity ?? null;
  const result: CleanupPlanEntry = { id: `workspace:${worktreeId}`, kind: 'workspace', worktreeId,
    workspacePath: identity?.canonicalPath ?? '', identity, eligible: false, reason: null, fingerprint: '',
    completion: null, head: null, branch: entry?.branchName ?? null, createdAt: entry?.createdAt ?? 0,
    dependencies: [], estimate: { logicalBytes: null, exclusiveBytes: null }, recovery: {} };
  let ignored: string | null = null;
  try {
    if (!entry || entry.claudeManaged || !identity || !entry.materializationParentIdentity) throw new Error('Exact o8-created ownership is unavailable.');
    const managed = identity.canonicalPath;
    const bases = await Promise.all(resolveWorktreeRootLayout(repositoryPath).bases.map(base => realpath(base).catch(() => path.resolve(base))));
    if (path.basename(managed) !== worktreeId || !bases.includes(path.dirname(managed))
      || path.dirname(managed) !== entry.materializationParentIdentity.canonicalPath) {
      throw new Error('Manager path no longer matches the captured generation.');
    }
    await assertWorktreeMaterializationIdentity(managed, identity);
    await assertWorktreeMaterializationIdentity(path.dirname(managed), entry.materializationParentIdentity);
    const rows = getSqlite().prepare('SELECT id FROM lanes WHERE repo_path = ? AND worktree_path = ? LIMIT 2')
      .all(repositoryPath, managed) as Array<{ id: string }>;
    const lane = rows.length === 1 ? getLane(rows[0]!.id) : null;
    if (!lane || !lane.packetId || !['completed', 'archived'].includes(lane.status)
      || (entry.laneId && entry.laneId !== lane.id) || (entry.packetId && entry.packetId !== lane.packetId)) {
      throw new Error('One exact terminal lane owner is required.');
    }
    result.completion = { laneId: lane.id, packetId: lane.packetId, status: lane.status, updatedAt: lane.updatedAt };
    const hold = getWorkspaceRetentionHold(managed, identity);
    if (hold) throw new Error(`Retention hold: ${hold.reason}`);
    const claim = getSqlite().prepare(`SELECT operation_id FROM workspace_exact_claims
      WHERE operation_id != ? AND (expected_path = ? OR source_path = ? OR parent_canonical_path = ?) LIMIT 1`)
      .get(options.allowedClaimOperationId ?? '', managed, managed, managed);
    if (claim) throw new Error('An existing exact lifecycle operation must be resolved before a new preview.');
    const probe = await probeLiveProcessInside(managed);
    if (probe.status !== 'clear') throw new Error('A live or unverified process still uses this workspace.');
    const status = await laneGit(managed, repositoryPath, ['status', '--porcelain=v1', '--untracked-files=all'], { timeout: 5_000 });
    if (status.stdout.trim()) throw new Error('Uncommitted or untracked source must be resolved first.');
    result.head = (await laneGit(managed, repositoryPath, ['rev-parse', '--verify', 'HEAD'], { timeout: 5_000 })).stdout.trim();
    const branch = (await laneGit(managed, repositoryPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 5_000 })).stdout.trim();
    if (!result.branch || branch !== result.branch) throw new Error('Workspace branch changed.');
    // Keep this verified ref; execution never requests branch deletion.
    const refHead = (await laneGit(repositoryPath, repositoryPath, ['rev-parse', '--verify', `refs/heads/${branch}`], { timeout: 5_000 })).stdout.trim();
    if (refHead !== result.head) throw new Error('Source branch does not retain the selected HEAD.');
    result.recovery = { ref: `refs/heads/${branch}` };
    ignored = await cleanupIgnoredFingerprint(repositoryPath, managed, false, options.omitDependencyMount);
    result.eligible = true;
  } catch (error) { result.reason = error instanceof Error ? error.message : 'Ownership or recovery could not be verified.'; }
  result.fingerprint = cleanupFingerprint({ entry, completion: result.completion, head: result.head, reason: result.reason, ignored });
  return result;
}

export async function inspectCleanupGenerated(workspace: CleanupPlanEntry, repositoryPath: string): Promise<CleanupPlanEntry | null> {
  if (!workspace.identity) return null;
  let resource: ReturnType<typeof currentGeneratedOutputResource>;
  try { resource = currentGeneratedOutputResource(workspace.workspacePath); }
  catch (error) {
    return { ...workspace, id: `generated-output:unresolved:${workspace.worktreeId}`, kind: 'generated-output',
      eligible: false, reason: error instanceof Error ? error.message : 'Generated-output state is unresolved.', dependencies: [],
      fingerprint: cleanupFingerprint({ workspace: workspace.fingerprint, unresolved: true }) };
  }
  if (!resource) return null;
  const result: CleanupPlanEntry = { ...workspace, id: `generated-output:${resource.resourceId}`, kind: 'generated-output',
    resourceId: resource.resourceId, resourceVersion: resource.version, bankDigest: resource.bank?.digest,
    outputIdentity: resource.output ?? undefined,
    dependencies: [], estimate: { logicalBytes: resource.bank?.expandedBytes ?? null, exclusiveBytes: null },
    recovery: { bankPath: resource.bank?.root.canonicalPath, recoveryPath: resource.recovery?.path } };
  let ignored: string | null = null;
  if (!workspace.eligible) { /* Keep the containing-workspace hold. */ }
  else if (resource.owner?.worktreeId !== workspace.worktreeId || resource.owner.repositoryPath !== repositoryPath
    || resource.workspace.canonicalPath !== workspace.workspacePath
    || resource.workspace.device !== workspace.identity.device || resource.workspace.inode !== workspace.identity.inode
    || resource.state !== 'adopted' || !resource.output || !resource.bank || !resource.adoption
    || resource.recovery?.state !== 'complete' || resource.recovery.bankDigest !== resource.bank.digest) {
    result.eligible = false; result.reason = 'Generated output lacks adopted ownership, a bank or verified recovery; retain it.';
  } else {
    try {
      await assertWorktreeMaterializationIdentity(path.join(workspace.workspacePath, '.next'), resource.output);
      await verifyGeneratedOutputBank(resource.bank);
      await verifyGeneratedOutputRecovery(resource);
      const hold = getWorkspaceRetentionHold(path.join(workspace.workspacePath, '.next'), resource.output);
      if (hold) throw new Error(`Retention hold: ${hold.reason}`);
      ignored = await cleanupIgnoredFingerprint(repositoryPath, workspace.workspacePath, true);
    } catch (error) { result.eligible = false; result.reason = error instanceof Error ? error.message : 'Generated-output identity changed.'; }
  }
  result.fingerprint = cleanupFingerprint({ workspace: workspace.fingerprint, resource, ignored });
  return result;
}

export async function cleanupPlanInventory(repositoryPath: string) {
  const metadata = await readCleanupMetadata(repositoryPath);
  const keys = Object.keys(metadata).sort();
  const entries: CleanupPlanEntry[] = [];
  for (const id of keys.slice(0, CLEANUP_PLAN_LIMIT)) {
    const workspace = await inspectCleanupWorkspace(repositoryPath, id, metadata[id]);
    const output = await inspectCleanupGenerated(workspace, repositoryPath);
    if (output) {
      entries.push(output); workspace.dependencies.push(output.id);
      if (!output.eligible) { workspace.eligible = false; workspace.reason = 'Containing generated output remains held.'; }
    } else if (workspace.workspacePath && await lstat(path.join(workspace.workspacePath, '.next')).then(() => true, error => {
      if (error.code === 'ENOENT') return false; throw error;
    })) { workspace.eligible = false; workspace.reason = 'Unregistered generated output requires its existing lifecycle authority.'; }
    entries.push(workspace);
  }
  return { entries, truncated: keys.length > CLEANUP_PLAN_LIMIT };
}
