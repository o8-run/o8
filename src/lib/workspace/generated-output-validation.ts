import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateLinkedGitBuildCustody } from './linked-git-build-custody';
import { validateGeneratedOutputBank } from './generated-output-bank';
import type { GeneratedOutputResource } from './generated-output-state';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import type { ExactWorkspaceClaimRecord } from './exact-workspace-claim-state';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const integer = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && Number(value) >= minimum;
const absolute = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096
  && path.isAbsolute(value) && path.resolve(value) === value && value !== path.parse(value).root;
const identity = (value: WorktreeMaterializationIdentity | null | undefined) => value
  && absolute(value.canonicalPath) && integer(value.device) && integer(value.inode, 1);
const processIdentity = (value: unknown) => {
  const receipt = value as { version?: unknown; platform?: unknown; bootId?: unknown; startId?: unknown } | null;
  return receipt && receipt.version === 1 && ['darwin', 'linux', 'win32'].includes(String(receipt.platform))
    && [receipt.bootId, receipt.startId].every(part => typeof part === 'string' && part.length > 0
      && part.length <= 160 && /^[\x20-\x7e]+$/.test(part));
};

function validRetirementClaim(resource: GeneratedOutputResource, claim: ExactWorkspaceClaimRecord | undefined,
  kind: ExactWorkspaceClaimRecord['kind'], operationId: string, worktreeId: string,
  parent: WorktreeMaterializationIdentity, source: WorktreeMaterializationIdentity | null, prefix: string): boolean {
  const fingerprint = (claim?.authority?.purgeManifest as { fingerprint?: string } | undefined)?.fingerprint;
  return Boolean(resource.owner && source && claim && uuid.test(operationId)
    && claim.kind === kind && claim.state === 'purging' && claim.operationId === operationId
    && claim.repositoryPath === resource.owner.repositoryPath && claim.worktreeId === worktreeId
    && claim.expectedPath === source.canonicalPath && claim.sourcePath === source.canonicalPath
    && claim.claimPath === path.join(parent.canonicalPath, prefix + operationId)
    && path.dirname(source.canonicalPath) === parent.canonicalPath
    && claim.parentIdentity.canonicalPath === parent.canonicalPath
    && claim.parentIdentity.device === parent.device && claim.parentIdentity.inode === parent.inode
    && claim.sourceIdentity?.device === source.device && claim.sourceIdentity.inode === source.inode
    && claim.claimIdentity?.device === source.device && claim.claimIdentity.inode === source.inode
    && claim.contentDigest === resource.bank?.digest && claim.authority?.resourceId === resource.resourceId
    && claim.authority.bankDigest === resource.bank?.digest && integer(claim.authority.resourceVersion, 1)
    && sha.test(fingerprint ?? '')
    && integer(claim.createdAt, 1) && integer(claim.updatedAt, claim.createdAt));
}

/** Persisted flags never substitute for bounded geometry and ownership receipts. */
export function validateGeneratedOutputResource(resource: GeneratedOutputResource): void {
  if (!resource || resource.schema !== 'o8/generated-output-resource/v1' || !uuid.test(resource.resourceId)
    || !identity(resource.workspace) || !integer(resource.version, 1)
    || !integer(resource.createdAt, 1) || !integer(resource.updatedAt, resource.createdAt)
    || !['planned', 'legacy-held', 'ready', 'active', 'succeeded', 'failed-held', 'adopted', 'retired'].includes(resource.state)
    || !['managed-creation', 'legacy-observation', 'legacy-adoption'].includes(resource.origin)
    || !resource.revision || !/^[0-9a-f]{40,64}$/.test(resource.revision.head)
    || !/^[0-9a-f]{40,64}$/.test(resource.revision.tree) || typeof resource.revision.dirty !== 'boolean'
    || !sha.test(resource.revision.workingDigest)) {
    throw new Error('Generated-output resource authority is invalid.');
  }
  const outputPath = path.join(resource.workspace.canonicalPath, '.next');
  if (resource.output && (!identity(resource.output) || resource.output.canonicalPath !== outputPath
    || resource.output.device !== resource.workspace.device || resource.output.inode === resource.workspace.inode)) {
    throw new Error('Generated-output resource has invalid child geometry.');
  }
  if (!resource.output && resource.state !== 'planned') throw new Error('Generated-output resource lost its output identity.');
  if (resource.owner && (!absolute(resource.owner.repositoryPath) || !resource.owner.worktreeId
    || resource.owner.worktreeId !== path.basename(resource.workspace.canonicalPath))) {
    throw new Error('Generated-output resource has invalid containing ownership.');
  }
  if (resource.creationAuthority && (resource.creationAuthority.kind !== 'prebuild'
    || resource.origin !== 'managed-creation' || !integer(resource.creationAuthority.pid, 1)
    || !processIdentity(resource.creationAuthority.identity))) {
    throw new Error('Generated-output prebuild creation authority is invalid.');
  }
  if (resource.creationAuthority?.linkedGit) {
    if (resource.owner) throw new Error('Linked Git build custody is not containing manager authority.');
    validateLinkedGitBuildCustody(resource.creationAuthority.linkedGit);
  }
  if (resource.continuedFrom && (!uuid.test(resource.continuedFrom.resourceId)
    || !uuid.test(resource.continuedFrom.operationId) || resource.continuedFrom.resourceId === resource.resourceId
    || resource.owner || !resource.creationAuthority?.linkedGit)) {
    throw new Error('Generated-output continuation authority is invalid.');
  }
  if (resource.attempt) {
    const attempt = resource.attempt;
    if (!uuid.test(attempt.id) || !['build', 'dev', 'start'].includes(attempt.mode)
      || !integer(attempt.ownerPid, 1) || !processIdentity(attempt.ownerIdentity) || !Array.isArray(attempt.children)
      || attempt.children.length > 16) throw new Error('Generated-output producer receipt is invalid.');
    const pids = new Set<number>();
    for (const child of attempt.children) {
      if (!integer(child.pid, 1) || pids.has(child.pid) || typeof child.observedClosed !== 'boolean'
        || (child.identity !== null && !processIdentity(child.identity))
        || (child.exitCode !== null && !integer(child.exitCode))
        || (child.signal !== null && (typeof child.signal !== 'string' || !/^SIG[A-Z0-9]+$/.test(child.signal)))
        || (!child.observedClosed && (child.exitCode !== null || child.signal !== null))) {
        throw new Error('Generated-output child exit receipt is invalid.');
      }
      pids.add(child.pid);
    }
  }
  if (resource.state === 'active' && !resource.attempt) throw new Error('Active generated output has no producer authority.');
  if (resource.buildOwnership) {
    const ownership = resource.buildOwnership;
    if (!resource.creationAuthority || resource.owner || !resource.attempt || !resource.output
      || !identity(ownership.scope) || ownership.scope.device !== resource.output.device
      || ownership.scope.canonicalPath !== path.join(outputPath, '.o8-release-build')
      || !['reserved', 'complete'].includes(ownership.state)
      || (ownership.proof !== undefined && (ownership.state !== 'complete' || ownership.proof !== 'write-receipts-v1'))
      || (ownership.state === 'complete' && (!ownership.manifest?.entries.length || !sha.test(ownership.manifest.fingerprint)
        || createHash('sha256').update(JSON.stringify(ownership.manifest.entries)).digest('hex') !== ownership.manifest.fingerprint
        || ownership.manifest.entries.some(entry => entry.relative !== '.' && (path.isAbsolute(entry.relative)
          || entry.relative.split('/').some(part => !part || part === '..' || part === '.')))))) {
      throw new Error('Generated-output build namespace has no original reservation.');
    }
  }
  if (resource.bankCapture) {
    const capture = resource.bankCapture;
    if (!uuid.test(capture.operationId) || !identity(capture.parent) || !absolute(capture.path)
      || capture.path !== path.join(capture.parent.canonicalPath, resource.resourceId)
      || capture.path === resource.workspace.canonicalPath
      || capture.path.startsWith(resource.workspace.canonicalPath + path.sep)
      || !integer(capture.ownerPid, 1) || !processIdentity(capture.ownerIdentity)
      || !['planned', 'capturing', 'failed-held', 'verified'].includes(capture.state)
      || (capture.identity && (!identity(capture.identity) || capture.identity.canonicalPath !== capture.path))
      || (capture.files && (!capture.identity || !identity(capture.files)
        || capture.files.canonicalPath !== path.join(capture.path, 'files')
        || capture.files.device !== capture.identity.device))) {
      throw new Error('Generated-output bank capture geometry is invalid.');
    }
    if (capture.state === 'verified' && (!capture.identity || !capture.files || !resource.bank)) {
      throw new Error('Generated-output verified bank lost its capture receipt.');
    }
  }
  if (resource.bank) {
    validateGeneratedOutputBank(resource.bank);
    if (!resource.output || JSON.stringify(resource.bank.source) !== JSON.stringify(resource.output)
      || resource.bankCapture?.state !== 'verified'
      || JSON.stringify(resource.bank.root) !== JSON.stringify(resource.bankCapture.identity)
      || JSON.stringify(resource.bank.files) !== JSON.stringify(resource.bankCapture.files)) {
      throw new Error('Generated-output bank is not bound to its original capture.');
    }
  }
  if (resource.adoption && (!resource.owner || !resource.bank || !resource.adoption.intent.trim()
    || resource.adoption.intent.length > 4096 || !integer(resource.adoption.at, 1)
    || !Array.isArray(resource.adoption.evidence) || resource.adoption.evidence.length < 2
    || resource.adoption.evidence.length > 16 || resource.adoption.evidence.some(entry => !absolute(entry.path)
      || !sha.test(entry.sha256) || entry.path === resource.workspace.canonicalPath
      || entry.path.startsWith(resource.workspace.canonicalPath + path.sep)))) {
    throw new Error('Generated-output adoption authority is invalid.');
  }
  if (resource.adoption?.producerOutcome && (resource.adoption.producerOutcome !== 'terminal-failure'
    || !resource.attempt?.children.length || resource.attempt.children.some(child => !child.identity
      || !child.observedClosed || (child.exitCode === null && child.signal === null)))) {
    throw new Error('Generated-output terminal failure adoption lost its actual closed producer receipts.');
  }
  if (resource.state === 'adopted' && (!resource.adoption || !resource.bank)) {
    throw new Error('Adopted generated output has no complete bank and operator intent.');
  }
  if (resource.recovery) {
    const recovery = resource.recovery;
    if (!resource.bank || !uuid.test(recovery.operationId) || !identity(recovery.parent)
      || !integer(recovery.ownerPid, 1) || !processIdentity(recovery.ownerIdentity)
      || !integer(recovery.createdAt, 1) || !['recovery', 'verification-disposable'].includes(recovery.purpose)
      || recovery.path !== path.join(recovery.parent.canonicalPath, recovery.operationId)
      || recovery.path === resource.workspace.canonicalPath
      || recovery.path.startsWith(resource.workspace.canonicalPath + path.sep)
      || recovery.bankDigest !== resource.bank.digest
      || !['planned', 'restoring', 'complete', 'failed-held', 'retired'].includes(recovery.state)
      || (recovery.root && (!identity(recovery.root) || recovery.root.canonicalPath !== recovery.path
        || recovery.root.device !== recovery.parent.device))
      || (['complete', 'retired'].includes(recovery.state) && (!recovery.root || !integer(recovery.completedAt, 1)))) {
      throw new Error('Generated-output recovery authority is invalid.');
    }
    if ((recovery.retirement && recovery.state !== 'retired') || (recovery.state === 'retired'
      && (recovery.purpose !== 'verification-disposable' || !recovery.retirement || !resource.retirement
        || !integer(recovery.retirement.retiredAt, recovery.completedAt)
        || !validRetirementClaim(resource, recovery.retirement.claim, 'generated-output-recovery-retirement',
          recovery.retirement.operationId, recovery.operationId, recovery.parent, recovery.root, '.o8-retired-verification-')
        || recovery.retirement.claim.authority?.recoveryOperationId !== recovery.operationId
        || recovery.retirement.claim.authority.sourceRetirementOperationId !== resource.retirement.operationId))) {
      throw new Error('Generated-output disposable recovery lacks exact retirement history.');
    }
  }
  if (resource.retirement && (!resource.bank || !uuid.test(resource.retirement.operationId)
    || !integer(resource.retirement.retiredAt, 1) || resource.retirement.bankDigest !== resource.bank.digest
    || resource.retirement.expandedBytes !== resource.bank.expandedBytes
    || !uuid.test(resource.retirement.verifiedRecoveryOperationId)
    || !validRetirementClaim(resource, resource.retirement.claim, 'generated-output-retirement',
      resource.retirement.operationId, resource.resourceId, resource.workspace, resource.output, '.o8-retired-generated-'))) {
    throw new Error('Generated-output retirement receipt is invalid.');
  }
  if (resource.disposal) {
    const { claim, retiredAt } = resource.disposal;
    const fingerprint = (claim?.authority?.purgeManifest as { fingerprint?: string } | undefined)?.fingerprint;
    if (resource.disposal.kind !== 'postship' || resource.state !== 'retired' || !integer(retiredAt, 1)
      || resource.origin !== 'managed-creation' || !resource.creationAuthority || resource.owner
      || resource.bank || resource.bankCapture || resource.adoption || resource.recovery || resource.retirement
      || resource.attempt?.mode !== 'build' || !resource.attempt.children.length
      || resource.attempt.children.some(child => !child.identity || !child.observedClosed || child.exitCode !== 0 || child.signal)
      || !claim || claim.kind !== 'generated-output-retirement' || claim.state !== 'purging'
      || !uuid.test(claim.operationId) || claim.repositoryPath !== resource.workspace.canonicalPath
      || claim.worktreeId !== resource.resourceId || claim.expectedPath !== outputPath
      || claim.sourcePath !== outputPath || claim.claimPath !== outputPath
      || claim.parentIdentity.canonicalPath !== resource.workspace.canonicalPath
      || claim.parentIdentity.device !== resource.workspace.device || claim.parentIdentity.inode !== resource.workspace.inode
      || claim.sourceIdentity?.device !== resource.output?.device || claim.sourceIdentity?.inode !== resource.output?.inode
      || claim.claimIdentity?.device !== resource.output?.device || claim.claimIdentity?.inode !== resource.output?.inode
      || claim.authority?.purpose !== 'postship' || claim.authority.resourceId !== resource.resourceId
      || claim.authority.resourceVersion !== resource.version - 1
      || !sha.test(String(claim.authority.artifactRecipeSha256)) || !sha.test(fingerprint ?? '')
      || claim.contentDigest !== fingerprint) {
      throw new Error('Generated-output postship disposal has no exact successful producer and finalization authority.');
    }
  }
  if (resource.state === 'retired' && !resource.retirement && !resource.disposal) {
    throw new Error('Retired generated output has no completed recovery and retirement receipt.');
  }
}
