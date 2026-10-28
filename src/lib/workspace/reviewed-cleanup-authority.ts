import { lstat } from 'node:fs/promises';

import { assertWorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import { captureExactDirectoryManifest, type ExactDirectoryManifest } from './exact-directory-purge';
import { moveExactDirectoryNoReplace } from './exact-directory-move';
import { readExactManagedFinalization } from './exact-managed-finalization-state';
import { readExactWorkspaceClaim, removeExactWorkspaceClaim, transitionExactWorkspaceClaim,
  type ExactWorkspaceClaimRecord } from './exact-workspace-claim-state';

/** Immutable preview bytes, copied into the retirement journal before its first rename. */
export interface ReviewedCleanupAuthority {
  schema: 'o8/reviewed-cleanup-authority/v1';
  planId: string;
  entryId: string;
  manifest: ExactDirectoryManifest;
  /** Only completed, separately selected output retirement may remove .next. */
  generatedOutputRemoved?: boolean;
}

export class ReviewedCleanupChanged extends Error {
  constructor(message = 'Reviewed cleanup contents changed; retain the current tree and preview again.') {
    super(message);
    this.name = 'ReviewedCleanupChanged';
  }
}

export function reviewedCleanupAuthority(claim: ExactWorkspaceClaimRecord): ReviewedCleanupAuthority | null {
  const review = claim.authority?.reviewedCleanup as ReviewedCleanupAuthority | undefined;
  if (!review) return null;
  if (review.schema !== 'o8/reviewed-cleanup-authority/v1' || !review.planId || !review.entryId
    || !review.manifest?.entries?.length || !/^[a-f0-9]{64}$/.test(review.manifest.fingerprint)) {
    throw new ReviewedCleanupChanged('Reviewed cleanup journal is unavailable; retain its exact namespaces.');
  }
  return review;
}

function projection(manifest: ExactDirectoryManifest, review: ReviewedCleanupAuthority, observed: boolean) {
  return manifest.entries.filter(entry => {
    const name = '.next';
    if (review.generatedOutputRemoved && (entry.relative === name || entry.relative.startsWith(`${name}/`))) {
      if (observed) throw new ReviewedCleanupChanged('An approved output dependency contains new data.');
      return false;
    }
    return true;
  }).map(entry => ({ relative: entry.relative, device: entry.device, inode: entry.inode,
    kind: entry.kind, mode: entry.mode,
    // Rename and approved subtree removal change directory timestamps/link counts.
    // Exact names, directory identities and every file revision remain pinned.
    ...(entry.kind === 'directory' ? {} : { linkCount: entry.linkCount, size: entry.size,
      mtimeMs: entry.mtimeMs, ctimeMs: entry.ctimeMs,
      contentSha256: entry.contentSha256, symlinkTarget: entry.symlinkTarget }),
  }));
}

export async function verifyReviewedCleanup(claim: ExactWorkspaceClaimRecord, candidatePath: string) {
  const review = reviewedCleanupAuthority(claim);
  if (!review) return;
  if (claim.authority?.reviewedCleanupRestore) throw new ReviewedCleanupChanged('Reviewed cleanup restoration is pending.');
  if (!claim.sourceIdentity) throw new ReviewedCleanupChanged('Reviewed cleanup lost its source identity.');
  let current: ExactDirectoryManifest;
  try { current = await captureExactDirectoryManifest(candidatePath, claim.sourceIdentity, { contents: true }); }
  catch { throw new ReviewedCleanupChanged('Reviewed cleanup contents could not be verified.'); }
  if (current.entries.length === 1 && claim.state === 'purging'
    && readExactManagedFinalization(claim)?.state === 'admitted') return;
  if (JSON.stringify(projection(current, review, true)) !== JSON.stringify(projection(review.manifest, review, false))) {
    throw new ReviewedCleanupChanged();
  }
}

async function present(candidate: string) {
  return lstat(candidate).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

export async function hasReviewedCleanupNamespace(claim: ExactWorkspaceClaimRecord) {
  return await present(claim.sourcePath) || await present(claim.claimPath);
}

/** Restore remaining bytes only. Never overwrite a returned public namespace or delete a substitute. */
export async function restoreReviewedCleanup(initial: ExactWorkspaceClaimRecord): Promise<void> {
  let claim = readExactWorkspaceClaim(initial.kind, initial.repositoryPath, initial.worktreeId);
  if (!claim || claim.operationId !== initial.operationId || !reviewedCleanupAuthority(claim) || !claim.sourceIdentity) {
    throw new ReviewedCleanupChanged('Reviewed cleanup restoration lost its exact journal.');
  }
  const identity = claim.sourceIdentity;
  claim = transitionExactWorkspaceClaim({ ...claim, expectedState: claim.state, toState: claim.state,
    authority: { ...claim.authority, reviewedCleanupRestore: true } });
  await assertWorktreeMaterializationIdentity(claim.parentIdentity.canonicalPath, claim.parentIdentity);
  const sourcePresent = await present(claim.sourcePath);
  const claimPresent = await present(claim.claimPath);
  if (sourcePresent && claimPresent) throw new ReviewedCleanupChanged('Restoration is held: both public and quarantined trees exist.');
  if (claimPresent) {
    await assertWorktreeMaterializationIdentity(claim.claimPath, { ...identity, canonicalPath: claim.claimPath });
    await moveExactDirectoryNoReplace(claim.parentIdentity, claim.claimPath, claim.sourcePath, identity);
  }
  await assertWorktreeMaterializationIdentity(claim.sourcePath, { ...identity, canonicalPath: claim.sourcePath });
  const current = readExactWorkspaceClaim(claim.kind, claim.repositoryPath, claim.worktreeId);
  if (!current || current.operationId !== claim.operationId || !current.authority?.reviewedCleanupRestore) {
    throw new ReviewedCleanupChanged('Reviewed cleanup restoration lost its recorded intent.');
  }
  if (claim.kind === 'managed-retirement') {
    const { rollbackWorkspaceMaterializationRetirement } = await import('./workspace-materialization-retirement');
    rollbackWorkspaceMaterializationRetirement(claim.sourcePath, 'cleanup', new ReviewedCleanupChanged());
  }
  removeExactWorkspaceClaim(claim.kind, claim.repositoryPath, claim.worktreeId, claim.operationId);
}
