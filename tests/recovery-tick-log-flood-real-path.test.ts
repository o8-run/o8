/**
 * #2048 — the headless recovery tick must not flood serve.log.
 *
 * Both cases drive the REAL entry point (`runDispatchTick` with the boot
 * recovery guard on) against PERSISTED control-plane state, because the guard
 * and the git probe were each already covered in isolation while the flood ran
 * for 27 hours (38,008 lines) in production:
 *
 *   A. A decompose packet with no pinned runtime is skipped on every tick. The
 *      skip must be LOGGED once, not once per tick. Two real ticks, one line.
 *
 *   B. A packet whose workspace target no longer exists must not spawn git at
 *      all — `execFileSync` inherits the parent's stderr, so every miss printed
 *      a bare `fatal: not a git repository` with nothing naming the caller.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const gitCalls = vi.hoisted(() => [] as string[][]);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    default: actual,
    execFileSync: ((file: string, args?: readonly string[], options?: unknown) => {
      if (file === 'git') gitCalls.push([...(args ?? [])]);
      return (actual.execFileSync as unknown as (...a: unknown[]) => unknown)(file, args, options);
    }) as typeof actual.execFileSync,
  };
});

const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
const { resetRecoverySkipMemo } = await import('@/lib/orchestrator/recovery-skip-log');
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const testRoot = mkdtempSync(join(tmpdir(), 'o8-recovery-log-flood-'));
const repoPath = join(testRoot, 'repo');
const missingRepoPath = join(testRoot, 'repo-that-was-deleted');

beforeAll(() => {
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), 'recovery tick flood\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['-c', 'user.email=test@o8.local', '-c', 'user.name=o8-test', 'commit', '-m', 'init'], {
    cwd: repoPath,
  });
  gitCalls.length = 0;
});

beforeEach(() => {
  resetRecoverySkipMemo();
  gitCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function persistPacket(packet: OrchestratorPacket): OrchestratorMissionState {
  const state = createEmptyOrchestratorMissionState();
  return writeOrchestratorControlPlaneState({ ...state, packets: [packet] });
}

function decomposePacket(overrides: Partial<OrchestratorPacket> = {}): OrchestratorPacket {
  return {
    id: 'decompose-2048-stale',
    referenceLabel: 'PKT-DECOMPOSE-2048',
    title: 'decompose stale work',
    summary: 'decompose stale work',
    workspaceTargetPath: repoPath,
    branchTarget: 'issue/2048-decompose',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    blockedReason: null,
    lane: null,
    ...overrides,
  };
}

async function tickPersistedState(): Promise<string[]> {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  });
  try {
    // Read back from disk each tick — the daemon does exactly this, so the
    // memo cannot be smuggled in on the in-memory packet object.
    const persisted = readOrchestratorControlPlaneState();
    const dispatched = await runDispatchTick(persisted, {
      enforceBootRecoveryGuard: true,
      missionArchived: false,
    });
    writeOrchestratorControlPlaneState(dispatched);
  } finally {
    spy.mockRestore();
  }
  return logs;
}

describe('#2048 headless recovery tick logging', () => {
  it('logs an unpinned decompose packet skip once across two real ticks', async () => {
    persistPacket(decomposePacket({ dispatchRuntimePin: null }));

    const firstTick = await tickPersistedState();
    const secondTick = await tickPersistedState();

    const skipLines = [...firstTick, ...secondTick].filter((line) => line.includes('runtime is not pinned'));
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]).toContain('decompose-2048-stale');
    // The second tick still skipped the packet — it just stayed quiet.
    expect(secondTick.some((line) => line.includes('runtime is not pinned'))).toBe(false);
  });

  it('logs again once the packet stops being blocked on an unpinned runtime', async () => {
    persistPacket(decomposePacket({ dispatchRuntimePin: null }));
    const firstTick = await tickPersistedState();
    expect(firstTick.filter((line) => line.includes('runtime is not pinned'))).toHaveLength(1);

    // Operator pins a runtime, then the packet is archived — a different
    // blocker, so the memo must not swallow it.
    persistPacket(decomposePacket({
      dispatchRuntimePin: 'codex',
      archivedAt: new Date().toISOString(),
    }));
    const secondTick = await tickPersistedState();

    const skipLines = secondTick.filter((line) => line.includes('[recovery] Packet decompose-2048-stale skipped'));
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]).toContain('mission is not live');
  });

  it('keeps a skip logged once when the tick also dispatches another mission', async () => {
    // The headless tick dispatches the current mission, then each registry
    // mission. Each pass used to prune the memo to its own packets, so every
    // full tick printed the other mission's skips again.
    const current = { ...createEmptyOrchestratorMissionState(), missionId: 'mission-current',
      packets: [decomposePacket({ id: 'decompose-current', dispatchRuntimePin: null })] };
    const registry = { ...createEmptyOrchestratorMissionState(), missionId: 'mission-registry',
      packets: [decomposePacket({ id: 'decompose-registry', dispatchRuntimePin: null })] };
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '));
    });
    try {
      for (let tick = 0; tick < 3; tick++) {
        for (const mission of [current, registry]) {
          await runDispatchTick(mission, { enforceBootRecoveryGuard: true, missionArchived: false });
        }
      }
    } finally {
      spy.mockRestore();
    }
    const skips = logs.filter((line) => line.includes('runtime is not pinned'));
    expect(skips.filter((line) => line.includes('decompose-current'))).toHaveLength(1);
    expect(skips.filter((line) => line.includes('decompose-registry'))).toHaveLength(1);
  });

  it('spawns no git process for a workspace target that no longer exists', async () => {
    persistPacket(decomposePacket({
      id: 'decompose-2048-missing-repo',
      workspaceTargetPath: missingRepoPath,
      dispatchRuntimePin: 'codex',
    }));

    const logs = await tickPersistedState();

    const probedMissingPath = gitCalls.some((args) => args.includes(missingRepoPath));
    expect(probedMissingPath).toBe(false);
    expect(logs.some((line) => line.includes('fatal:'))).toBe(false);
  });
});
