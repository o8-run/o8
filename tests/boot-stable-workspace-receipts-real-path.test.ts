import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-boot-stable-receipts-'));
const originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
const originalO8DataDir = process.env.O8_DATA_DIR;
const originalWorktreeRoot = process.env.O8_WORKTREE_ROOT;
const originalSkipTypecheck = process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(dataDir, 'worktrees');
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { recordOrchestratorReview } = await import('@/lib/approvals/store');
const { closeDb, getSqlite } = await import('@/lib/db');
const { recordMission } = await import('@/lib/db/missions-store');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { approveAndMergePacket } = await import('@/lib/orchestrator/operator-mission-service');
const {
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const {
  createEmptyOrchestratorMissionState,
} = await import('@/lib/orchestrator/store');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const {
  readManagedWorkspaceMaterialization,
} = await import('@/lib/workspace/managed-materialization-identity');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');

const roots: string[] = [];

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initializeRepo(label: string): { origin: string; repo: string } {
  const root = realpathSync(mkdtempSync(path.join(dataDir, `${label}-`)));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'operator');
  roots.push(root);
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'chore: initialize reboot receipt fixture']);
  git(repo, ['push', '-u', 'origin', 'main']);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { origin, repo };
}

async function provisionPacket(repo: string, packetId: string) {
  return getWorktreeManager(repo).create({
    agentType: 'codex',
    taskName: packetId,
    branchName: `inline/${packetId}`,
    baseBranch: 'main',
    packetId,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  });
}

function commitPacketChange(workspacePath: string, label: string): string {
  const filename = `${label}.txt`;
  git(workspacePath, ['config', 'user.name', 'o8-test']);
  git(workspacePath, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(path.join(workspacePath, filename), `${label}\n`);
  git(workspacePath, ['add', filename]);
  git(workspacePath, ['commit', '-m', `fix: add ${label} receipt fixture`]);
  return git(workspacePath, ['rev-parse', 'HEAD']);
}

function metadataState(repo: string): {
  metadataRoot: string;
  mirrorIdentity: Record<string, unknown>;
  payload: {
    version: number;
    worktrees: Record<string, {
      materializationIdentity?: Record<string, unknown>;
      materializationParentIdentity?: Record<string, unknown>;
    }>;
  };
} {
  const metadataRoot = realpathSync(resolveWorktreeRootLayout(repo).primaryBase);
  const row = getSqlite().prepare(`
    SELECT payload_json, mirror_identity_json
    FROM worktree_metadata_state WHERE metadata_root = ?
  `).get(metadataRoot) as {
    payload_json: string;
    mirror_identity_json: string;
  } | undefined;
  if (!row) throw new Error('Expected persisted worktree metadata state.');
  return {
    metadataRoot,
    mirrorIdentity: JSON.parse(row.mirror_identity_json) as Record<string, unknown>,
    payload: JSON.parse(row.payload_json) as {
      version: number;
      worktrees: Record<string, {
        materializationIdentity?: Record<string, unknown>;
        materializationParentIdentity?: Record<string, unknown>;
      }>;
    },
  };
}

function persistMetadataState(
  metadataRoot: string,
  payload: object,
  mirrorIdentity: object,
): void {
  getSqlite().prepare(`
    UPDATE worktree_metadata_state
    SET payload_json = ?, mirror_identity_json = ?, updated_at = ?
    WHERE metadata_root = ?
  `).run(JSON.stringify(payload), JSON.stringify(mirrorIdentity), Date.now(), metadataRoot);
}

function rewritePersistedDeviceReceipts(
  repo: string,
  worktreeId: string,
  includeMirror: boolean,
): void {
  const state = metadataState(repo);
  const entry = state.payload.worktrees[worktreeId];
  if (!entry?.materializationIdentity || !entry.materializationParentIdentity) {
    throw new Error('Expected persisted materialization receipts.');
  }
  entry.materializationIdentity.device = Number(entry.materializationIdentity.device) + 1;
  entry.materializationParentIdentity.device = Number(entry.materializationParentIdentity.device) + 1;
  delete entry.materializationIdentity.volumeId;
  delete entry.materializationParentIdentity.volumeId;
  if (includeMirror) {
    state.mirrorIdentity.device = Number(state.mirrorIdentity.device) + 1;
    delete state.mirrorIdentity.canonicalPath;
    delete state.mirrorIdentity.volumeId;
  }
  persistMetadataState(state.metadataRoot, state.payload, state.mirrorIdentity);
}

function rewritePersistedMaterializationField(
  repo: string,
  worktreeId: string,
  field: 'inode' | 'canonicalPath' | 'volumeId',
): void {
  const state = metadataState(repo);
  const identity = state.payload.worktrees[worktreeId]?.materializationIdentity;
  if (!identity) throw new Error('Expected persisted materialization identity.');
  if (field === 'inode') identity.inode = Number(identity.inode) + 1;
  else if (field === 'canonicalPath') {
    identity.canonicalPath = `${String(identity.canonicalPath)}-different`;
  } else {
    identity.volumeId = 'volume-uuid:00000000-0000-0000-0000-000000000000';
  }
  persistMetadataState(state.metadataRoot, state.payload, state.mirrorIdentity);
}

function registerReviewedPacket(input: {
  packetId: string;
  repo: string;
  branch: string;
  workspacePath: string;
  reviewedHeadSha: string;
}): void {
  const lane = createLane({
    repoPath: input.repo,
    worktreePath: input.workspacePath,
    branch: input.branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId: input.packetId,
    sessionKey: `codex:${input.packetId}`,
    label: `Boot-stable receipt ${input.packetId}`,
  });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');
  recordOrchestratorReview(input.packetId, {
    approved: true,
    findings: [],
    reviewer: 'codex',
    reviewedHeadSha: input.reviewedHeadSha,
    requiresSecondPass: false,
  });
  const packet: OrchestratorPacket = {
    id: input.packetId,
    referenceLabel: 'P1',
    title: 'Boot-stable workspace receipt',
    summary: 'Prove a managed workspace across a simulated reboot.',
    status: 'awaiting_review',
    queueState: 'held',
    releaseState: 'pending',
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    blockedReason: null,
    lane: null,
    review: {
      approved: true,
      findings: [],
      recordedAt: new Date().toISOString(),
      reviewedHeadSha: input.reviewedHeadSha,
      summary: 'Approved. No findings recorded.',
      auditApprovalId: null,
    },
    workspaceTargetPath: input.repo,
    branchTarget: input.branch,
  } as OrchestratorPacket;
  const missionId = `mission-${input.packetId}`;
  const mission: OrchestratorMissionState = {
    ...createEmptyOrchestratorMissionState(),
    missionId,
    repoPath: input.repo,
    prompt: packet.summary,
    summary: packet.summary,
    packets: [packet],
    updatedAt: new Date().toISOString(),
  };
  recordMission({
    id: missionId,
    repoPath: input.repo,
    runtime: 'codex',
    prompt: mission.prompt,
    summary: mission.summary,
    constraints: '',
    packetMeta: [{ id: packet.id, title: packet.title, referenceLabel: packet.referenceLabel }],
    missionState: mission,
    totalWaves: 1,
  });
  writeOrchestratorControlPlaneState(mission);
}

beforeAll(async () => {
  await updateOperatorDefaults({
    storageReserveRatio: 0.0001,
    storageReserveFloorGb: 0.001,
  });
});

afterEach(() => {
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  restoreEnv('CORTEX_IDE_DATA_DIR', originalDataDir);
  restoreEnv('O8_DATA_DIR', originalO8DataDir);
  restoreEnv('O8_WORKTREE_ROOT', originalWorktreeRoot);
  restoreEnv('O8_SKIP_PRELAUNCH_TYPECHECK', originalSkipTypecheck);
});

describe('boot-stable workspace receipts through provision and merge', () => {
  it('re-imports a legacy mirror, provisions again, and merges after device numbers change', async () => {
    const { repo } = initializeRepo('reboot-success');
    const firstPacketId = `reboot-first-${Date.now()}`;
    const secondPacketId = `reboot-second-${Date.now()}`;
    const first = await provisionPacket(repo, firstPacketId);
    const reviewedHeadSha = commitPacketChange(first.path, 'first-reboot-change');

    rewritePersistedDeviceReceipts(repo, first.id, true);
    const second = await provisionPacket(repo, secondPacketId);

    const migrated = metadataState(repo);
    const mirrorPath = path.join(migrated.metadataRoot, '.meta.json');
    const mirrorStat = lstatSync(mirrorPath);
    expect(migrated.mirrorIdentity).toMatchObject({
      device: mirrorStat.dev,
      inode: mirrorStat.ino,
      canonicalPath: realpathSync(mirrorPath),
    });
    expect(migrated.mirrorIdentity.volumeId).toEqual(expect.any(String));
    expect(migrated.payload.worktrees[first.id]?.materializationIdentity?.volumeId).toBeUndefined();
    expect(migrated.payload.worktrees[first.id]?.materializationParentIdentity?.volumeId).toBeUndefined();

    rewritePersistedDeviceReceipts(repo, second.id, false);
    const migratedSecond = await readManagedWorkspaceMaterialization(repo, second.path);
    const secondStat = lstatSync(second.path);
    expect(migratedSecond.identity).toMatchObject({
      device: secondStat.dev,
      inode: secondStat.ino,
      canonicalPath: realpathSync(second.path),
      volumeId: expect.any(String),
    });
    const persistedSecond = metadataState(repo).payload.worktrees[second.id];
    expect(persistedSecond?.materializationIdentity).toEqual(migratedSecond.identity);
    expect(persistedSecond?.materializationParentIdentity?.volumeId).toEqual(expect.any(String));

    const reservations = getSqlite().prepare(`
      SELECT volume_id FROM storage_admission_reservations
      WHERE owner_id LIKE ? OR owner_id LIKE ?
      ORDER BY created_at
    `).all(`%:${firstPacketId}`, `%:${secondPacketId}`) as Array<{ volume_id: string }>;
    expect(reservations).toHaveLength(2);
    expect(new Set(reservations.map((row) => row.volume_id)).size).toBe(1);
    expect(reservations[0]!.volume_id).not.toMatch(/^device:/);

    registerReviewedPacket({
      packetId: firstPacketId,
      repo,
      branch: `inline/${firstPacketId}`,
      workspacePath: first.path,
      reviewedHeadSha,
    });
    const merged = await approveAndMergePacket({
      packetId: firstPacketId,
      expectedHeadSha: reviewedHeadSha,
      actor: 'user',
    });

    expect(merged).toMatchObject({ merged: true });
    expect(git(repo, ['rev-parse', 'main'])).toBe(merged.mergeSha);
    expect(git(repo, ['ls-tree', '-r', '--name-only', 'main'])).toContain('first-reboot-change.txt');
    expect(second.path).toContain(process.env.O8_WORKTREE_ROOT);
  }, 90_000);

  it.each([
    ['inode', /inode/i],
    ['canonicalPath', /canonical path/i],
    ['volumeId', /volume identity/i],
  ] as const)('refuses a changed %s receipt and names the mismatched field', async (field, reason) => {
    const fieldLabel = field === 'canonicalPath'
      ? 'canonical-path'
      : field === 'volumeId'
        ? 'volume-id'
        : field;
    const { repo } = initializeRepo(`reboot-${fieldLabel}`);
    const packetId = `reboot-${fieldLabel}-${Date.now()}`;
    const created = await provisionPacket(repo, packetId);
    const reviewedHeadSha = commitPacketChange(created.path, `${field}-mismatch`);
    rewritePersistedMaterializationField(repo, created.id, field);
    registerReviewedPacket({
      packetId,
      repo,
      branch: `inline/${packetId}`,
      workspacePath: created.path,
      reviewedHeadSha,
    });

    const refused = await approveAndMergePacket({
      packetId,
      expectedHeadSha: reviewedHeadSha,
      actor: 'user',
    });

    expect(refused.merged).toBe(false);
    expect(refused.note).toMatch(reason);
  }, 60_000);
});
