import { childEnvironment } from '@/lib/providers/spawn-environment';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { withPacketLifecycleSpawnLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { materializationAwareExecFile, withWorktreeMaterializationExecution } from '@/lib/worktree/materialization-execution';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import type { MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { ensureMaintenanceDiscoverySchema } from '@/lib/worktree/maintenance-discovery';
import { readWorktreeMetaSnapshot } from '@/lib/worktree/metadata-store';
import { LEGACY_WORKTREE_DIR_NAME, resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';
import { createExactChildDirectory, readExactChildFile, writeExactChildFile } from './exact-parent-operation';
import type { ExactDirectoryManifest } from './exact-directory-purge';
import type { GeneratedOutputBank } from './generated-output-bank';
import type { ExactWorkspaceClaimRecord } from './exact-workspace-claim-state';
import { readExactWorkspaceClaim } from './exact-workspace-claim-state';
import { readExactManagedFinalization } from './exact-managed-finalization-state';
import { readGeneratedOutputRecoveryHistory, recordGeneratedOutputRecoveryHistory } from './generated-output-recovery-history';
import { validateGeneratedOutputResource } from './generated-output-validation';
import { assertWorkspaceRetentionReleased } from './retention-holds';
import type { LinkedGitBuildCustody } from './linked-git-build-custody';
import { withManagedRetirementOwnership } from './retirement-process-authority';
import { readFailedPrebuildPark, retainedFailedPrebuild, verifyRetainedFailedPrebuild } from './failed-prebuild-parking';

export type GeneratedOutputState = 'planned' | 'legacy-held' | 'ready' | 'active'
  | 'succeeded' | 'failed-held' | 'adopted' | 'retired';

export interface GeneratedOutputRecovery {
  operationId: string;
  purpose: 'recovery' | 'verification-disposable';
  path: string;
  parent: WorktreeMaterializationIdentity;
  ownerPid: number;
  ownerIdentity: MetadataLockProcessIdentity;
  createdAt: number;
  root: WorktreeMaterializationIdentity | null;
  state: 'planned' | 'restoring' | 'complete' | 'failed-held' | 'retired';
  bankDigest: string;
  completedAt?: number;
  retirement?: { operationId: string; retiredAt: number; claim: ExactWorkspaceClaimRecord };
}

export interface GeneratedOutputResource {
  schema: 'o8/generated-output-resource/v1';
  resourceId: string;
  workspace: WorktreeMaterializationIdentity;
  output: WorktreeMaterializationIdentity | null;
  state: GeneratedOutputState;
  origin: 'managed-creation' | 'legacy-observation' | 'legacy-adoption';
  version: number;
  createdAt: number;
  updatedAt: number;
  revision: { head: string; tree: string; dirty: boolean; workingDigest: string };
  owner?: { repositoryPath: string; worktreeId: string };
  creationAuthority?: { kind: 'prebuild'; pid: number; identity: MetadataLockProcessIdentity; linkedGit?: LinkedGitBuildCustody };
  attempt?: { id: string; mode: string; ownerPid: number; ownerIdentity: MetadataLockProcessIdentity;
    children: Array<{ pid: number; identity: MetadataLockProcessIdentity | null; exitCode: number | null;
      signal: string | null; observedClosed: boolean }> };
  buildOwnership?: { scope: WorktreeMaterializationIdentity; state: 'reserved' | 'complete';
    proof?: 'write-receipts-v1'; manifest?: ExactDirectoryManifest };
  bank?: GeneratedOutputBank;
  bankCapture?: { operationId: string; path: string; parent: WorktreeMaterializationIdentity;
    ownerPid: number; ownerIdentity: MetadataLockProcessIdentity;
    identity: WorktreeMaterializationIdentity | null; files: WorktreeMaterializationIdentity | null;
    state: 'planned' | 'capturing' | 'failed-held' | 'verified' };
  adoption?: { intent: string; at: number; evidence: Array<{ path: string; sha256: string }>;
    producerOutcome?: 'terminal-failure' };
  retirement?: { operationId: string; retiredAt: number; expandedBytes: number; bankDigest: string;
    verifiedRecoveryOperationId: string; claim: ExactWorkspaceClaimRecord };
  disposal?: { kind: 'postship'; retiredAt: number; claim: ExactWorkspaceClaimRecord };
  recovery?: GeneratedOutputRecovery;
  continuedFrom?: { resourceId: string; operationId: string };
}

interface ResourceRow { payload_json: string; version: number; state: GeneratedOutputState; retained_operation_id: string | null;
  workspace_path: string; created_at: number; updated_at: number }

/** Indexed discovery only selects the repo; current manager metadata proves ownership. */
export async function generatedOutputOwner(workspace: WorktreeMaterializationIdentity): Promise<GeneratedOutputResource['owner']> {
  ensureMaintenanceDiscoverySchema();
  const parent = path.dirname(workspace.canonicalPath);
  const discovered = getSqlite().prepare('SELECT repository_path FROM worktree_maintenance_roots WHERE metadata_root = ?')
    .get(parent) as { repository_path: string } | undefined;
  const repositoryPath = discovered?.repository_path
    || (path.basename(parent) === LEGACY_WORKTREE_DIR_NAME ? path.dirname(parent) : undefined);
  if (!repositoryPath) return undefined;
  const layout = resolveWorktreeRootLayout(repositoryPath);
  const bases = await Promise.all(layout.bases.map(base => realpath(base).catch(() => path.resolve(base))));
  if (!bases.includes(parent)) throw new Error('Generated-output manager root association is invalid.');
  const worktreeId = path.basename(workspace.canonicalPath);
  const metadata = (await readWorktreeMetaSnapshot(repositoryPath))[worktreeId];
  if (!metadata || metadata.claudeManaged || metadata.materializationIdentity?.canonicalPath !== workspace.canonicalPath
    || metadata.materializationIdentity.device !== workspace.device || metadata.materializationIdentity.inode !== workspace.inode
    || metadata.materializationParentIdentity?.canonicalPath !== parent) {
    throw new Error('Generated-output containing manager ownership is unknown.');
  }
  await assertWorktreeMaterializationIdentity(parent, metadata.materializationParentIdentity);
  return { repositoryPath, worktreeId };
}

export function readGeneratedOutputResource(resourceId: string): GeneratedOutputResource | null {
  const row = getSqlite().prepare('SELECT * FROM workspace_generated_outputs WHERE resource_id = ?')
    .get(resourceId) as ResourceRow | undefined;
  if (!row) return null;
  if (Buffer.byteLength(row.payload_json) > 16 * 1024 ** 2) throw new Error('Generated-output state exceeds its bound.');
  const resource = JSON.parse(row.payload_json) as GeneratedOutputResource;
  validateGeneratedOutputResource(resource);
  if (resource.schema !== 'o8/generated-output-resource/v1' || resource.resourceId !== resourceId
    || resource.version !== row.version || resource.state !== row.state
    || resource.workspace.canonicalPath !== row.workspace_path || resource.createdAt !== row.created_at
    || resource.updatedAt !== row.updated_at) throw new Error('Generated-output state is invalid.');
  if (resource.recovery && JSON.stringify(readGeneratedOutputRecoveryHistory(resourceId, resource.recovery.operationId))
    !== JSON.stringify(resource.recovery)) throw new Error('Generated-output current recovery lost its durable history.');
  if (resource.recovery?.state === 'retired'
    && readExactManagedFinalization(resource.recovery.retirement!.claim)?.state !== 'complete') {
    throw new Error('Generated-output retired recovery lost its exact finalization.');
  }
  if (resource.retirement) {
    const verified = readGeneratedOutputRecoveryHistory(resourceId, resource.retirement.verifiedRecoveryOperationId);
    if (!verified || !['complete', 'retired'].includes(verified.state) || verified.bankDigest !== resource.bank!.digest
      || readExactManagedFinalization(resource.retirement.claim)?.state !== 'complete') {
      throw new Error('Generated-output source retirement lost its verified recovery or finalization.');
    }
    validateGeneratedOutputResource({ ...resource, recovery: verified });
    if (verified.state === 'retired'
      && readExactManagedFinalization(verified.retirement!.claim)?.state !== 'complete') {
      throw new Error('Generated-output verified recovery lost its retirement finalization.');
    }
  }
  if (resource.disposal && readExactManagedFinalization(resource.disposal.claim)?.state !== 'complete') {
    throw new Error('Generated-output disposal lost its exact finalization.');
  }
  if (row.retained_operation_id) {
    const parked = readFailedPrebuildPark(row.retained_operation_id);
    if (parked.state !== 'parked' || JSON.stringify(parked.resource) !== JSON.stringify(resource)) {
      throw new Error('Failed prebuild namespace release lost its exact preservation journal.');
    }
  }
  if (resource.continuedFrom) {
    const parked = readFailedPrebuildPark(resource.continuedFrom.operationId);
    const predecessor = getSqlite().prepare('SELECT payload_json, retained_operation_id FROM workspace_generated_outputs WHERE resource_id = ?')
      .get(parked.resource.resourceId) as { payload_json: string; retained_operation_id: string | null } | undefined;
    if (parked.state !== 'parked' || parked.resource.resourceId !== resource.continuedFrom.resourceId
      || JSON.stringify(parked.resource.workspace) !== JSON.stringify(resource.workspace)
      || !predecessor || predecessor.retained_operation_id !== parked.operationId
      || JSON.stringify(parked.resource) !== predecessor.payload_json) {
      throw new Error('Fresh prebuild lost its preserved predecessor.');
    }
  }
  return resource;
}

/** Completed disposal retains successful producer history without owning a new output generation. */
export function lastDisposedPrebuildOutput(workspacePath: string): GeneratedOutputResource | null {
  const row = getSqlite().prepare(`SELECT resource_id FROM workspace_generated_outputs
    WHERE workspace_path = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(path.resolve(workspacePath)) as { resource_id: string } | undefined;
  const resource = row ? readGeneratedOutputResource(row.resource_id) : null;
  return resource?.disposal ? resource : null;
}

export function currentGeneratedOutputResource(workspacePath: string): GeneratedOutputResource | null {
  const row = getSqlite().prepare(`SELECT resource_id FROM workspace_generated_outputs
    WHERE workspace_path = ? AND state != 'retired' AND retained_operation_id IS NULL`).get(path.resolve(workspacePath)) as { resource_id: string } | undefined;
  return row ? readGeneratedOutputResource(row.resource_id) : null;
}

export function saveGeneratedOutputResource(resource: GeneratedOutputResource,
  changes: Partial<GeneratedOutputResource>): GeneratedOutputResource {
  const next = { ...resource, ...changes, resourceId: resource.resourceId,
    version: resource.version + 1, updatedAt: Date.now() };
  if (JSON.stringify(next.workspace) !== JSON.stringify(resource.workspace) || next.createdAt !== resource.createdAt
    || (resource.output && JSON.stringify(next.output) !== JSON.stringify(resource.output))
    || JSON.stringify(next.owner) !== JSON.stringify(resource.owner)
    || JSON.stringify(next.creationAuthority) !== JSON.stringify(resource.creationAuthority)
    || JSON.stringify(next.continuedFrom) !== JSON.stringify(resource.continuedFrom)
    || (resource.buildOwnership && next.attempt?.id === resource.attempt?.id
      && (JSON.stringify(next.buildOwnership?.scope) !== JSON.stringify(resource.buildOwnership.scope)
        || (resource.buildOwnership.state === 'complete'
          && JSON.stringify(next.buildOwnership) !== JSON.stringify(resource.buildOwnership))))
    || (resource.bank && JSON.stringify(next.bank) !== JSON.stringify(resource.bank))
    || (resource.disposal && (next.state !== 'retired'
      || JSON.stringify(next.disposal) !== JSON.stringify(resource.disposal)
      || JSON.stringify(next.attempt) !== JSON.stringify(resource.attempt)))
    || (resource.retirement && (next.state !== 'retired'
      || JSON.stringify(next.retirement) !== JSON.stringify(resource.retirement)))) {
    throw new Error('Generated-output immutable ownership or completed preservation changed.');
  }
  validateGeneratedOutputResource(next);
  if (Buffer.byteLength(JSON.stringify(next)) > 16 * 1024 ** 2) throw new Error('Generated-output state exceeds its bound.');
  return getSqlite().transaction(() => {
    const result = getSqlite().prepare(`UPDATE workspace_generated_outputs
      SET payload_json = ?, state = ?, version = ?, updated_at = ? WHERE resource_id = ? AND version = ? AND retained_operation_id IS NULL`)
      .run(JSON.stringify(next), next.state, next.version, next.updatedAt, next.resourceId, resource.version);
    if (result.changes !== 1) throw new Error('Generated-output state lost its trusted CAS.');
    recordGeneratedOutputRecoveryHistory(resource.resourceId, resource.recovery, next.recovery);
    return next;
  }).immediate();
}

/** Exclude only this resource's durable claim, never a retirement-style prefix. */
function retirementClaimPathspec(workspace: WorktreeMaterializationIdentity,
  claim?: ExactWorkspaceClaimRecord): string[] {
  if (!claim) return [];
  const current = readExactWorkspaceClaim(claim.kind, claim.repositoryPath, claim.worktreeId);
  const resource = readGeneratedOutputResource(claim.worktreeId);
  if (claim.kind !== 'generated-output-retirement' || !resource?.owner || !resource.output || !resource.bank
    || resource.state !== 'adopted' || JSON.stringify(current) !== JSON.stringify(claim)
    || resource.workspace.canonicalPath !== workspace.canonicalPath
    || resource.workspace.device !== workspace.device || resource.workspace.inode !== workspace.inode
    || claim.repositoryPath !== resource.owner.repositoryPath || claim.authority?.resourceId !== resource.resourceId
    || claim.authority.resourceVersion !== resource.version || claim.contentDigest !== resource.bank.digest
    || claim.authority.bankDigest !== resource.bank.digest
    || claim.expectedPath !== resource.output.canonicalPath || claim.sourcePath !== resource.output.canonicalPath
    || claim.parentIdentity.canonicalPath !== workspace.canonicalPath
    || claim.parentIdentity.device !== workspace.device || claim.parentIdentity.inode !== workspace.inode
    || claim.sourceIdentity?.device !== resource.output.device || claim.sourceIdentity.inode !== resource.output.inode
    || !['prepared', 'claimed', 'purging'].includes(claim.state)
    || !/^[a-f0-9-]{36}$/.test(claim.operationId)
    || claim.claimPath !== path.join(workspace.canonicalPath, `.o8-retired-generated-${claim.operationId}`)) {
    throw new Error('Generated-output provenance has no exact current claim authority.');
  }
  return [`:(top,exclude,literal)${path.basename(claim.claimPath)}`];
}

export async function generatedOutputRevision(workspace: WorktreeMaterializationIdentity,
  claim?: ExactWorkspaceClaimRecord): Promise<GeneratedOutputResource['revision']> {
  return withWorktreeMaterializationExecution(workspace.canonicalPath, workspace, async () => {
    const excluded = retirementClaimPathspec(workspace, claim);
    const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all',
      ...(excluded.length ? ['--', '.', ...excluded] : [])];
    const diffArgs = ['diff', '--binary', 'HEAD', '--', '.', ...excluded];
    const untrackedArgs = ['ls-files', '--others', '--exclude-standard', '-z',
      ...(excluded.length ? ['--', '.', ...excluded] : [])];
    const options = { cwd: workspace.canonicalPath, timeout: 10_000, maxBuffer: 1024 ** 2,
      env: childEnvironment({ env: { GIT_OPTIONAL_LOCKS: '0' } }) };
    const head = (await materializationAwareExecFile('git', ['rev-parse', '--verify', 'HEAD^{commit}'], options)).stdout.trim();
    const tree = (await materializationAwareExecFile('git', ['rev-parse', '--verify', 'HEAD^{tree}'], options)).stdout.trim();
    const status = (await materializationAwareExecFile('git', statusArgs, options)).stdout;
    const diff = (await materializationAwareExecFile('git', diffArgs, options)).stdout;
    const untracked = (await materializationAwareExecFile('git', untrackedArgs, options))
      .stdout.split('\0').filter(Boolean).sort();
    if (untracked.length > 512) throw new Error('Generated-output source provenance exceeds its file bound.');
    const digest = createHash('sha256').update(JSON.stringify({ status, diff }));
    let total = 0;
    for (const relative of untracked) {
      if (path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('Generated-output source provenance has an unsafe relative path.');
      }
      const candidate = path.join(workspace.canonicalPath, relative);
      if (await realpath(candidate) !== candidate) throw new Error('Generated-output untracked provenance is redirected.');
      const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await file.stat();
        total += before.size;
        if (!before.isFile() || before.nlink !== 1 || before.size > 32 * 1024 ** 2 || total > 256 * 1024 ** 2) {
          throw new Error('Generated-output untracked provenance is unsafe or exceeds its byte bound.');
        }
        const content = createHash('sha256'); let bytes = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          bytes += chunk.length;
          if (bytes > before.size) throw new Error('Generated-output source grew during provenance capture.');
          content.update(chunk);
        }
        const after = await file.stat(); const named = await lstat(candidate);
        if (bytes !== before.size || after.dev !== before.dev || after.ino !== before.ino
          || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
          || named.dev !== before.dev || named.ino !== before.ino || named.size !== before.size
          || named.mtimeMs !== before.mtimeMs || named.ctimeMs !== before.ctimeMs) {
          throw new Error('Generated-output untracked source changed during provenance capture.');
        }
        digest.update(JSON.stringify({ relative, bytes, sha256: content.digest('hex') }));
      } finally { await file.close(); }
    }
    if ((await materializationAwareExecFile('git', statusArgs, options)).stdout !== status
      || (await materializationAwareExecFile('git', diffArgs, options)).stdout !== diff) {
      throw new Error('Generated-output tracked source changed across provenance capture.');
    }
    retirementClaimPathspec(workspace, claim);
    return { head, tree, dirty: Boolean(status), workingDigest: digest.digest('hex') };
  });
}

/** Store binding prevents a different profile from bypassing reservations and holds. */
export async function assertGeneratedOutputStoreBinding(workspace: WorktreeMaterializationIdentity, requireExisting = false): Promise<void> {
  getSqlite();
  const database = await realpath(process.env.CORTEX_IDE_DB_PATH || path.join(getDataDir(), 'cortex-ide.db'));
  const expected = createHash('sha256').update(database).digest('hex');
  const marker = path.join(workspace.canonicalPath, '.o8-generated-output-store');
  try { await lstat(marker); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (requireExisting) throw new Error('Generated-output lifecycle store binding is missing.');
    try { await writeExactChildFile(workspace.canonicalPath, workspace, marker, expected, 0o600); }
    catch { /* Exclusive creation may have been won by another profile; verify its binding. */ }
  }
  const stat = await lstat(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 64
    || (await readExactChildFile(workspace.canonicalPath, workspace, marker)).contents !== expected) {
    throw new Error('Generated output belongs to a different or unproved lifecycle store.');
  }
  await assertWorktreeMaterializationIdentity(workspace.canonicalPath, workspace);
}

/** Lock order: containing packet first, generated-output resource second. */
export async function withGeneratedOutputExclusion<T>(workspace: WorktreeMaterializationIdentity,
  owner: GeneratedOutputResource['owner'], operation: () => Promise<T>): Promise<T> {
  const execute = () => withPacketLifecycleSpawnLock(
    `generated-output:${createHash('sha256').update(workspace.canonicalPath).digest('hex')}`, async () => {
      const registered = getSqlite().prepare('SELECT resource_id FROM workspace_generated_outputs WHERE workspace_path = ? LIMIT 1')
        .get(workspace.canonicalPath);
      await assertGeneratedOutputStoreBinding(workspace, Boolean(registered));
      return operation();
    });
  return owner ? withManagedRetirementOwnership(owner.repositoryPath, workspace.canonicalPath, execute) : execute();
}

/** Bank recovery survives source retirement but serializes with its resource writes. */
export async function withGeneratedOutputBankExclusion<T>(resource: GeneratedOutputResource,
  operation: () => Promise<T>): Promise<T> {
  return withPacketLifecycleSpawnLock(
    `generated-output:${createHash('sha256').update(resource.workspace.canonicalPath).digest('hex')}`, operation);
}

export function assertGeneratedOutputClaimsReleased(workspace: WorktreeMaterializationIdentity): void {
  if (getSqlite().prepare(`SELECT operation_id FROM workspace_failed_prebuild_parks
    WHERE workspace_path = ? AND state = 'prepared' LIMIT 1`).get(workspace.canonicalPath)) {
    throw new Error('Generated output is blocked by pending failed prebuild preservation.');
  }
  const parking = getSqlite().prepare(`SELECT operation_id FROM workspace_legacy_output_parks
    WHERE workspace_path = ? AND state IN ('prepared', 'restoring') LIMIT 1`).get(workspace.canonicalPath);
  if (parking) throw new Error('Generated output is blocked by pending legacy parking or restoration.');
  assertWorkspaceRetentionReleased(workspace.canonicalPath, workspace);
  const claims = getSqlite().prepare(`SELECT operation_id FROM workspace_exact_claims
    WHERE expected_path = ? OR source_path = ? OR claim_path = ? OR parent_canonical_path = ? LIMIT 1`)
    .get(workspace.canonicalPath, workspace.canonicalPath, workspace.canonicalPath, workspace.canonicalPath);
  if (claims) throw new Error('Generated output is blocked by an exact workspace claim.');
}

/** Caller already holds generated-output exclusion. Planned state precedes creation. */
export async function registerGeneratedOutputLocked(workspace: WorktreeMaterializationIdentity,
  owner?: GeneratedOutputResource['owner'],
  creationAuthority?: GeneratedOutputResource['creationAuthority']): Promise<GeneratedOutputResource> {
  await assertWorktreeMaterializationIdentity(workspace.canonicalPath, workspace);
  if (JSON.stringify(await generatedOutputOwner(workspace)) !== JSON.stringify(owner)) {
    throw new Error('Generated-output containing owner changed at registration.');
  }
  const current = currentGeneratedOutputResource(workspace.canonicalPath);
  if (current) {
    await assertWorktreeMaterializationIdentity(workspace.canonicalPath, current.workspace);
    if (current.output) await assertWorktreeMaterializationIdentity(current.output.canonicalPath, current.output);
    if (JSON.stringify(current.owner) !== JSON.stringify(owner)) throw new Error('Generated-output containing owner changed.');
    return current;
  }
  const outputPath = path.join(workspace.canonicalPath, '.next');
  const predecessor = retainedFailedPrebuild(workspace.canonicalPath);
  if (predecessor) {
    if (owner || !creationAuthority?.linkedGit) throw new Error('A preserved failed prebuild requires fresh prebuild authority.');
    await verifyRetainedFailedPrebuild(predecessor, true);
  }
  assertWorkspaceRetentionReleased(outputPath);
  const existing = await lstat(outputPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
  if (creationAuthority && existing) throw new Error('Prebuild cannot acquire unknown existing generated output.');
  const output = existing ? await captureWorktreeMaterializationIdentity(outputPath) : null;
  if (output && output.canonicalPath !== outputPath) throw new Error('Generated output escapes its containing workspace.');
  const now = Date.now();
  let resource: GeneratedOutputResource = { schema: 'o8/generated-output-resource/v1', resourceId: randomUUID(),
    workspace, output, owner, ...(creationAuthority ? { creationAuthority } : {}),
    ...(predecessor ? { continuedFrom: { resourceId: predecessor.resource.resourceId, operationId: predecessor.operationId } } : {}),
    state: existing ? 'legacy-held' : 'planned',
    origin: existing ? 'legacy-observation' : 'managed-creation', version: 1,
    createdAt: now, updatedAt: now, revision: await generatedOutputRevision(workspace) };
  validateGeneratedOutputResource(resource);
  getSqlite().transaction(() => {
    assertGeneratedOutputClaimsReleased(workspace);
    getSqlite().prepare(`INSERT INTO workspace_generated_outputs
      (resource_id, workspace_path, state, payload_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .run(resource.resourceId, workspace.canonicalPath, resource.state, JSON.stringify(resource), now, now);
  }).immediate();
  if (!existing) {
    const created = await createExactChildDirectory(workspace.canonicalPath, workspace, outputPath, 0o700);
    const captured = await captureWorktreeMaterializationIdentity(outputPath);
    if (captured.device !== created.device || captured.inode !== created.inode) {
      throw new Error('Generated-output creation identity changed before registration.');
    }
    resource = saveGeneratedOutputResource(resource, { output: captured, state: 'ready' });
  }
  return resource;
}
