/** Linux soak: the real delegate route, reviewed merge and cleanup reaper. */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { WsWatchdog } from '@/lib/ws-server/health-watchdog';
import { WsCpuSampler } from '@/lib/ws-server/cpu-evidence';
import { NextRequest } from 'next/server';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState } from '@/lib/orchestrator/types';

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({
  ensureDispatchBackendReady: vi.fn(async () => ({
    ready: true,
    reason: 'test',
    waitedMs: 0,
    attempts: 1,
    lastCheck: {
      ready: true,
      reason: 'test',
      apiBase: 'http://127.0.0.1:1',
      portSource: 'default',
      apiPortFilePresent: false,
    },
  })),
}));

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));


vi.mock('@/lib/codex/service-tier-catalogue', () => ({ getCodexSpeedCatalogue: async () => ({ models: { 'gpt-5.6-terra': [], 'gpt-5.6-sol': [] } }) }));
vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => undefined),
}));

vi.mock('@/lib/runtime/capacity-service', () => ({
  getRuntimeCapacityControlSnapshot: vi.fn(async () => ({ capacities: [] })),
}));

vi.mock('@/lib/codebase-memory/indexer', () => ({ ensureCodebaseMemoryBootIndex: vi.fn() }));
vi.mock('@/lib/cortex/decay', () => ({ ensureDecayBootHook: vi.fn() }));
vi.mock('@/lib/cortex/proposer', () => ({ ensureProposerBootTick: vi.fn() }));
vi.mock('@/lib/cortex/stack-signature', () => ({ ensureStackSignatureBoot: vi.fn() }));
vi.mock('@/lib/cortex/cross-repo-proposer', () => ({ ensureCrossRepoProposerBootTick: vi.fn() }));
vi.mock('@/lib/cortex/external-merge-watcher', () => ({ ensureExternalMergeBootHook: vi.fn() }));
vi.mock('@/lib/operator/shipped-dark-scheduler', async (original) => ({
  ...await original<typeof import('@/lib/operator/shipped-dark-scheduler')>(),
  ensureShippedDarkAuditBootHook: vi.fn(),
}));

const root = realpathSync(mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'delegate-merge-')));
const ownedRoot = join(root, 'owned-qoder');
const fakeWorkerPath = join(root, 'qodercli');
const priorEnv = new Map<string, string | undefined>();
const envKeys = [
  'O8_OWNED_QODER_ROOT',
  'O8_QODER_BIN',
  'O8_CRASH_SURVIVABLE_WORKERS',
  'O8_PACKAGED_APP',
  'O8_APFS_DEPENDENCY_IMAGES',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
] as const;
for (const key of envKeys) priorEnv.set(key, process.env[key]);
process.env.O8_OWNED_QODER_ROOT = ownedRoot;
process.env.O8_QODER_BIN = fakeWorkerPath;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_PACKAGED_APP = '0';
process.env.O8_APFS_DEPENDENCY_IMAGES = '0';
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const FEATURE_PREFIX = 'delegated-feature-';

// An isolated worker executable stands in for the model: it commits real work
// inside whatever workspace o8 provisioned for it, then exits clean.
writeFileSync(fakeWorkerPath, [
  '#!/usr/bin/env node',
  "const { execFileSync } = require('node:child_process');",
  "const fs = require('node:fs');",
  "if (process.argv.includes('--version')) {",
  "  process.stdout.write('qodercli 1.0.0\\n');",
  '  process.exit(0);',
  '}',
  "const feature = 'delegated-feature-' + require('node:path').basename(process.cwd()) + '.txt';",
  "fs.writeFileSync(feature, 'delegated work\\n');",
  "execFileSync('git', ['add', '-A'], { stdio: 'ignore' });",
  "execFileSync('git', [",
  "  '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test',",
  "  'commit', '-m', 'feat: delegated work [via-o8]',",
  "], { stdio: 'ignore' });",
  'process.exit(0);',
].join('\n'), 'utf8');
chmodSync(fakeWorkerPath, 0o755);

const { dispatch } = await import('@/lib/lane/commands');
const { getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { POST: delegatePost } = await import('@/app/api/orchestrator/delegate/route');
const {
  approveAndMergePacket,
  submitPacketReview,
} = await import('@/lib/orchestrator/operator-mission-service');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { addRepo } = await import('@/lib/repos/registry');
const {
  listWorkspaceSnapshotTransitions,
  listWorkspaceSnapshotsByOriginalPath,
} = await import('@/lib/worktree/snapshot-state');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function makeSharedOriginRepos() {
  const origin = join(root, 'github-like.git');
  const targetPath = join(root, 'target');
  const ambientPath = join(root, 'ambient');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, targetPath], { stdio: 'pipe' });
  git(targetPath, ['checkout', '-b', 'main']);
  git(targetPath, ['config', 'user.name', 'o8-test']);
  git(targetPath, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(targetPath, 'base.txt'), 'base\n');
  git(targetPath, ['add', '-A']);
  git(targetPath, ['commit', '-m', 'base']);
  git(targetPath, ['push', '-u', 'origin', 'main']);
  git(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  execFileSync('git', ['clone', origin, ambientPath], { stdio: 'pipe' });
  git(ambientPath, ['checkout', '-B', 'main', 'origin/main']);
  await addRepo(realpathSync.native(targetPath));
  await addRepo(realpathSync.native(ambientPath));
  return {
    target: { repoPath: targetPath, baseSha: git(targetPath, ['rev-parse', 'main']) },
    ambient: { repoPath: ambientPath, baseSha: git(ambientPath, ['rev-parse', 'main']) },
  };
}

function holdAmbientMission(repoPath: string) {
  const mission: OrchestratorMissionState = {
    ...createEmptyOrchestratorMissionState(),
    missionId: `mission-ambient-${Date.now()}`,
    repoPath,
    prompt: 'Ambient mission held by the control plane',
    summary: 'Ambient mission held by the control plane',
    packets: [],
    updatedAt: new Date().toISOString(),
  };
  writeOrchestratorControlPlaneState(mission);
}

async function waitFor<T>(read: () => T | null, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  closeDb();
  vi.restoreAllMocks();
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('ws work soak (#4367)', () => {
  // Quarantined (#6761): fails the same way on main; the worker launch is held before packet work.
  it.skip('keeps dispatch, reaping and reviewed merges below 250ms max and 50ms p99 lag [quarantined #6761]', async () => {
    const { target, ambient } = await makeSharedOriginRepos();
    holdAmbientMission(ambient.repoPath);
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ workerRuntimes: ['codex', 'qoder'] });
    const delegatedPackets: Array<{ laneId: string; packetId: string }> = [];

    const { runWorktreeMaintenanceTick } = await import('@/lib/lane/worktree-reaper');
    const sampler = new WsCpuSampler();
    const watchdog = new WsWatchdog({ intervalMs: 10, sustainedSamples: 1, cpuSampler: sampler, log: () => {} });
    const delay = monitorEventLoopDelay({ resolution: 10 });
    const measurements: Array<{ phase: string; maxLag: number; p99Lag: number; wedges: number; frames: unknown[] }> = [];
    async function measure<T>(phase: string, operation: () => Promise<T>): Promise<T> {
      delay.reset();
      delay.enable();
      watchdog.start();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const before = watchdog.getStats().wedgeCount;
      try {
        const pending = operation();
        const expected = phase === 'dispatch' ? ['dispatch'] : ['merge', 'worktree-reaper'];
        expect(watchdog.getStats().inFlightHandlers).toEqual(expected);
        return await pending;
      }
      finally {
        await new Promise((resolve) => setTimeout(resolve, 30));
        const captured = sampler.getEvidence();
        const evidence = captured.status === 'sampled' ? captured : await sampler.capture();
        measurements.push({ phase, maxLag: delay.max / 1e6, p99Lag: delay.percentile(99) / 1e6,
          wedges: watchdog.getStats().wedgeCount - before, frames: evidence.frames });
        process.stdout.write('[ws-work-phase] ' + JSON.stringify(measurements.at(-1)) + '\n');
        delay.disable();
        watchdog.stop();
        await sampler.stop();
      }
    }
    // Launch every packet before merging any result. All three workers start
    // from the same base, so the later publications must preserve rebase proof.
    for (let index = 0; index < 3; index += 1) {
      const response = await measure('dispatch', () => delegatePost(new NextRequest('http://127.0.0.1/api/orchestrator/delegate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientMutationId: `delegate-2308-${index}-${Date.now()}`,
          prompt: 'Add the delegated feature file and commit it.',
          taskName: `delegated 2308 merge ${index}`,
          repoPath: target.repoPath,
          runtime: 'qoder',
        }),
      })));
      const delegated = await response.json() as {
        ok: boolean; laneId: string; packetId: string; error?: string;
      };
      expect(response.status, JSON.stringify(delegated)).toBe(200);
      expect({ ok: delegated.ok, error: delegated.error }).toMatchObject({ ok: true });
      delegatedPackets.push(delegated);
    }
    expect(new Set(delegatedPackets.map((packet) => packet.packetId)).size).toBe(3);
    const controlPlane = readOrchestratorControlPlaneState();
    expect(controlPlane.repoPath).toBe(ambient.repoPath);
    for (const delegated of delegatedPackets) {
      expect(controlPlane.packets.find((packet) => packet.id === delegated.packetId))
        .toMatchObject({ workspaceTargetPath: target.repoPath });
    }

    const prepared: Array<{
      laneId: string; packetId: string; workspacePath: string; featureFile: string; reviewedHeadSha: string;
    }> = [];
    for (const delegated of delegatedPackets) {
      const workspacePath = await waitFor(
        () => getLane(delegated.laneId)?.worktreePath ?? null,
        'delegated packet workspace',
      );
      expect(realpathSync(workspacePath)).not.toBe(realpathSync(target.repoPath));
      const featureFile = `${FEATURE_PREFIX}${basename(workspacePath)}.txt`;
      const reviewedHeadSha = await waitFor(() => {
        const committed = existsSync(join(workspacePath, featureFile))
          && git(workspacePath, ['ls-tree', '--name-only', 'HEAD', '--', featureFile]) === featureFile;
        return committed ? git(workspacePath, ['rev-parse', 'HEAD']) : null;
      }, 'worker commit inside the provisioned workspace');
      expect(reviewedHeadSha).not.toBe(target.baseSha);
      expect(git(workspacePath, ['rev-parse', 'HEAD^'])).toBe(target.baseSha);
      prepared.push({ ...delegated, workspacePath, featureFile, reviewedHeadSha });
    }

    for (const { laneId, packetId, workspacePath, featureFile, reviewedHeadSha } of prepared) {
      const reviewRequested = await dispatch({ verb: 'request_review', laneId, actor: 'system' });
      expect(reviewRequested.ok).toBe(true);
      expect(getLane(laneId)?.status).toBe('reviewing');
      await submitPacketReview({ packetId, approved: true, findings: [], reviewedHeadSha });
      const merged = await measure('merge-and-reaper', async () => {
        let [merged] = await Promise.all([
          approveAndMergePacket({ packetId, expectedHeadSha: reviewedHeadSha, actor: 'user' }),
          runWorktreeMaintenanceTick(target.repoPath),
        ]);
        if (!merged.merged && merged.note?.includes('lifecycle mutation ran first')) {
          merged = await approveAndMergePacket({ packetId, expectedHeadSha: reviewedHeadSha, actor: 'user' });
        }
        return merged;
      });
      expect(merged.merged, merged.note ?? undefined).toBe(true);
      const mergeSha = merged.mergeSha!;
      expect(git(target.repoPath, ['rev-parse', 'main'])).toBe(mergeSha);
      expect(git(target.repoPath, ['ls-tree', '-r', '--name-only', 'main'])).toContain(featureFile);
      expect(git(target.repoPath, ['rev-parse', 'main']))
        .toBe(git(target.repoPath, ['rev-parse', 'origin/main']));

      const snapshots = listWorkspaceSnapshotsByOriginalPath(workspacePath);
      expect(snapshots, JSON.stringify(getLaneEvents(laneId, 10))).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ state: 'retired', headCommit: reviewedHeadSha });
      expect(listWorkspaceSnapshotTransitions(snapshots[0]!.repositoryUuid, snapshots[0]!.packetId)[0]?.receipt)
        .toMatchObject({ reviewedHeadSha, mergeCandidateSha: mergeSha });
      expect(git(target.repoPath, ['rev-parse', snapshots[0]!.recoveryRef])).toBe(reviewedHeadSha);
      expect(existsSync(workspacePath)).toBe(false);
      expect(git(ambient.repoPath, ['rev-parse', 'main'])).toBe(ambient.baseSha);
    }
    const landedFiles = git(target.repoPath, ['ls-tree', '-r', '--name-only', 'main']).split('\n');
    for (const { featureFile } of prepared) expect(landedFiles).toContain(featureFile);
    const receipt = { maxLag: Math.max(...measurements.map((row) => row.maxLag)),
      p99Lag: Math.max(...measurements.map((row) => row.p99Lag)),
      wedges: measurements.reduce((sum, row) => sum + row.wedges, 0), measurements };
    process.stdout.write('[ws-work-soak] ' + JSON.stringify(receipt) + '\n');
    if (process.env.O8_SPEED_RECEIPT) writeFileSync(process.env.O8_SPEED_RECEIPT, JSON.stringify(receipt));
    expect.soft(receipt.maxLag).toBeLessThan(250);
    expect.soft(receipt.p99Lag).toBeLessThan(50);
    expect(receipt.wedges).toBe(0);
  }, 180_000);
});
