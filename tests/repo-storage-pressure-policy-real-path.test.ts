import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PacketStorageAdmissionCoordinator } from '@/lib/orchestrator/storage-admission';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
const dataDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-repo-pressure-policy-')));
const repoPath = path.join(dataDir, 'repo');
mkdirSync(repoPath, { recursive: true });
execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: repoPath });
process.env.CORTEX_IDE_DATA_DIR = dataDir;
writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({
  version: 1,
  repos: [{
    id: 'repo-pressure',
    name: 'repo',
    localPath: repoPath,
    remoteUrl: null,
    defaultBranch: 'main',
    isGitRepo: true,
    addedAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: null,
    setup: {
      envMode: 'copy',
      envFiles: [],
      installCommand: null,
      installOnCreateWorkspace: false,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: null,
      defaultPort: null,
      workspaceIsolationPreference: 'auto',
    },
  }],
}));

const registry = await import('@/lib/repos/registry');
const reposRoute = await import('@/app/api/panel/repos/route');
const { createStoragePressureAdmissionCoordinator } = await import('@/lib/orchestrator/storage-pressure-policy');
const { PacketStorageAdmissionError } = await import('@/lib/orchestrator/storage-admission');

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
});

async function post(body: unknown) {
  return reposRoute.POST(new Request('http://127.0.0.1/api/panel/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('repository storage-pressure parking policy', () => {
  it('normalizes legacy rows to eligible and persists an explicit opt-out through the real route', async () => {
    expect((await registry.listRepos())[0]?.storagePressureParkingDisabled).toBe(false);

    const response = await post({
      action: 'update',
      id: 'repo-pressure',
      storagePressureParkingDisabled: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      repo: { id: 'repo-pressure', storagePressureParkingDisabled: true },
    });
    const stored = JSON.parse(readFileSync(path.join(dataDir, 'repos.json'), 'utf8')) as {
      repos: Array<{ storagePressureParkingDisabled?: boolean }>;
    };
    expect(stored.repos[0]?.storagePressureParkingDisabled).toBe(true);
  });

  it('rejects a non-boolean opt-out without changing durable policy', async () => {
    const response = await post({
      action: 'update',
      id: 'repo-pressure',
      storagePressureParkingDisabled: 'yes',
    });
    expect(response.status).toBe(400);
    expect((await registry.listRepos())[0]?.storagePressureParkingDisabled).toBe(true);
  });

  it('preserves a concurrent opt-out when a last-opened touch writes the same registry', async () => {
    await post({ action: 'update', id: 'repo-pressure', storagePressureParkingDisabled: false });
    const childTouch = new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        './node_modules/vitest/vitest.mjs', 'run',
        'tests/fixtures/repo-pressure-policy-child.test.ts', '--reporter=dot',
      ], {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          CORTEX_IDE_DATA_DIR: dataDir,
          O8_TEST_DATA_DIR_PINNED: dataDir,
          O8_TEST_REPO_POLICY_CHILD: '1',
          O8_TEST_REPO_POLICY_ACTION: 'touch',
        },
        stdio: 'pipe',
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += String(chunk); });
      child.stderr.on('data', (chunk) => { output += String(chunk); });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(output)));
    });
    const [policyResponse] = await Promise.all([
      post({ action: 'update', id: 'repo-pressure', storagePressureParkingDisabled: true }),
      childTouch,
    ]);
    expect(policyResponse.status).toBe(200);
    const stored = JSON.parse(readFileSync(path.join(dataDir, 'repos.json'), 'utf8')) as {
      repos: Array<{ storagePressureParkingDisabled?: boolean; lastOpenedAt?: string | null }>;
    };
    expect(stored.repos[0]).toMatchObject({
      storagePressureParkingDisabled: true,
      lastOpenedAt: '2026-08-15T00:00:00.000Z',
    });
  });

  it('observes another process opt-out through the destructive pressure boundary despite a warm cache', async ({ onTestFinished }) => {
    // Child startup must not age the parent's cached opt-in past its TTL.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    onTestFinished(() => clock.mockRestore());
    await post({ action: 'update', id: 'repo-pressure', storagePressureParkingDisabled: false });
    expect((await registry.listRepos())[0]?.storagePressureParkingDisabled).toBe(false);
    execFileSync(process.execPath, [
      './node_modules/vitest/vitest.mjs', 'run',
      'tests/fixtures/repo-pressure-policy-child.test.ts', '--reporter=dot',
    ], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_TEST_DATA_DIR_PINNED: dataDir,
        O8_TEST_REPO_POLICY_CHILD: '1',
      },
      stdio: 'pipe',
    });
    expect((await registry.listRepos())[0]?.storagePressureParkingDisabled).toBe(false);

    const heldReceipt = {
      schema: 'o8/packet-storage-admission/v1' as const,
      state: 'held' as const,
      reason: 'reserve_breached',
      reservationId: 'packet-storage:target:1',
      mutationId: 'packet-storage-reserve:target:1',
      ownerId: 'target',
      ownerGeneration: 1,
      estimateBytes: 100,
      estimateSource: 'source-size-fallback' as const,
      historySamples: 0,
      volumeId: 'device:test',
      physicalAvailableBytes: 100,
      reservedBeforeBytes: 0,
      requiredReserveBytes: 100,
      dispatchHeadroomBytes: 0,
      pressure: null,
      recordedAt: 1,
    };
    const base: PacketStorageAdmissionCoordinator = {
      reserveForLaunch: async () => { throw new PacketStorageAdmissionError('held', heldReceipt); },
      commitAfterLaunch: async () => heldReceipt,
      settleFailedLaunch: async () => heldReceipt,
    };
    const park = vi.fn();
    const coordinator = createStoragePressureAdmissionCoordinator(base, {
      mode: () => 'pressure',
      listLanes: () => [{
        id: 'lane-completed', packetId: 'completed', repoPath, worktreePath: repoPath,
        branch: 'inline/completed', baseBranch: 'main', runtime: 'codex', sessionKey: 'owned:completed',
        projectId: null, label: 'completed', prNumber: null, status: 'completed', ownership: 'managed',
        writerToken: null, lastHeartbeatAt: null, createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z', lastEventAt: null, lastEventLabel: null,
      }],
      measureAllocatedBytes: async () => 10,
      observeVolume: async (targetPath) => ({
        status: 'observed', targetPath, probePath: dataDir, volumeId: 'device:test',
        availableBytes: 100, freeBytes: 100, totalBytes: 1_000, observedAt: 1, error: null,
      }),
      getSnapshot: () => null,
      parkWorkspace: park,
    });

    await expect(coordinator.reserveForLaunch({
      id: 'target', workspaceTargetPath: repoPath,
    } as OrchestratorPacket)).rejects.toMatchObject({
      receipt: { pressure: { candidates: [{ reason: 'repository_opted_out' }] } },
    });
    expect(park).not.toHaveBeenCalled();
  });
});
