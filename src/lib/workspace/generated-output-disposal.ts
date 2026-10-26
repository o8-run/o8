import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { assertLinkedGitBuildCustody } from './linked-git-build-custody';

import { readProcessCwdSnapshot } from '@/lib/runtime/process-cwd-snapshot';
import { getSqlite } from '@/lib/db';
import { probeLiveProcessInside } from '@/lib/worktree/live-process-guard';
import { assertWorktreeMaterializationIdentity, captureWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { probeMetadataLockProcessIdentity, sameMetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';
import { assertGeneratedTreeHasSafeLinks } from '../../../scripts/postship-cleanup.mjs';
import { collectReleaseArtifactRecipe, verifyReleaseArtifactManifest } from '../../../scripts/lib/release-artifacts.mjs';
import { purgeExactDirectory, readCapturedPurgeCwdSnapshot,
  type CapturedPurgeProcessWitness, type ExactDirectoryManifest } from './exact-directory-purge';
import { admitExactManagedFinalization, assertExactManagedFinalizationClaim,
  completeExactManagedFinalization, readExactManagedFinalization } from './exact-managed-finalization-state';
import { prepareExactWorkspaceClaim, readExactWorkspaceClaim, removeExactWorkspaceClaim,
  transitionExactWorkspaceClaim } from './exact-workspace-claim-state';
import { assertGeneratedOutputClaimsReleased, currentGeneratedOutputResource, generatedOutputOwner,
  lastDisposedPrebuildOutput, readGeneratedOutputResource, saveGeneratedOutputResource,
  withGeneratedOutputExclusion } from './generated-output-state';
import { assertWorkspaceRetentionReleased } from './retention-holds';

export interface GeneratedOutputDisposalHooks {
  afterFinalAdmission?: () => Promise<void>;
  afterFinalRemoval?: () => Promise<void>;
}

async function present(candidate: string) {
  return lstat(candidate).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}

/** Success permits disposable compiler output, never the checkout, artifact or dependency donors. */
export async function disposeSuccessfulPrebuildOutput(workspacePath: string, version: string,
  hooks: GeneratedOutputDisposalHooks = {}): Promise<'removed' | 'skipped'> {
  const workspace = await captureWorktreeMaterializationIdentity(workspacePath);
  const outputPath = path.join(workspace.canonicalPath, '.next');
  const owner = await generatedOutputOwner(workspace);
  if (owner) throw new Error('Postship disposal requires an ordinary prebuild-owned checkout.');
  const current = currentGeneratedOutputResource(workspace.canonicalPath);
  const previous = current ?? lastDisposedPrebuildOutput(workspace.canonicalPath);
  if (!previous) throw new Error('Postship output has unknown lifecycle ownership.');
  // A missing marker is not permission to create a new binding during destructive maintenance.
  if (!await present(path.join(workspace.canonicalPath, '.o8-generated-output-store'))) {
    throw new Error('Postship lifecycle store binding is missing.');
  }
  return withGeneratedOutputExclusion(workspace, owner, async () => {
    const resource = readGeneratedOutputResource(previous.resourceId)!;
    await assertWorktreeMaterializationIdentity(workspace.canonicalPath, resource.workspace);
    if (resource.creationAuthority) await assertLinkedGitBuildCustody(workspace, resource.creationAuthority.linkedGit);
    if (resource.disposal) {
      assertGeneratedOutputClaimsReleased(workspace);
      assertWorkspaceRetentionReleased(outputPath, resource.output!);
      if (await present(outputPath)) throw new Error('Disposed output namespace returned without a new generation.');
      return 'skipped';
    }
    if (!resource.creationAuthority || resource.owner || resource.origin !== 'managed-creation'
      || resource.state !== 'succeeded' || !resource.output || resource.bank || resource.bankCapture
      || resource.adoption || resource.recovery || resource.retirement || resource.attempt?.mode !== 'build'
      || !resource.attempt.children.length || resource.attempt.children.some(child => !child.identity
        || !child.observedClosed || child.exitCode !== 0 || child.signal)) {
      throw new Error('Postship output lacks disposable successful prebuild authority.');
    }
    if (resource.buildOwnership?.state !== 'complete' || !resource.buildOwnership.manifest) {
      console.info('Preserved unowned entries in .next; no completed pre-build ownership reservation.');
      return 'skipped';
    }
    let claim = readExactWorkspaceClaim('generated-output-retirement', workspace.canonicalPath, resource.resourceId);
    // A pending claim already binds the original artifact recipe (including its
    // release version). A later version bump must not strand that exact claim.
    // New disposals still require the current clean recipe and build environment.
    const recordedRecipe = claim?.authority?.artifactRecipeSha256;
    if (claim && (claim.authority?.purpose !== 'postship'
      || typeof recordedRecipe !== 'string' || !/^[a-f0-9]{64}$/.test(recordedRecipe))) {
      throw new Error('Postship disposal claim has no recorded artifact recipe.');
    }
    const recipe = claim ? { recipeSha256: recordedRecipe as string }
      : collectReleaseArtifactRecipe(workspace.canonicalPath, version, { env: process.env });
    const artifact = verifyReleaseArtifactManifest(workspace.canonicalPath, recipe);
    if (!artifact.reusable || (claim?.authority?.releaseVersion
      && claim.authority.releaseVersion !== artifact.manifest?.recipe.version)) {
      throw new Error('Postship disposal requires a preserved verified release artifact.');
    }
    const verify = async (captured?: CapturedPurgeProcessWitness) => {
      await assertLinkedGitBuildCustody(workspace, resource.creationAuthority!.linkedGit);
      await assertWorktreeMaterializationIdentity(workspace.canonicalPath, resource.workspace);
      if (await generatedOutputOwner(workspace) || JSON.stringify(readGeneratedOutputResource(resource.resourceId)) !== JSON.stringify(resource)) {
        throw new Error('Postship output owner or resource changed.');
      }
      assertWorkspaceRetentionReleased(workspace.canonicalPath, workspace);
      assertWorkspaceRetentionReleased(outputPath, resource.output!);
      const conflicts = getSqlite().prepare(`SELECT operation_id FROM workspace_exact_claims
        WHERE operation_id != ? AND (expected_path IN (?, ?) OR source_path IN (?, ?)
          OR claim_path IN (?, ?) OR parent_canonical_path IN (?, ?)) LIMIT 1`)
        .get(claim?.operationId ?? '', workspace.canonicalPath, outputPath, workspace.canonicalPath, outputPath,
          workspace.canonicalPath, outputPath, workspace.canonicalPath, outputPath);
      if (conflicts) throw new Error('Postship disposal is blocked by an exact workspace claim.');
      for (const producer of [{ pid: resource.attempt!.ownerPid, identity: resource.attempt!.ownerIdentity },
        ...resource.attempt!.children]) {
        const observed = await probeMetadataLockProcessIdentity(producer.pid);
        if (observed.state === 'unknown' || (observed.state === 'live'
          && sameMetadataLockProcessIdentity(observed.identity, producer.identity!))) {
          throw new Error('Postship producer is still live or unknown.');
        }
      }
      if (await present(path.join(outputPath, 'lock'))) throw new Error('Postship output has an unresolved producer lock.');
      const actual = await present(outputPath);
      if (!actual && !claim) throw new Error('Postship output is missing without a disposal claim.');
      if (actual) {
        await assertWorktreeMaterializationIdentity(outputPath, resource.output!);
        const finalized = claim?.state === 'purging' ? readExactManagedFinalization(claim) : null;
        if (finalized?.state === 'complete' || (finalized && (await readdir(outputPath)).length)) {
          throw new Error('Postship final-empty namespace returned or changed.');
        }
        await assertGeneratedTreeHasSafeLinks(workspace.canonicalPath, workspace.canonicalPath, outputPath, '.next');
        const processes = await probeLiveProcessInside(outputPath, captured
          ? { snapshot: await readCapturedPurgeCwdSnapshot(captured, outputPath) } : { snapshot: await readProcessCwdSnapshot({ forceRefresh: true }) });
        if (processes.status !== 'clear') throw new Error('Postship output has live or unknown processes.');
      }
    };
    await verify();
    if (!claim) {
      assertGeneratedOutputClaimsReleased(workspace);
      // This inventory came only from the namespace reserved before compilation.
      // Never grant deletion authority by inventorying the shared directory here.
      const manifest = resource.buildOwnership.manifest;
      await verify();
      claim = prepareExactWorkspaceClaim({ kind: 'generated-output-retirement', repositoryPath: workspace.canonicalPath,
        worktreeId: resource.resourceId, operationId: randomUUID(), expectedPath: outputPath,
        sourcePath: outputPath, claimPath: outputPath, parentIdentity: workspace, sourceIdentity: resource.output,
        contentDigest: manifest.fingerprint, authority: { purpose: 'postship', resourceId: resource.resourceId,
          resourceVersion: resource.version, releaseVersion: version, artifactRecipeSha256: recipe.recipeSha256, purgeManifest: manifest } });
    }
    if (claim.kind !== 'generated-output-retirement' || claim.repositoryPath !== workspace.canonicalPath
      || claim.worktreeId !== resource.resourceId || claim.sourcePath !== outputPath || claim.expectedPath !== outputPath
      || claim.claimPath !== outputPath || claim.parentIdentity.device !== workspace.device
      || claim.parentIdentity.inode !== workspace.inode || claim.parentIdentity.canonicalPath !== workspace.canonicalPath
      || claim.sourceIdentity?.device !== resource.output.device || claim.sourceIdentity?.inode !== resource.output.inode
      || claim.authority?.purpose !== 'postship' || claim.authority.resourceId !== resource.resourceId
      || claim.authority.resourceVersion !== resource.version
      || claim.authority.artifactRecipeSha256 !== recipe.recipeSha256) throw new Error('Postship disposal claim changed.');
    if (claim.state === 'prepared') {
      await assertWorktreeMaterializationIdentity(outputPath, resource.output);
      claim = transitionExactWorkspaceClaim({ kind: claim.kind, repositoryPath: claim.repositoryPath,
        worktreeId: claim.worktreeId, operationId: claim.operationId, expectedState: 'prepared', toState: 'claimed',
        claimIdentity: resource.output });
    }
    if (claim.state === 'claimed') {
      await assertWorktreeMaterializationIdentity(outputPath, resource.output);
      claim = transitionExactWorkspaceClaim({ kind: claim.kind, repositoryPath: claim.repositoryPath,
        worktreeId: claim.worktreeId, operationId: claim.operationId, expectedState: 'claimed', toState: 'purging' });
    }
    const manifest = claim.authority?.purgeManifest as ExactDirectoryManifest;
    if (claim.state !== 'purging' || !manifest?.entries.length || manifest.fingerprint !== claim.contentDigest) {
      throw new Error('Postship disposal has no durable purge manifest.');
    }
    if (Buffer.byteLength(JSON.stringify({ ...resource, disposal: { kind: 'postship', retiredAt: Date.now(), claim } }))
      > 16 * 1024 ** 2) throw new Error('Postship disposal receipt exceeds its resource bound.');
    await verify();
    if (await present(outputPath)) {
      await purgeExactDirectory(outputPath, resource.output, async () => { await verify(); }, async (_candidate, captured) => {
        if (!captured) throw new Error('Postship purge has no captured process witness.');
        await verify(captured);
      }, async () => {
        await verify();
        if ((await readdir(outputPath)).length) throw new Error('Postship finalization is not empty.');
        admitExactManagedFinalization(claim!);
        await hooks.afterFinalAdmission?.();
      }, manifest.fingerprint, manifest.entries, true);
      if (await present(outputPath)) {
        console.info('Preserved unowned entries in .next; release-owned entries were cleared.');
        return 'skipped';
      }
      await hooks.afterFinalRemoval?.();
      await verify();
      completeExactManagedFinalization(claim, 'removed');
    } else {
      if (!readExactManagedFinalization(claim)) throw new Error('Missing postship output has no final-empty admission.');
      await verify();
      completeExactManagedFinalization(claim, 'absent-after-admission');
    }
    if (await present(outputPath) || readExactManagedFinalization(claim)?.state !== 'complete') {
      throw new Error('Postship disposal lacks exact completed removal.');
    }
    getSqlite().transaction(() => {
      assertExactManagedFinalizationClaim(claim!);
      assertWorkspaceRetentionReleased(workspace.canonicalPath, workspace);
      assertWorkspaceRetentionReleased(outputPath, resource.output!);
      saveGeneratedOutputResource(resource, { state: 'retired', disposal: { kind: 'postship', retiredAt: Date.now(), claim: claim! } });
      removeExactWorkspaceClaim(claim!.kind, claim!.repositoryPath, resource.resourceId, claim!.operationId);
    }).immediate();
    return 'removed';
  });
}
