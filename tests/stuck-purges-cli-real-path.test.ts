import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import { buildCliBundle } from './fixtures/cli-bundle';

const run = promisify(execFile);
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-stuck-purges-cli-')));
const dataDir = path.join(root, 'data');
mkdirSync(dataDir);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { probeMetadataLockProcessIdentity } = await import('@/lib/worktree/metadata-lock-process-identity');
const { finishPendingExactManagedDirectoryRetirements, retireExactManagedDirectory } =
  await import('@/lib/workspace/exact-managed-directory-retirement');
const { readExactWorkspaceClaim } = await import('@/lib/workspace/exact-workspace-claim-state');

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

/** A retirement whose purge was interrupted after its inventory became durable, then changed. */
async function stuckPurge() {
  const parent = path.join(root, 'worktrees');
  const workspacePath = path.join(parent, 'packet-stuck');
  mkdirSync(path.join(workspacePath, 'node_modules', 'package'), { recursive: true });
  writeFileSync(path.join(workspacePath, 'node_modules', 'package', 'index.js'), 'owned');
  const owner = await probeMetadataLockProcessIdentity(process.pid);
  if (owner.state !== 'live') throw new Error('Fixture creator process is not proven live.');
  await withWorktreeMetaTransaction(parent, async (transaction) => transaction.save('packet-stuck', {
    id: 'packet-stuck', agentType: 'codex', baseBranch: 'main', createdAt: Date.now(),
    claudeManaged: false, taskName: 'Stuck purge fixture', status: 'creating',
    materializationIdentity: await captureWorktreeMaterializationIdentity(workspacePath),
    materializationParentIdentity: await captureWorktreeMaterializationIdentity(parent),
    creationOwner: { pid: process.pid, identity: owner.identity },
  }));
  let purgeChecks = 0;
  await expect(retireExactManagedDirectory({
    repositoryPath: parent,
    worktreeId: 'packet-stuck',
    directoryPath: workspacePath,
    identity: await captureWorktreeMaterializationIdentity(workspacePath),
    retirementReason: 'creation-rollback',
    beforeRetirementPurge: async () => {
      purgeChecks += 1;
      if (purgeChecks === 2) throw new Error('simulated process death after durable inventory');
    },
  })).rejects.toThrow('simulated process death');
  const claim = readExactWorkspaceClaim('managed-retirement', parent, 'packet-stuck')!;
  expect(claim.state).toBe('purging');
  const changedFile = path.join(claim.claimPath, 'node_modules', 'package', 'index.js');
  writeFileSync(changedFile, 'changed after the durable inventory');
  return { parent, claim, changedFile };
}

async function cli(bundle: string, ...args: string[]) {
  const { stdout } = await run(process.execPath, [bundle, 'workspace-cleanup', 'stuck-purges', ...args], {
    env: { ...process.env, O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir },
  });
  return JSON.parse(stdout) as {
    dryRun: boolean; removed: string[]; selected: string[];
    stuck: { operationId: string; inventoryEntries: number; refused: unknown; retiredDirectory: string }[];
    leftOnDisk: { operationId: string; path: string }[];
  };
}

describe('o8 workspace-cleanup stuck-purges', () => {
  it('lists a refused purge, abandons only its claim, and the next replay reads nothing for it', async () => {
    const { parent, claim, changedFile } = await stuckPurge();
    const replay = async () => finishPendingExactManagedDirectoryRetirements(
      parent, parent, await captureWorktreeMaterializationIdentity(parent), () => true,
    );
    await expect(replay()).resolves.toEqual({ completed: 0, refused: 1 });
    const bundle = path.join(root, 'o8.mjs');
    await buildCliBundle(bundle);

    const dryRun = await cli(bundle, '--abandon-refused');
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.stuck).toHaveLength(1);
    expect(dryRun.stuck[0]).toMatchObject({ operationId: claim.operationId, retiredDirectory: 'present' });
    expect(dryRun.stuck[0].inventoryEntries).toBeGreaterThan(1);
    expect(dryRun.stuck[0].refused).not.toBeNull();
    expect(dryRun.selected).toEqual([claim.operationId]);
    expect(dryRun.removed).toEqual([]);
    expect(readExactWorkspaceClaim('managed-retirement', parent, 'packet-stuck')?.operationId).toBe(claim.operationId);

    const applied = await cli(bundle, '--abandon-refused', '--apply');
    expect(applied.removed).toEqual([claim.operationId]);
    expect(applied.leftOnDisk).toEqual([expect.objectContaining({ operationId: claim.operationId, path: claim.claimPath })]);
    expect(readExactWorkspaceClaim('managed-retirement', parent, 'packet-stuck')).toBeNull();
    expect(getSqlite().prepare('SELECT 1 FROM workspace_exact_replay_refusals WHERE operation_id = ?')
      .get(claim.operationId)).toBeUndefined();

    // The next startup replay has no claim to read; the retired tree stays for the owner.
    await expect(replay()).resolves.toEqual({ completed: 0, refused: 0 });
    expect(readFileSync(changedFile, 'utf8')).toBe('changed after the durable inventory');
    expect(existsSync(claim.claimPath)).toBe(true);
    expect(readdirSync(parent)).toContain(path.basename(claim.claimPath));
    expect((await cli(bundle)).stuck).toEqual([]);
  });
});
