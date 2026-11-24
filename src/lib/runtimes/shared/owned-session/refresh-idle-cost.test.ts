import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getDataDir } from '@/lib/data-dir-migration';

// Wrap the real modules so the tests can count what an idle refresh pays for.
vi.mock('@/lib/orchestrator/workspace-lifecycle-lease', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/workspace-lifecycle-lease')>();
  return { ...actual, acquireWorkspaceLifecycleLease: vi.fn(actual.acquireWorkspaceLifecycleLease) };
});
vi.mock('./automatic-recovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./automatic-recovery')>();
  return { ...actual, recoveryPacketHoldReason: vi.fn(actual.recoveryPacketHoldReason) };
});

const { acquireWorkspaceLifecycleLease } = await import('@/lib/orchestrator/workspace-lifecycle-lease');
const { recoveryPacketHoldReason } = await import('./automatic-recovery');
const { cleanupWorkerO8Cli } = await import('./worker-o8-cli-cleanup');
const { createModelCompatibilityRecovery } = await import('./model-compatibility');
const { workerO8CliSlot } = await import('./worker-o8-cli-paths');
import type { OwnedSessionRecord } from './types';

function session(root: string, outcome: 'finished' | 'failed'): OwnedSessionRecord {
  const surfaceId = `codex-owned:codex-owned-${Math.random().toString(16).slice(2)}`;
  return {
    surfaceId,
    sessionDir: path.join(root, surfaceId.split(':')[1]!),
    packetId: 'pkt-refresh-idle-cost',
    model: 'fixture-model',
    recentRuns: [{ id: `run-${outcome}`, outcome, prompt: 'fixture' }],
  } as unknown as OwnedSessionRecord;
}

afterEach(() => { vi.mocked(acquireWorkspaceLifecycleLease).mockClear(); vi.mocked(recoveryPacketHoldReason).mockClear(); });

describe('an owned-session refresh at rest', () => {
  it('takes no lifecycle lease to clean worker CLI folders that do not exist, and still cleans one that does', async () => {
    const root = mkdtempSync(path.join(getDataDir(), 'owned-refresh-idle-'));
    const idle = session(root, 'finished');
    await expect(cleanupWorkerO8Cli(root, idle)).resolves.toBe(true);
    expect(acquireWorkspaceLifecycleLease).not.toHaveBeenCalled();

    // A folder to inspect sends cleanup through the locked path.
    const slot = workerO8CliSlot(idle.surfaceId);
    mkdirSync(slot, { recursive: true });
    writeFileSync(path.join(slot, 'owner.json'), JSON.stringify({ owner: 'someone-else' }));
    await cleanupWorkerO8Cli(root, idle);
    expect(acquireWorkspaceLifecycleLease).toHaveBeenCalled();
  });

  it('reads packet hold state for model-compatibility recovery only after a failed run', async () => {
    const root = mkdtempSync(path.join(getDataDir(), 'owned-refresh-compat-'));
    const recover = createModelCompatibilityRecovery({
      adapter: { modelCompatibilityFallback: () => null } as never,
      io: { findSession: async () => null } as never,
      withSurfaceLock: async (_surfaceId, fn) => fn(),
      readRunArtifacts: vi.fn() as never,
      spawnOwnedRun: vi.fn() as never,
    });
    await expect(recover(session(root, 'finished'))).resolves.toBe(false);
    expect(recoveryPacketHoldReason).not.toHaveBeenCalled();
    await expect(recover(session(root, 'failed'))).resolves.toBe(false);
    expect(recoveryPacketHoldReason).toHaveBeenCalledTimes(1);
  });
});
