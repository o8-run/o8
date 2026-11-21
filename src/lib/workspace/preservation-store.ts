import { rebuildableCargoTargetPaths } from '@/lib/worktree/cargo-target-cache';
import { timeClosePhase } from '@/lib/orchestrator/close-timing';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import { getSqlite } from '@/lib/db';
import { getLane } from '@/lib/lane/registry';
import { findRepoByLocalPath } from '@/lib/repos/registry';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import type { WorkspaceSnapshotRecord } from '@/lib/worktree/snapshot-state';
import { canonicalRepoRoot } from '@/lib/worktree/root-layout';
import { captureIgnoredArtifacts, type IgnoredArtifactCapture } from './ignored-artifact-io';
import { preserveWorkspaceGitBundle, readWorkspaceGitBundle, type WorkspaceGitBundleReceipt } from './git-bundle-preservation';
import { readManagedWorkspaceMaterialization } from './managed-materialization-identity';
import { repoSetupCopyBindingRequirements } from './repo-setup';
import { acquireWorkspaceRetentionHold } from './retention-holds';
import { beginPreservationBankWriter, PRESERVATION_BANK_POLICY, withPreservationBankAdmission } from './preservation-bank-budget';

export interface WorkspacePreservationReceipt {
  preservationId: string;
  manifestSha256: string;
  handoffSha256: string;
  artifactCount: number;
  artifactBytes: number;
  sourceDevice: number;
  sourceInode: number;
  headCommit: string;
  treeSha: string;
  gitBundle?: WorkspaceGitBundleReceipt;
}

export interface WorkspacePreservationPayload {
  schema: 'o8/workspace-preservation/v1';
  repositoryUuid: string;
  repositoryPath: string;
  packetId: string;
  laneId: string | null;
  worktreeId: string;
  identity: WorktreeMaterializationIdentity;
  capture: IgnoredArtifactCapture;
  /** Historical v1 receipts predate portable source; their immutable manifests stay readable. */
  gitBundle?: WorkspaceGitBundleReceipt;
  capturePolicy: {
    rebuildablePaths: string[];
    copiedEnvironment: Record<string, string | null>;
    environmentReferences?: Record<string, string>;
    discardSource: boolean;
  };
  handoff: {
    revision: string;
    treeSha: string;
    recoveryRef: string;
    outcome: string;
    remainingWork: string;
    evidence: { laneId: string | null; snapshotGeneration: number; snapshotFingerprint: string };
    sessionIdentities: WorkspaceSnapshotRecord['sessionIdentities'];
    recoveryInstructions: string;
  };
}

interface PreservationRow {
  preservation_id: string;
  repository_uuid: string;
  repository_path: string;
  workspace_path: string;
  worktree_id: string;
  packet_id: string | null;
  lane_id: string | null;
  source_device: number;
  source_inode: number;
  head_commit: string;
  tree_sha: string;
  manifest_sha256: string;
  handoff_sha256: string;
  artifact_count: number;
  artifact_bytes: number;
  created_at: number;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function archiveDirectory(): Promise<string> {
  const data = await realpath(getDataDir());
  const directory = path.join(data, 'workspace-preservation');
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    || (process.getuid && stat.uid !== process.getuid()) || await realpath(directory) !== directory) {
    throw new Error('The private preservation directory does not have safe ownership.');
  }
  return directory;
}

function selectPreservation(preservationId: string): PreservationRow | null {
  if (!/^[a-f0-9]{64}$/.test(preservationId)) throw new Error('Preservation identifier is invalid.');
  return getSqlite().prepare('SELECT * FROM workspace_preservations WHERE preservation_id = ?')
    .get(preservationId) as PreservationRow | undefined ?? null;
}

async function readPayloadBytes(preservationId: string): Promise<Buffer> {
  const directory = await archiveDirectory();
  const candidate = path.join(directory, preservationId + '.json');
  const file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024
      || (process.platform !== 'win32' && (before.mode & 0o077) !== 0) || (process.getuid && before.uid !== process.getuid())) {
      throw new Error('The preservation file has unsafe ownership or exceeds its bound.');
    }
    const content = await file.readFile();
    const after = await file.stat();
    const named = await lstat(candidate);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino
      || sha256(content) !== preservationId || await realpath(directory) !== directory) {
      throw new Error('The private preservation file changed or failed its hash receipt.');
    }
    return content;
  } finally {
    await file.close();
  }
}

export async function readWorkspacePreservation(preservationId: string): Promise<{
  receipt: WorkspacePreservationReceipt;
  payload: WorkspacePreservationPayload;
}> {
  const row = selectPreservation(preservationId);
  if (!row) throw new Error('The trusted preservation receipt is absent.');
  const payload = JSON.parse((await readPayloadBytes(preservationId)).toString('utf8')) as WorkspacePreservationPayload;
  if (payload.schema !== 'o8/workspace-preservation/v1'
    || row.manifest_sha256 !== preservationId || payload.repositoryUuid !== row.repository_uuid
    || sha256(JSON.stringify(payload.handoff)) !== row.handoff_sha256
    || payload.identity.canonicalPath !== row.workspace_path
    || payload.identity.device !== row.source_device || payload.identity.inode !== row.source_inode
    || payload.packetId !== row.packet_id || payload.laneId !== row.lane_id
    || payload.capture.headCommit !== row.head_commit || payload.capture.treeSha !== row.tree_sha
    || payload.capture.bytes !== row.artifact_bytes
    || payload.capture.entries.filter((entry) => entry.kind === 'file').length !== row.artifact_count) {
    throw new Error('Private preservation does not match its trusted owner receipt.');
  }
  if (payload.gitBundle) {
    const bundle = payload.gitBundle;
    if (bundle.repositoryUuid !== payload.repositoryUuid || bundle.packetId !== payload.packetId
      || bundle.snapshotGeneration !== payload.handoff.evidence.snapshotGeneration
      || bundle.snapshotFingerprint !== payload.handoff.evidence.snapshotFingerprint
      || bundle.headCommit !== row.head_commit || bundle.treeSha !== row.tree_sha
      || bundle.recoveryRef !== payload.handoff.recoveryRef) {
      throw new Error('Portable Git preservation differs from its trusted owner and generation.');
    }
    await readWorkspaceGitBundle(bundle);
  }
  return {
    payload,
    receipt: {
      preservationId,
      manifestSha256: row.manifest_sha256,
      handoffSha256: row.handoff_sha256,
      artifactCount: row.artifact_count,
      artifactBytes: row.artifact_bytes,
      sourceDevice: row.source_device,
      sourceInode: row.source_inode,
      headCommit: row.head_commit,
      treeSha: row.tree_sha,
      ...(payload.gitBundle ? { gitBundle: payload.gitBundle } : {}),
    },
  };
}

/** Never infer archive authority from an untrusted receipt-looking file. */
export function preservationIdForSnapshot(snapshot: WorkspaceSnapshotRecord): string | null {
  const row = getSqlite().prepare(`
    SELECT preservation_id FROM workspace_preservations
    WHERE repository_uuid = ? AND packet_id = ? AND workspace_path = ?
      AND head_commit = ? AND tree_sha = ? ORDER BY created_at DESC LIMIT 1
  `).get(
    snapshot.repositoryUuid, snapshot.packetId, canonicalRepoRoot(snapshot.originalPath),
    snapshot.headCommit, snapshot.treeSha,
  ) as { preservation_id: string } | undefined;
  return row?.preservation_id ?? null;
}

export async function preservationReceiptForSnapshot(snapshot: WorkspaceSnapshotRecord): Promise<WorkspacePreservationReceipt> {
  const preservationId = preservationIdForSnapshot(snapshot);
  const row = preservationId ? selectPreservation(preservationId) : null;
  if (!row || !preservationId) throw new Error('Verified source and ignored-content preservation is required before retirement.');
  const { receipt } = await readWorkspacePreservation(preservationId);
  if (!receipt.gitBundle || receipt.gitBundle.snapshotGeneration !== snapshot.snapshotGeneration
    || receipt.gitBundle.snapshotFingerprint !== snapshot.snapshotFingerprint) {
    throw new Error('A verified portable Git bundle for this snapshot generation is required before retirement.');
  }
  return receipt;
}

async function preserveWorkspaceArtifactsNative(
  snapshot: WorkspaceSnapshotRecord,
  repositoryPath: string,
  options: { discardSource?: boolean } = {},
): Promise<WorkspacePreservationReceipt> {
  const repo = await findRepoByLocalPath(canonicalRepoRoot(repositoryPath));
  if (!repo || repo.id !== snapshot.repositoryUuid) throw new Error('Preservation repository ownership changed.');
  const managed = await readManagedWorkspaceMaterialization(repo.localPath, snapshot.originalPath);
  const lane = snapshot.laneId ? getLane(snapshot.laneId) : null;
  try {
    const environmentReferences = managed.metadata.environmentReferences ?? {};
    // References carry no copied bytes and may outlive or rotate their source.
    const bindings = await repoSetupCopyBindingRequirements({
      ...repo, setup: { ...repo.setup, envFiles: repo.setup.envFiles.filter((file) => (
        !Object.prototype.hasOwnProperty.call(environmentReferences, file.trim().replaceAll('\\', '/').replace(/^\.\//, ''))
      )) },
    });
    const capturePolicy = {
      rebuildablePaths: [
        'node_modules', '.o8-install-runtime', '.next/cache', '.turbo',
        ...await rebuildableCargoTargetPaths(snapshot.originalPath, managed.identity),
      ],
      copiedEnvironment: Object.fromEntries(
        Object.entries(bindings).map(([relativePath, binding]) => [relativePath, binding.sourceContentFingerprint]),
      ),
      environmentReferences,
      discardSource: options.discardSource === true,
    };
    const capture = await captureIgnoredArtifacts({
      workspacePath: snapshot.originalPath,
      identity: managed.identity,
      headCommit: snapshot.headCommit,
      treeSha: snapshot.treeSha,
      ...capturePolicy,
    });
    const payloadFor = (gitBundle: WorkspaceGitBundleReceipt): WorkspacePreservationPayload => ({
      schema: 'o8/workspace-preservation/v1',
      repositoryUuid: repo.id,
      repositoryPath: repo.localPath,
      packetId: snapshot.packetId,
      laneId: snapshot.laneId,
      worktreeId: managed.metadata.id,
      identity: managed.identity,
      capture,
      gitBundle,
      capturePolicy,
      handoff: {
        revision: snapshot.headCommit,
        treeSha: snapshot.treeSha,
        recoveryRef: snapshot.recoveryRef,
        outcome: lane?.outcome ?? lane?.status ?? 'unknown',
        remainingWork: lane?.outcomeNote?.trim() || 'Inspect the retained lane reports before deciding what remains.',
        evidence: {
          laneId: snapshot.laneId,
          snapshotGeneration: snapshot.snapshotGeneration,
          snapshotFingerprint: snapshot.snapshotFingerprint,
        },
        sessionIdentities: snapshot.sessionIdentities,
        recoveryInstructions: 'Download the verified portable Git bundle through private workspace preservation, import its recovery ref into an empty repository, and verify the head, tree and required parent objects. Restore selected ignored artifacts into an exactly owned, quiescent successor. Retain the original provider archive.',
      },
    });
    const verifyCapture = async () => {
      const repeated = await readManagedWorkspaceMaterialization(repo.localPath, snapshot.originalPath);
      if (repeated.identity.device !== managed.identity.device || repeated.identity.inode !== managed.identity.inode) {
        throw new Error('Workspace owner changed during portable preservation.');
      }
      const observed = await captureIgnoredArtifacts({
        workspacePath: snapshot.originalPath, identity: managed.identity,
        headCommit: snapshot.headCommit, treeSha: snapshot.treeSha, ...capturePolicy,
      });
      if (sha256(JSON.stringify(observed)) !== sha256(JSON.stringify(capture))) {
        throw new Error('Source or unique ignored artifacts changed during portable preservation.');
      }
    };
    // A trusted identical retry reads existing bytes without reserving or writing
    // capacity, even when the bank is full or contains an interrupted capture.
    const previousId = preservationIdForSnapshot(snapshot);
    if (previousId) {
      const previous = await readWorkspacePreservation(previousId);
      if (previous.receipt.gitBundle && JSON.stringify(previous.payload) === JSON.stringify(payloadFor(previous.receipt.gitBundle))) {
        await verifyCapture();
        return previous.receipt;
      }
    }
    const directory = await archiveDirectory();
    return await withPreservationBankAdmission(directory, async (admission) => {
      const gitBundle = await preserveWorkspaceGitBundle(snapshot, repo.localPath, admission);
      await verifyCapture();
      const payload = payloadFor(gitBundle);
      const content = Buffer.from(JSON.stringify(payload));
      if (content.length > PRESERVATION_BANK_POLICY.manifestBytes) throw new Error('Preservation manifest exceeds its reserved budget.');
      const preservationId = sha256(content);
      const destination = path.join(directory, preservationId + '.json');
      const finishManifest = beginPreservationBankWriter(admission);
      try {
        let file: Awaited<ReturnType<typeof open>> | undefined;
        try {
          file = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          await file.writeFile(content);
          await file.sync();
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1) throw new Error('Preservation publication lost exclusive file ownership.');
        } finally {
          if (file) await file.close();
          finishManifest(true);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const finishParent = beginPreservationBankWriter(admission);
      let parent: Awaited<ReturnType<typeof open>> | undefined;
      try {
        parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await parent.sync();
      } finally {
        if (parent) await parent.close();
        finishParent(true);
      }
      await readPayloadBytes(preservationId);
      getSqlite().prepare(`
        INSERT OR IGNORE INTO workspace_preservations (
          preservation_id, repository_uuid, repository_path, workspace_path, worktree_id,
          packet_id, lane_id, source_device, source_inode, head_commit, tree_sha,
          manifest_sha256, handoff_sha256, artifact_count, artifact_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        preservationId, repo.id, repo.localPath, managed.identity.canonicalPath, managed.metadata.id,
        snapshot.packetId, snapshot.laneId, managed.identity.device, managed.identity.inode,
        snapshot.headCommit, snapshot.treeSha, preservationId, sha256(JSON.stringify(payload.handoff)),
        capture.entries.filter((entry) => entry.kind === 'file').length, capture.bytes, Date.now(),
      );
      return (await readWorkspacePreservation(preservationId)).receipt;
    });
  } catch (error) {
    if (snapshot.laneId) {
      acquireWorkspaceRetentionHold({
        repositoryPath: repo.localPath,
        repositoryUuid: repo.id,
        worktreeId: managed.metadata.id,
        packetId: snapshot.packetId,
        laneId: snapshot.laneId,
        identity: managed.identity,
        holdId: 'preservation-failed:' + snapshot.snapshotFingerprint,
        reason: 'Required source or ignored-content preservation failed or was uncertain; verify the portable Git bundle and exact owner before releasing this hold.',
      });
    }
    throw error;
  }
}

export async function verifyPreservedArtifactsAtPath(
  preservationId: string,
  workspacePath: string,
  identity: WorktreeMaterializationIdentity,
  options: { requireCleanSource?: true } = {},
): Promise<void> {
  const { payload } = await readWorkspacePreservation(preservationId);
  if (identity.device !== payload.identity.device || identity.inode !== payload.identity.inode) {
    throw new Error('Preservation proof belongs to another materialization.');
  }
  const observed = await captureIgnoredArtifacts({
    workspacePath,
    identity,
    headCommit: payload.capture.headCommit,
    treeSha: payload.capture.treeSha,
    ...payload.capturePolicy,
    ...options,
  });
  if (sha256(JSON.stringify(observed)) !== sha256(JSON.stringify(payload.capture))) {
    throw new Error('Unique ignored artifacts changed after verified capture; retirement remains held.');
  }
}

export function preserveWorkspaceArtifacts(...args: Parameters<typeof preserveWorkspaceArtifactsNative>): ReturnType<typeof preserveWorkspaceArtifactsNative> {
  return timeClosePhase('preserveWorkspaceArtifacts', () => preserveWorkspaceArtifactsNative(...args));
}
