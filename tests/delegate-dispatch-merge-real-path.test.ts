/**
 * #2308 — real dispatch → review → merge for a delegated packet.
 *
 * The sibling regression (`packet-merge-repository-identity-real-path.test.ts`)
 * proves the merge identity seam against persisted state. This case closes the
 * issue's acceptance wording by driving the REAL `/api/orchestrator/delegate`
 * route: it synthesizes the packet into the live control plane, opens the lane,
 * provisions the managed worktree, and launches an isolated fake worker
 * executable (no model call). The worker commits inside its own workspace, the
 * lane requests review through the normal command, the review is submitted, and
 * `approveAndMergePacket` publishes.
 *
 * The control plane is holding a mission for a DIFFERENT registered repository
 * when the delegation lands — the production shape, because the delegate route
 * only sets `current.repoPath` when it is still unset. The delegated packet must
 * still merge into its own repository, and the ambient repository must not move.
 *
 * #3565 reuses this launch fixture with a large skeleton cache, CPU profiling,
 * event-loop monitoring, and concurrent requests to the real health handler.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Session } from 'node:inspector';
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

vi.mock('@/lib/analytics/server', () => ({
  emitProductEvent: vi.fn(async () => undefined),
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
// Source mode: only O8_PACKAGED_APP=1 marks a packaged app, and the worker CLI (#4800) treats any value as packaged.
delete process.env.O8_PACKAGED_APP;
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

describe('#2308 delegated dispatch merges into the repository it was dispatched into', () => {
  it('dispatches three workers through the delegate route and lands all three reviewed commits', async () => {
    const { target, ambient } = await makeSharedOriginRepos();
    holdAmbientMission(ambient.repoPath);
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ workerRuntimes: ['codex', 'qoder'] });
    const delegatedPackets: Array<{ laneId: string; packetId: string }> = [];

    // Launch every packet before merging any result. All three workers start
    // from the same base, so the later publications must preserve rebase proof.
    for (let index = 0; index < 3; index += 1) {
      const response = await delegatePost(new NextRequest('http://127.0.0.1/api/orchestrator/delegate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientMutationId: `delegate-2308-${index}-${Date.now()}`,
          prompt: 'Add the delegated feature file and commit it.',
          taskName: `delegated 2308 merge ${index}`,
          repoPath: target.repoPath,
          runtime: 'qoder',
        }),
      }));
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
          && git(workspacePath, ['status', '--porcelain']) === '';
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
      const merged = await approveAndMergePacket({ packetId, expectedHeadSha: reviewedHeadSha, actor: 'user' });
      expect({ merged: merged.merged, note: merged.note }).toMatchObject({ merged: true });
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
  }, 180_000);
});

describe('isolated dispatch event loop (#3565)', () => {
  it('keeps isolated dispatch responsive to concurrent health requests (#3565)', async () => {
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({ workerRuntimes: ['codex', 'qoder'] });
    const repoPath = join(root, 'loop-repo');
    mkdirSync(repoPath);
    git(repoPath, ['init', '-qb', 'main']);
    git(repoPath, ['config', 'user.name', 'o8-test']);
    git(repoPath, ['config', 'user.email', 'o8@example.test']);
    writeFileSync(join(repoPath, 'base.txt'), 'base\n');
    writeFileSync(join(repoPath, 'target.ts'), 'export const target = 1;\n');
    writeFileSync(join(repoPath, 'source-0.ts'), "import { target } from './target';\nif (!target) throw new Error('missing target');\n");
    git(repoPath, ['add', '.']);
    git(repoPath, ['commit', '-qm', 'base']);
    const origin = join(root, 'loop-origin.git');
    git(repoPath, ['clone', '--bare', repoPath, origin]);
    git(repoPath, ['remote', 'add', 'origin', origin]);
    await addRepo(repoPath);
    const { GET: healthGet } = await import('@/app/api/panel/status/route');
    await healthGet();
    const { upsertBatch } = await import('@/lib/skeleton/store');
    const symbols = Array.from({ length: 200 }, (_, index) => ({
      name: `function${index}`, kind: 'function' as const, line: index + 1,
      signature: `export function function${index}(value: ${'LongInputTypeName'.repeat(8)}): string`,
      exported: true,
    }));
    // Match the scanner's 2,000-file ceiling with ordinary, symbol-rich files.
    // The launch only needs their paths; decoding all symbol JSON blocks it.
    upsertBatch(repoPath, [...Array.from({ length: 1999 }, (_, index) => ({
      relativePath: `source-${index}.ts`, language: 'typescript' as const,
      symbols, imports: ['./target'], lineCount: 200, contentHash: 'fixture',
    })), {
      relativePath: 'target.ts', language: 'typescript', symbols,
      imports: [], lineCount: 1, contentHash: 'target',
    }]);
    const profile = new Session();
    profile.connect();
    await new Promise<void>((resolve, reject) => profile.post('Profiler.enable', (error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => profile.post('Profiler.start', (error) => error ? reject(error) : resolve()));
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    await new Promise((resolve) => setTimeout(resolve, 30));
    let maxHealthMs = 0;
    let healthRequests = 0;
    const pending: Promise<void>[] = [];
    // Include time queued behind dispatch, not just time inside the handler.
    let due = performance.now() + 10;
    const timer = setInterval(() => {
      const started = due;
      due = performance.now() + 10;
      pending.push(healthGet().then((response) => {
        expect(response.status).toBe(200);
        maxHealthMs = Math.max(maxHealthMs, performance.now() - started);
        healthRequests += 1;
      }));
    }, 10);
    let response: Response;
    try {
      response = await delegatePost(new NextRequest('http://127.0.0.1/api/orchestrator/delegate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientMutationId: 'delegate-loop-3565', repoPath,
          runtime: 'qoder', prompt: 'Update target.ts and commit it.', taskName: 'dispatch loop' }),
      }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      clearInterval(timer);
      await Promise.all(pending);
      delay.disable();
      await new Promise<void>((resolve) => profile.post('Profiler.stop', (error, result) => {
        if (!error) {
          const nodes = new Map(result.profile.nodes.map((node) => [node.id, node]));
          const parents = new Map(result.profile.nodes.flatMap((node) => (node.children ?? []).map((child) => [child, node.id] as const)));
          const samples = new Map<number, number>();
          for (let i = 0; i < (result.profile.samples?.length ?? 0); i += 1) {
            const id = result.profile.samples![i];
            samples.set(id, (samples.get(id) ?? 0) + (result.profile.timeDeltas?.[i] ?? 0));
          }
          for (const [id, micros] of [...samples].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
            const stack: string[] = [];
            let cursor: number | undefined = id;
            while (cursor !== undefined && stack.length < 10) {
              stack.push(nodes.get(cursor)?.callFrame.functionName || '(anonymous)');
              cursor = parents.get(cursor);
            }
            process.stdout.write(`[dispatch-profile] ${(micros / 1000).toFixed(1)} ms: ${stack.join(' <- ')}\n`);
          }
        }
        resolve();
      }));
      profile.disconnect();
    }
    process.stdout.write(`[dispatch-loop] max delay=${(delay.max / 1e6).toFixed(1)} ms; max health=${maxHealthMs.toFixed(1)} ms; health requests=${healthRequests}\n`);
    const delegated = await response.json() as { ok: boolean; laneId: string; packetId: string };
    expect(response.status, JSON.stringify(delegated)).toBe(200);
    expect(delegated.ok).toBe(true);
    const lane = getLane(delegated.laneId);
    expect(lane?.worktreePath).toBeTruthy();
    expect(lane?.worktreePath).not.toBe(repoPath);
    const packet = readOrchestratorControlPlaneState().packets.find((candidate) => candidate.id === delegated.packetId);
    expect(packet?.predictedFiles).toEqual(['target.ts']);
    expect(packet?.edgeCaseSites).toContainEqual(expect.objectContaining({
      location: 'source-0.ts:2', kind: 'error-handler',
    }));
    expect(healthRequests).toBeGreaterThan(0);
    expect.soft(delay.max / 1e6).toBeLessThan(100);
    expect.soft(maxHealthMs).toBeLessThan(200);
  }, 180_000);
});
