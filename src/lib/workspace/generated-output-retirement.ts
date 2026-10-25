import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, statfs } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { refreshCloseProcessObservation } from '@/lib/runtime/close-process-observation';
import { captureWorktreeMaterializationIdentity, assertWorktreeMaterializationIdentity,
  type WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { probeMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { captureExactDirectoryManifest, purgeExactDirectory, type CapturedPurgeProcessWitness,
  type ExactDirectoryManifest } from './exact-directory-purge';
import { createExactChildDirectory, renameExactChildDirectory } from './exact-parent-operation';
import { admitExactManagedFinalization, assertExactManagedFinalizationClaim,
  completeExactManagedFinalization, readExactManagedFinalization } from './exact-managed-finalization-state';
import { prepareExactWorkspaceClaim, readExactWorkspaceClaim, removeExactWorkspaceClaim,
  transitionExactWorkspaceClaim, type ExactWorkspaceClaimRecord } from './exact-workspace-claim-state';
import { captureGeneratedOutputBank, verifyGeneratedOutputBank, verifyGeneratedOutputContents } from './generated-output-bank';
import { recordGeneratedOutputBankEntry } from './generated-output-bank-journal';
import { verifyGeneratedOutputRecovery } from './generated-output-recovery';
import { assertWorkspaceRetentionReleased } from './retention-holds';
import { assertManagedRetirementQuiescence } from './retirement-process-authority';
import { generatedOutputOwner, generatedOutputRevision, readGeneratedOutputResource, registerGeneratedOutputLocked,
  saveGeneratedOutputResource, withGeneratedOutputExclusion, type GeneratedOutputResource } from './generated-output-state';

type Owner = NonNullable<GeneratedOutputResource['owner']>;

export interface GeneratedOutputRetirementHooks {
  afterRename?: () => Promise<void>;
  beforePurge?: () => Promise<void>;
  afterFinalAdmission?: () => Promise<void>;
  afterFinalRemoval?: () => Promise<void>;
}

export async function evidenceHash(filePath: string): Promise<string> {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 4 * 1024 ** 2) throw new Error('Generated-output evidence is unsafe or oversized.');
    const content = await file.readFile();
    const after = await file.stat();
    const named = await lstat(filePath);
    if (content.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || named.dev !== before.dev || named.ino !== before.ino
      || named.size !== before.size || named.mtimeMs !== before.mtimeMs || named.ctimeMs !== before.ctimeMs) {
      throw new Error('Generated-output evidence changed during verification.');
    }
    return createHash('sha256').update(content).digest('hex');
  } finally { await file.close(); }
}

async function ownerQuiescence(resource: GeneratedOutputResource, owner: Owner): Promise<void> {
  await assertManagedRetirementQuiescence({ repositoryPath: owner.repositoryPath, worktreeId: owner.worktreeId,
    sourcePath: resource.workspace.canonicalPath, candidatePath: resource.workspace.canonicalPath, identity: resource.workspace });
}

function retentionReleased(resource: GeneratedOutputResource): void {
  assertWorkspaceRetentionReleased(resource.workspace.canonicalPath, resource.workspace);
  assertWorkspaceRetentionReleased(path.join(resource.workspace.canonicalPath, '.next'), resource.output ?? undefined);
}

function outsideWorkspace(workspace: WorktreeMaterializationIdentity): void {
  const cwd = path.resolve(process.cwd());
  if (cwd === workspace.canonicalPath || cwd.startsWith(workspace.canonicalPath + path.sep)) {
    throw new Error('Generated-output operator maintenance must run outside the containing workspace.');
  }
}

/** Explicit legacy adoption records current provenance; it invents no historical producer completion. */
export async function adoptGeneratedOutput(input: {
  workspacePath: string;
  owner: Owner;
  intent: string;
  evidencePaths: string[];
}): Promise<GeneratedOutputResource> {
  if (!input.intent.trim() || input.intent.length > 4096 || input.evidencePaths.length < 2 || input.evidencePaths.length > 16) {
    throw new Error('Generated-output adoption requires bounded operator intent and source/stop evidence.');
  }
  const workspace = await captureWorktreeMaterializationIdentity(input.workspacePath);
  outsideWorkspace(workspace);
  return withGeneratedOutputExclusion(workspace, input.owner, async () => {
    if (JSON.stringify(await generatedOutputOwner(workspace)) !== JSON.stringify(input.owner)) {
      throw new Error('Generated-output adoption owner is not current manager authority.');
    }
    let resource = await registerGeneratedOutputLocked(workspace, input.owner);
    const terminalFailure = resource.state === 'failed-held' && resource.attempt?.children.length
      && resource.attempt.children.every(child => child.identity && child.observedClosed
        && (child.exitCode !== null || child.signal !== null));
    if (!resource.output || resource.state === 'active' || resource.state === 'planned'
      || (resource.state === 'failed-held' && !terminalFailure)
      || resource.bankCapture) throw new Error('Generated output has unresolved producer or bank retention.');
    const output = resource.output;
    retentionReleased(resource);
    await ownerQuiescence(resource, input.owner);
    const evidence = [];
    for (const selected of input.evidencePaths) {
      const filePath = path.resolve(selected);
      if (filePath === workspace.canonicalPath || filePath.startsWith(workspace.canonicalPath + path.sep)) {
        throw new Error('Generated-output evidence must survive containing-workspace retirement.');
      }
      evidence.push({ path: filePath, sha256: await evidenceHash(filePath) });
    }
    const bankRoot = path.join(getDataDir(), 'generated-output-banks');
    if (bankRoot === workspace.canonicalPath || bankRoot.startsWith(workspace.canonicalPath + path.sep)) {
      throw new Error('Generated-output bank must survive containing-workspace retirement.');
    }
    const dataRoot = await captureWorktreeMaterializationIdentity(getDataDir());
    if (bankRoot !== path.join(dataRoot.canonicalPath, 'generated-output-banks')) {
      throw new Error('Bank parent is not in its exact lifecycle data directory.');
    }
    if (!await lstat(bankRoot).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    })) await createExactChildDirectory(dataRoot.canonicalPath, dataRoot, bankRoot, 0o700);
    const parent = await captureWorktreeMaterializationIdentity(bankRoot);
    const capacity = await statfs(bankRoot);
    const available = Number(capacity.bavail) * Number(capacity.bsize);
    // Preservation maintenance has its own bounded write budget; it never admits a build or worker.
    if (available < 2 * 1024 ** 3 + 256 * 1024 ** 2) throw new Error('Insufficient bounded bank capacity.');
    const bankPath = path.join(bankRoot, resource.resourceId);
    const processOwner = await probeMetadataLockProcessIdentity(process.pid);
    if (processOwner.state !== 'live') throw new Error('Bank producer process identity is unknown.');
    resource = saveGeneratedOutputResource(resource, { owner: input.owner,
      bankCapture: { operationId: randomUUID(), path: bankPath, parent,
        ownerPid: process.pid, ownerIdentity: processOwner.identity, identity: null, files: null, state: 'planned' } });
    try {
      const bank = await captureGeneratedOutputBank({ source: output, bankPath, parent,
        register: async (identity, files) => {
          resource = saveGeneratedOutputResource(resource, { bankCapture: { ...resource.bankCapture!,
            identity, files: files ?? null, state: 'capturing' } });
        },
        receipt: async (index, entry, phase, value) => recordGeneratedOutputBankEntry(resource, index, entry, phase, value),
      });
      await ownerQuiescence(resource, input.owner);
      retentionReleased(resource);
      await verifyGeneratedOutputContents({ bank, candidate: output });
      for (const entry of evidence) if (await evidenceHash(entry.path) !== entry.sha256) throw new Error('Generated-output evidence changed.');
      resource = saveGeneratedOutputResource(resource, { state: 'adopted', origin: 'legacy-adoption', bank,
        revision: await generatedOutputRevision(workspace), adoption: { intent: input.intent, at: Date.now(), evidence,
          ...(terminalFailure ? { producerOutcome: 'terminal-failure' as const } : {}) },
        bankCapture: { ...resource.bankCapture!, identity: bank.root, files: bank.files, state: 'verified' } });
      return resource;
    } catch (error) {
      saveGeneratedOutputResource(resource, { bankCapture: { ...resource.bankCapture!, state: 'failed-held' } });
      throw error;
    }
  });
}

async function identityAt(candidate: string): Promise<{ device: number; inode: number } | null> {
  const stat = await lstat(candidate).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Generated-output namespace was replaced.');
  return { device: stat.dev, inode: stat.ino };
}

async function verifyAuthority(resource: GeneratedOutputResource, candidatePath: string | null,
  claim?: ExactWorkspaceClaimRecord, captured?: CapturedPurgeProcessWitness): Promise<void> {
  if (!resource.owner || !resource.output || !resource.bank || !resource.adoption
    || resource.state !== 'adopted') throw new Error('Generated output has no adopted retirement authority.');
  await assertWorktreeMaterializationIdentity(resource.workspace.canonicalPath, resource.workspace);
  retentionReleased(resource);
  const current = readGeneratedOutputResource(resource.resourceId);
  if (!current || current.state !== resource.state || current.version !== resource.version) {
    throw new Error('Generated-output resource changed after retirement admission.');
  }
  if (claim) {
    const currentClaim = readExactWorkspaceClaim(claim.kind, claim.repositoryPath, claim.worktreeId);
    if (JSON.stringify(currentClaim) !== JSON.stringify(claim)) throw new Error('Generated output lost its current exact claim.');
    if (claim.state === 'purging') assertExactManagedFinalizationClaim(claim);
  }
  const conflict = getSqlite().prepare(`SELECT operation_id FROM workspace_exact_claims
    WHERE operation_id != ? AND (expected_path = ? OR source_path = ? OR claim_path = ?
      OR parent_canonical_path = ?) LIMIT 1`).get(claim?.operationId ?? '', resource.workspace.canonicalPath,
      resource.workspace.canonicalPath, resource.workspace.canonicalPath, resource.workspace.canonicalPath);
  if (conflict) throw new Error('Generated-output workspace has a conflicting claim.');
  const revision = await generatedOutputRevision(resource.workspace, claim);
  if (JSON.stringify(revision) !== JSON.stringify(resource.revision)) throw new Error('Generated-output source revision changed.');
  for (const entry of resource.adoption.evidence) {
    if (await evidenceHash(entry.path) !== entry.sha256) throw new Error('Generated-output evidence changed after adoption.');
  }
  await verifyGeneratedOutputBank(resource.bank);
  await verifyGeneratedOutputRecovery(resource);
  if (candidatePath) await verifyGeneratedOutputContents({ bank: resource.bank,
    candidate: { ...resource.output, canonicalPath: candidatePath }, releaseIntents: claim?.state === 'purging'
      ? claim.authority?.releaseIntents as Array<{ relative: string; device: number; inode: number }> : undefined });
  await assertManagedRetirementQuiescence({ repositoryPath: resource.owner.repositoryPath,
    worktreeId: resource.owner.worktreeId, sourcePath: resource.workspace.canonicalPath,
    candidatePath: resource.workspace.canonicalPath, identity: resource.workspace, capturedPurge: captured });
  retentionReleased(resource);
}

/** Dedicated exact claim; interrupted journals keep exclusion across cold restarts. */
export async function retireGeneratedOutput(resourceId: string,
  hooks: GeneratedOutputRetirementHooks = {}): Promise<GeneratedOutputResource> {
  const resource = readGeneratedOutputResource(resourceId);
  if (!resource?.owner || !resource.output) throw new Error('Generated-output resource has no exact managed owner.');
  outsideWorkspace(resource.workspace);
  return withGeneratedOutputExclusion(resource.workspace, resource.owner, async () => {
    let claim = readExactWorkspaceClaim('generated-output-retirement', resource.owner!.repositoryPath, resourceId);
    if (resource.state === 'retired' && !claim) return resource;
    const sourcePath = path.join(resource.workspace.canonicalPath, '.next');
    if (!claim) {
      await verifyAuthority(resource, sourcePath);
      const operationId = randomUUID();
      claim = prepareExactWorkspaceClaim({ kind: 'generated-output-retirement', repositoryPath: resource.owner!.repositoryPath,
        worktreeId: resourceId, operationId, expectedPath: sourcePath, sourcePath,
        claimPath: path.join(resource.workspace.canonicalPath, `.o8-retired-generated-${operationId}`),
        parentIdentity: resource.workspace, sourceIdentity: resource.output, contentDigest: resource.bank!.digest,
        authority: { resourceId, bankDigest: resource.bank!.digest, resourceVersion: resource.version } });
    }
    if (claim.kind !== 'generated-output-retirement' || claim.repositoryPath !== resource.owner!.repositoryPath
      || claim.worktreeId !== resourceId || claim.authority?.resourceId !== resourceId
      || claim.authority.bankDigest !== resource.bank?.digest || claim.authority.resourceVersion !== resource.version
      || claim.contentDigest !== resource.bank?.digest
      || claim.expectedPath !== sourcePath || claim.sourcePath !== sourcePath
      || claim.claimPath !== path.join(resource.workspace.canonicalPath, `.o8-retired-generated-${claim.operationId}`)
      || claim.parentIdentity.canonicalPath !== resource.workspace.canonicalPath
      || claim.parentIdentity.device !== resource.workspace.device || claim.parentIdentity.inode !== resource.workspace.inode
      || claim.sourceIdentity?.device !== resource.output!.device || claim.sourceIdentity.inode !== resource.output!.inode) {
      throw new Error('Generated-output claim authority changed.');
    }
    const original = await identityAt(sourcePath);
    const moved = await identityAt(claim.claimPath);
    const same = (value: { device: number; inode: number } | null) => !value
      || (value.device === resource.output!.device && value.inode === resource.output!.inode);
    if ((original && moved) || !same(original) || !same(moved)) throw new Error('Generated-output source or claim was replaced.');
    if (claim.state === 'prepared') {
      if (!original && !moved) throw new Error('Generated-output prepared namespaces are missing.');
      if (original) {
        await verifyAuthority(resource, sourcePath, claim);
        await renameExactChildDirectory(resource.workspace.canonicalPath, resource.workspace,
          sourcePath, claim.claimPath, resource.output!);
        await hooks.afterRename?.();
      }
      claim = transitionExactWorkspaceClaim({ kind: claim.kind, repositoryPath: claim.repositoryPath,
        worktreeId: resourceId, operationId: claim.operationId, expectedState: 'prepared', toState: 'claimed',
        claimIdentity: resource.output! });
    }
    if (claim.state === 'claimed') {
      await verifyAuthority(resource, claim.claimPath, claim);
      const manifest = await captureExactDirectoryManifest(claim.claimPath, resource.output!);
      const releaseIntents = resource.bank!.entries.filter(entry => entry.kind === 'file')
        .map(entry => ({ relative: entry.relative, device: entry.device, inode: entry.inode,
          originalBytes: entry.bytes, originalSha256: entry.sha256, releaseBytes: 0 }));
      claim = transitionExactWorkspaceClaim({ kind: claim.kind, repositoryPath: claim.repositoryPath,
        worktreeId: resourceId, operationId: claim.operationId, expectedState: 'claimed', toState: 'purging',
        authority: { ...claim.authority, purgeManifest: manifest, releaseIntents } });
    }
    if (claim.state !== 'purging') throw new Error('Generated-output retirement journal is invalid.');
    const remaining = await identityAt(claim.claimPath);
    if (await identityAt(sourcePath)) throw new Error('Generated-output source returned during purge.');
    if (remaining) {
      await hooks.beforePurge?.();
      await verifyAuthority(resource, claim.claimPath, claim);
      const manifest = claim.authority?.purgeManifest as ExactDirectoryManifest | undefined;
      if (!manifest?.entries.length) throw new Error('Generated-output purge has no durable manifest.');
      await purgeExactDirectory(claim.claimPath, resource.output!, undefined,
        async (candidatePath, captured) => {
          if (!captured) throw new Error('Generated-output purge requires a captured process witness.');
          // The paused native helper did not exist in the earlier owner observation.
          refreshCloseProcessObservation();
          await verifyAuthority(resource, candidatePath, claim!, captured);
        }, async candidatePath => {
          assertExactManagedFinalizationClaim(claim!);
          await verifyAuthority(resource, candidatePath, claim!);
          if (await identityAt(sourcePath) || (await readdir(candidatePath)).length !== 0) {
            throw new Error('Generated-output finalization has no exact empty, source-absent namespace.');
          }
          admitExactManagedFinalization(claim!);
          await hooks.afterFinalAdmission?.();
        }, manifest.fingerprint, manifest.entries);
      await hooks.afterFinalRemoval?.();
      await verifyAuthority(resource, null, claim);
      if (await identityAt(sourcePath) || await identityAt(claim.claimPath)) {
        throw new Error('Generated-output finalization namespaces returned.');
      }
      completeExactManagedFinalization(claim, 'removed');
    } else {
      const finalization = readExactManagedFinalization(claim);
      if (!finalization) throw new Error('Missing generated-output claim has no durable final-empty admission.');
      await verifyAuthority(resource, null, claim);
      if (await identityAt(sourcePath) || await identityAt(claim.claimPath)) {
        throw new Error('Generated-output finalization namespace returned during replay.');
      }
      if (finalization.state === 'admitted') completeExactManagedFinalization(claim, 'absent-after-admission');
    }
    await verifyAuthority(resource, null, claim);
    if (await identityAt(sourcePath) || await identityAt(claim.claimPath)
      || readExactManagedFinalization(claim)?.state !== 'complete') {
      throw new Error('Generated-output completion lacks retained finalization truth.');
    }
    return getSqlite().transaction(() => {
      assertExactManagedFinalizationClaim(claim!);
      retentionReleased(resource);
      const retired = saveGeneratedOutputResource(resource, { state: 'retired', retirement: {
        operationId: claim!.operationId, retiredAt: Date.now(), expandedBytes: resource.bank!.expandedBytes,
        bankDigest: resource.bank!.digest, verifiedRecoveryOperationId: resource.recovery!.operationId, claim: claim! } });
      removeExactWorkspaceClaim(claim!.kind, claim!.repositoryPath, resourceId, claim!.operationId);
      return retired;
    }).immediate();
  });
}
