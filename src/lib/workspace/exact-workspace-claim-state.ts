import 'server-only';

import path from 'node:path';

import { getSqlite } from '@/lib/db';
import { assertWorkspaceRetentionReleased } from './retention-holds';
import type { WorktreeMaterializationIdentity } from '@/lib/worktree/materialization-identity';
import type { MetadataLockProcessIdentity } from '@/lib/worktree/metadata-lock-process-identity';

export type ExactWorkspaceClaimKind =
  | 'restore-creation'
  | 'worktree-quarantine'
  | 'managed-retirement'
  | 'generated-output-retirement'
  | 'generated-output-recovery-retirement';
export type ExactWorkspaceClaimState = 'prepared' | 'claimed' | 'published' | 'purging';

export interface ExactWorkspaceClaimRecord {
  kind: ExactWorkspaceClaimKind;
  repositoryPath: string;
  worktreeId: string;
  operationId: string;
  expectedPath: string;
  sourcePath: string;
  claimPath: string;
  state: ExactWorkspaceClaimState;
  parentIdentity: WorktreeMaterializationIdentity;
  sourceIdentity: { device: number; inode: number } | null;
  claimIdentity: { device: number; inode: number } | null;
  contentDigest: string | null;
  authority: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

interface ExactWorkspaceClaimRow {
  kind: string;
  repository_path: string;
  worktree_id: string;
  operation_id: string;
  expected_path: string;
  source_path: string;
  claim_path: string;
  state: string;
  parent_device: number;
  parent_inode: number;
  parent_canonical_path: string;
  source_device: number | null;
  source_inode: number | null;
  claim_device: number | null;
  claim_inode: number | null;
  content_digest: string | null;
  authority_json: string | null;
  created_at: number;
  updated_at: number;
}

function decode(row: ExactWorkspaceClaimRow): ExactWorkspaceClaimRecord {
  return {
    kind: row.kind as ExactWorkspaceClaimKind,
    repositoryPath: row.repository_path,
    worktreeId: row.worktree_id,
    operationId: row.operation_id,
    expectedPath: row.expected_path,
    sourcePath: row.source_path,
    claimPath: row.claim_path,
    state: row.state as ExactWorkspaceClaimState,
    parentIdentity: {
      device: row.parent_device,
      inode: row.parent_inode,
      canonicalPath: row.parent_canonical_path,
    },
    sourceIdentity: row.source_device === null || row.source_inode === null
      ? null : { device: row.source_device, inode: row.source_inode },
    claimIdentity: row.claim_device === null || row.claim_inode === null
      ? null : { device: row.claim_device, inode: row.claim_inode },
    contentDigest: row.content_digest,
    authority: row.authority_json ? JSON.parse(row.authority_json) as Record<string, unknown> : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function exactMatch(actual: ExactWorkspaceClaimRecord, expected: ExactWorkspaceClaimRecord): boolean {
  return actual.kind === expected.kind
    && actual.repositoryPath === expected.repositoryPath
    && actual.worktreeId === expected.worktreeId
    && actual.operationId === expected.operationId
    && actual.expectedPath === expected.expectedPath
    && actual.sourcePath === expected.sourcePath
    && actual.claimPath === expected.claimPath
    && actual.parentIdentity.device === expected.parentIdentity.device
    && actual.parentIdentity.inode === expected.parentIdentity.inode
    && actual.parentIdentity.canonicalPath === expected.parentIdentity.canonicalPath
    && actual.sourceIdentity?.device === expected.sourceIdentity?.device
    && actual.sourceIdentity?.inode === expected.sourceIdentity?.inode
    && actual.contentDigest === expected.contentDigest
    && JSON.stringify(actual.authority) === JSON.stringify(expected.authority);
}

export function prepareExactWorkspaceClaim(
  input: Omit<ExactWorkspaceClaimRecord, 'state' | 'sourceIdentity' | 'claimIdentity' | 'createdAt' | 'updatedAt'>
  & { sourceIdentity?: { device: number; inode: number } | null; now?: number },
): ExactWorkspaceClaimRecord {
  const now = input.now ?? Date.now();
  const candidate: ExactWorkspaceClaimRecord = {
    ...input,
    repositoryPath: path.resolve(input.repositoryPath),
    expectedPath: path.resolve(input.expectedPath),
    sourcePath: path.resolve(input.sourcePath),
    claimPath: path.resolve(input.claimPath),
    state: 'prepared',
    sourceIdentity: input.sourceIdentity ?? null,
    claimIdentity: null,
    createdAt: now,
    updatedAt: now,
  };
  const sqlite = getSqlite();
  return sqlite.transaction(() => {
    const legacy = sqlite.prepare(`SELECT operation_id FROM workspace_legacy_output_parks
      WHERE workspace_path = ? OR retained_path = ? OR (source_device = ? AND source_inode = ?) LIMIT 1`)
      .get(candidate.sourcePath, candidate.sourcePath, candidate.sourceIdentity?.device ?? -1, candidate.sourceIdentity?.inode ?? -1);
    if (legacy) throw new Error('Exact claim cannot retire a workspace or directory with retained legacy output.');
    if (candidate.kind !== 'generated-output-retirement') {
      assertWorkspaceRetentionReleased(candidate.sourcePath, candidate.sourceIdentity ?? undefined);
      const output = sqlite.prepare(`
        SELECT resource_id FROM workspace_generated_outputs
        WHERE workspace_path = ? AND state != 'retired' LIMIT 1
      `).get(candidate.sourcePath);
      if (output) throw new Error('Containing workspace has generated output with unresolved retention.');
    }
    if (candidate.kind === 'generated-output-retirement') {
      assertWorkspaceRetentionReleased(candidate.sourcePath, candidate.sourceIdentity ?? undefined);
      assertWorkspaceRetentionReleased(candidate.parentIdentity.canonicalPath, candidate.parentIdentity);
      const conflicting = sqlite.prepare(`
        SELECT operation_id FROM workspace_exact_claims WHERE kind != 'generated-output-retirement'
          AND (expected_path = ? OR source_path = ? OR claim_path = ?
            OR (source_device = ? AND source_inode = ?)) LIMIT 1
      `).get(candidate.parentIdentity.canonicalPath, candidate.parentIdentity.canonicalPath,
        candidate.parentIdentity.canonicalPath, candidate.parentIdentity.device, candidate.parentIdentity.inode);
      const snapshot = sqlite.prepare(`
        SELECT packet_id FROM workspace_snapshots WHERE original_path = ?
          AND state NOT IN ('materialized') LIMIT 1
      `).get(candidate.parentIdentity.canonicalPath);
      if (conflicting || snapshot) throw new Error('Containing workspace is changing materialization.');
    }
    sqlite.prepare(`
      INSERT OR IGNORE INTO workspace_exact_claims (
        kind, repository_path, worktree_id, operation_id,
        expected_path, source_path, claim_path, state,
        parent_device, parent_inode, parent_canonical_path,
        source_device, source_inode, claim_device, claim_inode,
        content_digest, authority_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
    `).run(
      candidate.kind, candidate.repositoryPath, candidate.worktreeId, candidate.operationId,
      candidate.expectedPath, candidate.sourcePath, candidate.claimPath,
      candidate.parentIdentity.device, candidate.parentIdentity.inode,
      candidate.parentIdentity.canonicalPath,
      candidate.sourceIdentity?.device ?? null, candidate.sourceIdentity?.inode ?? null,
      candidate.contentDigest, candidate.authority ? JSON.stringify(candidate.authority) : null,
      now, now,
    );
    const actual = readExactWorkspaceClaim(candidate.kind, candidate.repositoryPath, candidate.worktreeId);
    if (!actual || !exactMatch(actual, candidate)) {
      throw new Error('Exact workspace claim conflicts with durable trusted authority.');
    }
    return actual;
  }).immediate();
}

export function readExactWorkspaceClaim(
  kind: ExactWorkspaceClaimKind,
  repositoryPath: string,
  worktreeId: string,
): ExactWorkspaceClaimRecord | null {
  const row = getSqlite().prepare(`
    SELECT * FROM workspace_exact_claims
    WHERE kind = ? AND repository_path = ? AND worktree_id = ?
  `).get(kind, path.resolve(repositoryPath), worktreeId) as ExactWorkspaceClaimRow | undefined;
  return row ? decode(row) : null;
}

export function bindExactWorkspaceClaimCreator(input: {
  repositoryPath: string;
  worktreeId: string;
  operationId: string;
  pid: number;
  processIdentity: MetadataLockProcessIdentity;
}): ExactWorkspaceClaimRecord {
  const current = readExactWorkspaceClaim('restore-creation', input.repositoryPath, input.worktreeId);
  if (!current || current.operationId !== input.operationId || current.state !== 'prepared') {
    throw new Error('Exact restore creator binding lost its prepared claim.');
  }
  const authority = {
    ...(current.authority ?? {}),
    creatorPid: input.pid,
    creatorProcessIdentity: input.processIdentity,
  };
  const result = getSqlite().prepare(`
    UPDATE workspace_exact_claims SET authority_json = ?, updated_at = ?
    WHERE kind = 'restore-creation' AND repository_path = ? AND worktree_id = ?
      AND operation_id = ? AND state = 'prepared'
  `).run(
    JSON.stringify(authority), Date.now(), path.resolve(input.repositoryPath),
    input.worktreeId, input.operationId,
  );
  if (result.changes !== 1) throw new Error('Exact restore creator binding lost its trusted CAS.');
  return readExactWorkspaceClaim(
    'restore-creation', input.repositoryPath, input.worktreeId,
  )!;
}

const REPLAY_RETRY_MS = 24 * 60 * 60_000;
const REPLAY_RETRY_MAX_MS = 7 * REPLAY_RETRY_MS;

/**
 * Replay refusals for unchanged claims. A purge that diverged from its manifest
 * can never finish, and each replay reloads the manifest: one stuck
 * node_modules purge holds 190k entries (about 45 MB of JSON).
 */
function replayRefusalStore() {
  const sqlite = getSqlite();
  sqlite.exec(`CREATE TABLE IF NOT EXISTS workspace_exact_replay_refusals (
    operation_id TEXT PRIMARY KEY,
    claim_updated_at INTEGER NOT NULL,
    refusals INTEGER NOT NULL,
    retry_after INTEGER NOT NULL
  )`);
  return sqlite;
}

/**
 * List exact replay candidates without pulling their purge manifests into
 * memory. A claim refused by an earlier replay waits for its retry time
 * unless the claim row changed since that refusal.
 */
export function listManagedRetirementClaimKeys(
  repositoryPath: string,
  parent: WorktreeMaterializationIdentity,
  now = Date.now(),
): { worktreeId: string; operationId: string; sourcePath: string }[] {
  const sqlite = replayRefusalStore();
  sqlite.prepare(`DELETE FROM workspace_exact_replay_refusals
    WHERE operation_id NOT IN (SELECT operation_id FROM workspace_exact_claims)`).run();
  return sqlite.prepare(`
    SELECT worktree_id AS worktreeId, operation_id AS operationId, source_path AS sourcePath
    FROM workspace_exact_claims AS claim
    WHERE kind = 'managed-retirement' AND repository_path = ?
      AND parent_device = ? AND parent_inode = ? AND parent_canonical_path = ?
      AND NOT EXISTS (
        SELECT 1 FROM workspace_exact_replay_refusals AS refusal
        WHERE refusal.operation_id = claim.operation_id
          AND refusal.claim_updated_at = claim.updated_at AND refusal.retry_after > ?
      )
    ORDER BY created_at ASC
  `).all(path.resolve(repositoryPath), parent.device, parent.inode, parent.canonicalPath, now) as {
    worktreeId: string; operationId: string; sourcePath: string;
  }[];
}

/** Back off a refused replay: one day, doubling per refusal of the same claim row, at most a week. */
export function recordManagedRetirementReplayRefusal(operationId: string, now = Date.now()): void {
  const sqlite = replayRefusalStore();
  const claim = sqlite.prepare(`SELECT updated_at AS updatedAt FROM workspace_exact_claims
    WHERE kind = 'managed-retirement' AND operation_id = ?`).get(operationId) as { updatedAt: number } | undefined;
  if (!claim) return;
  const prior = sqlite.prepare(`SELECT claim_updated_at AS claimUpdatedAt, refusals
    FROM workspace_exact_replay_refusals WHERE operation_id = ?`).get(operationId) as
    { claimUpdatedAt: number; refusals: number } | undefined;
  const refusals = prior?.claimUpdatedAt === claim.updatedAt ? prior.refusals + 1 : 1;
  const delay = Math.min(REPLAY_RETRY_MAX_MS, REPLAY_RETRY_MS * 2 ** Math.min(refusals - 1, 8));
  sqlite.prepare(`INSERT INTO workspace_exact_replay_refusals
    (operation_id, claim_updated_at, refusals, retry_after) VALUES (?, ?, ?, ?)
    ON CONFLICT(operation_id) DO UPDATE SET claim_updated_at = excluded.claim_updated_at,
      refusals = excluded.refusals, retry_after = excluded.retry_after`)
    .run(operationId, claim.updatedAt, refusals, now + delay);
}

export function clearManagedRetirementReplayRefusal(operationId: string): void {
  replayRefusalStore().prepare('DELETE FROM workspace_exact_replay_refusals WHERE operation_id = ?').run(operationId);
}

export function transitionExactWorkspaceClaim(input: {
  kind: ExactWorkspaceClaimKind;
  repositoryPath: string;
  worktreeId: string;
  operationId: string;
  expectedState: ExactWorkspaceClaimState;
  toState: ExactWorkspaceClaimState;
  claimIdentity?: { device: number; inode: number } | null;
  authority?: Record<string, unknown>;
  now?: number;
}): ExactWorkspaceClaimRecord {
  const now = input.now ?? Date.now();
  const result = getSqlite().prepare(`
    UPDATE workspace_exact_claims SET
      state = ?,
      claim_device = COALESCE(?, claim_device),
      claim_inode = COALESCE(?, claim_inode),
      authority_json = COALESCE(?, authority_json),
      updated_at = ?
    WHERE kind = ? AND repository_path = ? AND worktree_id = ?
      AND operation_id = ? AND state = ?
  `).run(
    input.toState,
    input.claimIdentity?.device ?? null,
    input.claimIdentity?.inode ?? null,
    input.authority ? JSON.stringify(input.authority) : null,
    now,
    input.kind,
    path.resolve(input.repositoryPath),
    input.worktreeId,
    input.operationId,
    input.expectedState,
  );
  const current = readExactWorkspaceClaim(input.kind, input.repositoryPath, input.worktreeId);
  if (result.changes !== 1 && (current?.operationId !== input.operationId
    || current.state !== input.toState
    || (input.authority && JSON.stringify(current.authority) !== JSON.stringify(input.authority))
    || (input.claimIdentity && (current.claimIdentity?.device !== input.claimIdentity.device
      || current.claimIdentity.inode !== input.claimIdentity.inode)))) {
    throw new Error('Exact workspace claim transition lost its trusted CAS.');
  }
  if (!current) throw new Error('Exact workspace claim disappeared after transition.');
  return current;
}

export function removeExactWorkspaceClaim(
  kind: ExactWorkspaceClaimKind,
  repositoryPath: string,
  worktreeId: string,
  operationId: string,
): void {
  const result = getSqlite().prepare(`
    DELETE FROM workspace_exact_claims
    WHERE kind = ? AND repository_path = ? AND worktree_id = ? AND operation_id = ?
  `).run(kind, path.resolve(repositoryPath), worktreeId, operationId);
  if (result.changes > 1) throw new Error('Exact workspace claim removal changed multiple rows.');
}

/** Child-only CAS config; the child never receives a filesystem capability. */
export function exactWorkspaceClaimChildAuthority(): {
  sqliteModuleAnchor: string;
  databasePath: string;
} {
  const sqlite = getSqlite();
  return {
    // Both server launchers use the application root as cwd. Let the unbundled
    // child resolve SQLite here instead of serializing a bundler module ID.
    sqliteModuleAnchor: path.join(process.cwd(), 'package.json'),
    databasePath: sqlite.name,
  };
}
