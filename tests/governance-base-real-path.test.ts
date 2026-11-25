import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-governance-base-'));
process.env.CORTEX_IDE_DATA_DIR = path.join(root, 'data');
process.env.O8_DATA_DIR = path.join(root, 'data');
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
mkdirSync(process.env.O8_WORKTREE_ROOT, { recursive: true });

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed', probePath: root, availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null,
  })),
}));
vi.mock('@/lib/worktree/apfs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/apfs')>(),
  getApfsCowCapability: vi.fn(async () => ({ macos: true, apfs: true, sameVolume: true, canCowClone: true })),
}));

const { closeDb } = await import('@/lib/db');
const { dispatch, raiseWorkerMergeApproval } = await import('@/lib/lane/commands');
const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
const { previewPacketMerge } = await import('@/lib/lane/preview-merge');
const { getApproval, listApprovalsForContext } = await import('@/lib/approvals/store');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

async function fixture(label: string, grow: boolean, savedBase?: string) {
  const repo = path.join(root, label);
  mkdirSync(repo);
  git(repo, ['init', '-b', 'main']);
  writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  const staleMain = commit(repo, 'old local main');
  writeFileSync(path.join(repo, 'upstream.ts'), '// upstream only\n'.repeat(900));
  writeFileSync(path.join(repo, 'shrinking.ts'), '// existing large file\n'.repeat(1_000));
  const base = commit(repo, 'assigned packet base');
  const packetId = `pkt-governance-${label}`;
  const branch = `packet/${label}`;
  const checkout = await getWorktreeManager(repo).create({
    agentType: 'codex', taskName: packetId, branchName: branch, baseBranch: 'main',
    packetId, skipSetup: true, isolationPreference: 'apfs-cow-clone',
  });
  // Clone copying runs on Linux; only the filesystem capability probe is stubbed.
  expect(checkout.isolationKind).toBe('apfs-cow-clone');
  git(checkout.path, ['branch', '-f', 'main', staleMain]);
  writeFileSync(path.join(checkout.path, 'packet.ts'), '// packet change\n'.repeat(grow ? 850 : 1));
  writeFileSync(path.join(checkout.path, 'shrinking.ts'), '// existing large file\n'.repeat(900));
  const head = commit(checkout.path, 'packet changes');
  const lane = createLane({
    repoPath: repo, worktreePath: checkout.path, branch, baseBranch: 'main', baseCommit: savedBase ?? base,
    runtime: 'codex', packetId,
  });
  expect(getLaneEvents(lane.id).find(event => event.verb === 'open_lane')?.payload.baseCommit).toBe(savedBase ?? base);
  expect(git(checkout.path, ['diff', '--name-only', 'main...HEAD'])).toContain('upstream.ts');
  return { lane, packetId, base, head };
}

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

describe('governance uses the persisted packet base', () => {
  it('shows only packet changes and their base on a file-size approval card', async () => {
    await updateOperatorDefaults({ requireApproval: 'high-risk',
      storageReserveRatio: 0.0001, storageReserveFloorGb: 0.001 });
    const { lane, packetId, base } = await fixture('oversized', true);
    const result = await dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' });
    expect(result.approvalId).toBeTruthy();
    const approval = getApproval(result.approvalId!);
    expect(approval?.policyRuleId).toBe('file_size_limit');
    expect(approval?.diff?.files?.map(file => file.path).sort()).toEqual(['packet.ts', 'shrinking.ts']);
    expect(approval?.metadata).toMatchObject({ 'Base SHA': base, 'Changed file count': '2',
      'File path': 'packet.ts', 'Original line count': '0', 'Current line count': '850' });
    expect(approval?.description).not.toContain('upstream.ts');
    expect(approval?.description).not.toContain('shrinking.ts');
    const preview = await previewPacketMerge(packetId);
    expect(preview.diffBase?.comparisonRef).toBe(base);
    expect(preview.reviewRequirements?.oversizedFiles).toEqual([
      { path: 'packet.ts', lineCount: 850, originalLineCount: 0 },
    ]);
  });

  it('does not require a size override for upstream or shrinking files', async () => {
    const { packetId, base } = await fixture('small', false);
    const preview = await previewPacketMerge(packetId);
    expect(preview.diffBase?.comparisonRef).toBe(base);
    expect(preview.checks.find(check => check.name === 'file-size-approval')?.verdict).toBe('pass');
    expect(preview.reviewRequirements?.oversizedFiles).toEqual([]);
  });

  it('refuses approval creation and preview when the saved base is unavailable', async () => {
    const { lane, packetId } = await fixture('missing-base', true, '1'.repeat(40));
    await expect(dispatch({ verb: 'merge', laneId: lane.id, actor: 'orchestrator' }))
      .rejects.toThrow('Saved packet creation base');
    await expect(raiseWorkerMergeApproval(lane)).rejects.toThrow('Saved packet creation base');
    await expect(previewPacketMerge(packetId)).rejects.toThrow('Saved packet creation base');
    expect(listApprovalsForContext({ laneId: lane.id })).toEqual([]);
  });
});
