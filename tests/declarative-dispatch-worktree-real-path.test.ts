import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { NextRequest } from 'next/server';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { declarativeLaunchDeadlineTest } from './fixtures/declarative-launch-deadline';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const queueProbe = vi.hoisted(() => ({ entered: 0 }));
const artifactRace = vi.hoisted(() => ({ file: '', accounting: false, injected: false, continuous: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      const directory = await actual.opendir(...args);
      // Artifact accounting enumerates this directory; ownership validation
      // can stat the same file before that traversal starts.
      if (artifactRace.file && String(args[0]) === dirname(artifactRace.file)) {
        artifactRace.accounting = true;
      }
      return directory;
    },
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const stat = await actual.lstat(...args);
      if (artifactRace.accounting && String(args[0]) === artifactRace.file) {
        artifactRace.accounting = false;
        if (!artifactRace.injected || artifactRace.continuous) {
          // Change the measured file after its snapshot, before verification.
          await actual.appendFile(artifactRace.file, 'writer update\n');
          artifactRace.injected = true;
        }
      }
      return stat;
    },
  };
});

const readinessBoundary = vi.hoisted(() => ({ real: false }));

const worktreeFailure = vi.hoisted(() => ({
  enabled: false,
  message: 'synthetic packet worktree provision failure',
}));

const provisioningRace = vi.hoisted(() => ({
  enabled: false,
  promptEntered: false,
  releasePrompt: false,
  provisioningEntered: false,
  releaseProvisioning: false,
}));

vi.mock('@/lib/orchestrator/packet-prompt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/packet-prompt')>();
  return {
    ...actual,
    buildPacketPrompt: async (...args: Parameters<typeof actual.buildPacketPrompt>) => {
      if (provisioningRace.enabled) {
        provisioningRace.promptEntered = true;
        while (!provisioningRace.releasePrompt) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      return actual.buildPacketPrompt(...args);
    },
  };
});

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

vi.mock('@/lib/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree')>();
  return {
    ...actual,
    prepareLaunchWorktree: async (
      options: Parameters<typeof actual.prepareLaunchWorktree>[0],
    ) => {
      queueProbe.entered += 1;
      if (provisioningRace.enabled) {
        provisioningRace.provisioningEntered = true;
        while (!provisioningRace.releaseProvisioning) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error(worktreeFailure.message);
      }
      if (worktreeFailure.enabled) {
        throw new Error(worktreeFailure.message);
      }
      return actual.prepareLaunchWorktree(options);
    },
  };
});

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

vi.mock('@/lib/runtimes/shared/dispatch-readiness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/shared/dispatch-readiness')>();
  return {
    ...actual,
    ensureDispatchBackendReady: vi.fn(async (...args: Parameters<typeof actual.ensureDispatchBackendReady>) => (
      readinessBoundary.real ? actual.ensureDispatchBackendReady(...args) : {
        ready: true, reason: 'test', waitedMs: 0, attempts: 1,
        lastCheck: { ready: true, reason: 'test', apiBase: 'http://127.0.0.1:1',
          portSource: 'default', apiPortFilePresent: false },
      }
    )),
  };
});

vi.mock('@/lib/analytics/server', () => ({
  emitProductEvent: vi.fn(async () => undefined),
}));

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => undefined),
}));

const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'declarative-dispatch-real-path-'));
const dataDir = join(root, 'data');
const ownedRoot = join(root, 'owned-qoder');
const capturePath = join(root, 'qoder-spawns.jsonl');
const fakeQoderPath = join(root, 'qodercli');
const priorEnv = new Map<string, string | undefined>();
const envKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'O8_OWNED_QODER_ROOT',
  'O8_QODER_BIN',
  'O8_FAKE_QODER_CAPTURE',
  'O8_CRASH_SURVIVABLE_WORKERS',
  'O8_PACKAGED_APP',
  'O8_APFS_DEPENDENCY_IMAGES',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
] as const;

for (const key of envKeys) priorEnv.set(key, process.env[key]);
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_OWNED_QODER_ROOT = ownedRoot;
process.env.O8_QODER_BIN = fakeQoderPath;
process.env.O8_FAKE_QODER_CAPTURE = capturePath;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_PACKAGED_APP = '0';
process.env.O8_APFS_DEPENDENCY_IMAGES = '0';
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

writeFileSync(
  fakeQoderPath,
  [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "if (process.argv.includes('--version')) {",
    "  process.stdout.write('qodercli 1.0.0\\n');",
    '  process.exit(0);',
    '}',
    'fs.appendFileSync(',
    `  ${JSON.stringify(capturePath)},`,
    "  `${JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) })}\\n`,",
    ');',
    "process.stderr.write('fake qoder fatal exit\\n');",
    'setTimeout(() => process.exit(23), 25);',
  ].join('\n'),
  'utf8',
);
chmodSync(fakeQoderPath, 0o755);

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function createRemoteBackedRepo(): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const origin = join(root, `origin-${suffix}.git`);
  const seed = join(root, `seed-${suffix}`);
  const repo = join(root, `repo-${suffix}`);
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, seed], { stdio: 'pipe' });
  git(seed, 'checkout', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), 'declarative dispatch test\n', 'utf8');
  git(seed, 'add', 'README.md');
  git(seed, '-c', 'user.name=o8 test', '-c', 'user.email=o8@test.invalid', 'commit', '-m', 'init');
  git(seed, 'push', '-u', 'origin', 'main');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  return repo;
}

function createDependencyRemoteBackedRepo(removeGateBinary: boolean): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  const origin = join(root, `dependency-origin-${suffix}.git`);
  const seed = join(root, `dependency-seed-${suffix}`);
  const repo = join(root, `dependency-repo-${suffix}`);
  const packageRoot = join(seed, 'gate-cli');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, seed], { stdio: 'pipe' });
  git(seed, 'checkout', '-b', 'main');
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'gate-cli',
    version: '1.0.0',
    bin: { 'gate-check': 'index.js' },
  }), 'utf8');
  writeFileSync(join(packageRoot, 'index.js'), '#!/usr/bin/env node\nprocess.exit(0);\n', 'utf8');
  chmodSync(join(packageRoot, 'index.js'), 0o755);
  writeFileSync(join(seed, '.gitignore'), 'node_modules/\n', 'utf8');
  writeFileSync(join(seed, 'package.json'), JSON.stringify({
    name: 'dependency-dispatch-fixture',
    version: '1.0.0',
    private: true,
    scripts: {
      lint: 'gate-check',
      ...(removeGateBinary ? {
        postinstall: "node -e \"require('node:fs').rmSync('node_modules/.bin/gate-check',{force:true})\"",
      } : {}),
    },
    devDependencies: {
      'gate-cli': 'file:gate-cli',
    },
  }), 'utf8');
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], {
    cwd: seed,
    stdio: 'pipe',
  });
  git(seed, 'add', '.gitignore', 'package.json', 'package-lock.json', 'gate-cli');
  git(seed, '-c', 'user.name=o8 test', '-c', 'user.email=o8@test.invalid', 'commit', '-m', 'init');
  git(seed, 'push', '-u', 'origin', 'main');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  return repo;
}

function packet(repoPath: string, id: string): OrchestratorPacket {
  return {
    id,
    referenceLabel: id.toUpperCase(),
    title: `packet ${id}`,
    summary: `exercise declarative dispatch ${id}`,
    workspaceTargetPath: repoPath,
    branchTarget: `packet/${id}`,
    runtime: 'qoder',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    blockedReason: null,
    lane: null,
    review: null,
    workerRouting: {
      requestedRuntime: 'qoder',
    } as OrchestratorPacket['workerRouting'],
  };
}

async function mission(repoPath: string, target: OrchestratorPacket): Promise<OrchestratorMissionState> {
  const state = {
    missionId: `mission-${target.id}`,
    repoPath,
    packets: [target],
    updatedAt: new Date().toISOString(),
  } as OrchestratorMissionState;
  const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  writeOrchestratorControlPlaneState(state);
  return state;
}

async function waitFor<T>(
  read: () => T | null,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

describe('declarative packet dispatch worktree reachability', () => {
  declarativeLaunchDeadlineTest({ repo: createRemoteBackedRepo, packet, mission, capturePath });
  beforeEach(() => {
    readinessBoundary.real = false;
    worktreeFailure.enabled = false;
    provisioningRace.enabled = false;
    provisioningRace.promptEntered = false;
    provisioningRace.releasePrompt = false;
    provisioningRace.provisioningEntered = false;
    provisioningRace.releaseProvisioning = false;
  });

  afterAll(async () => {
    const { closeDb } = await import('@/lib/db');
    closeDb();
    vi.unstubAllGlobals();
    for (const [key, value] of priorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('spawns in the packet worktree, reports process death, and blocks when provisioning fails', async () => {
    readinessBoundary.real = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const repoPath = createRemoteBackedRepo();
    await import('@/lib/repos/registry').then(({ addRepo }) => addRepo(repoPath));
    const [{ runDispatchTick }, laneRegistry] = await Promise.all([
      import('@/lib/orchestrator/scheduling'),
      import('@/lib/lane/registry'),
    ]);

    const successId = 'pkt-declarative-cwd';
    const launched = await runDispatchTick(await mission(repoPath, packet(repoPath, successId)), {
      launchBudget: { maxLaunches: 1 },
    });
    const launchedPacket = launched.packets[0];
    const launchedLane = laneRegistry.findLaneByPacket(successId);
    expect(launchedPacket.status, launchedPacket.blockedReason ?? undefined).toBe('launching');

    const spawn = await waitFor(() => {
      if (!existsSync(capturePath)) return null;
      const line = readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean)
        .find(row => realpathSync(JSON.parse(row).cwd) === realpathSync(launchedLane!.worktreePath!));
      return line ? JSON.parse(line) as { cwd: string; argv: string[] } : null;
    }, 'fake qoder spawn');
    expect(realpathSync(spawn.cwd)).not.toBe(realpathSync(repoPath));
    expect(launchedLane?.worktreePath).toBeTruthy();
    expect(laneRegistry.getLaneEvents(launchedLane!.id, 200)
      .filter((event) => event.verb === 'runtime_launch_step' && event.payload.step === 'backend_readiness').map((event) => event.payload.phase))
      .toEqual(['started', 'completed']);
    expect(launchedPacket.lane?.worktreePath).toBe(launchedLane?.worktreePath);
    const worktreePath = realpathSync(launchedLane!.worktreePath!);
    expect(realpathSync(spawn.cwd)).toBe(worktreePath);
    expect(worktreePath).not.toBe(realpathSync(repoPath));
    expect(worktreePath).toContain(`${sep}.cortex-worktrees${sep}packet-${successId}`);

    const exitEvent = await waitFor(() => {
      const event = laneRegistry.getLaneEvents(launchedLane!.id, 200)
        .find((candidate) => candidate.verb === 'runtime_process_exit');
      return event ?? null;
    }, 'runtime_process_exit lane event');
    expect(exitEvent.payload).toMatchObject({
      runtime: 'qoder',
      exitCode: 23,
      signal: null,
      classification: 'nonzero-exit',
      completedTurn: false,
    });
    expect(exitEvent.payload.stderr).toContain('fake qoder fatal exit');

    const captureBeforeFailure = readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean);
    worktreeFailure.enabled = true;
    const failureId = 'pkt-declarative-worktree-failure';
    const blocked = await runDispatchTick(await mission(repoPath, packet(repoPath, failureId)), {
      launchBudget: { maxLaunches: 1 },
    });
    const blockedPacket = blocked.packets[0];
    const blockedLane = laneRegistry.findLatestLaneByPacket(failureId);
    expect(blockedPacket.status).toBe('blocked');
    expect(blockedPacket.blockedReason).toContain('packet_worktree_provision_failed');
    expect(blockedPacket.blockedReason).toContain(worktreeFailure.message);
    expect(blockedLane?.status).toBe('failed');
    expect(laneRegistry.getLaneEvents(blockedLane!.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'worktree_provision_failed',
        payload: expect.objectContaining({
          code: 'packet_worktree_provision_failed',
          runtime: 'qoder',
          packetId: failureId,
        }),
      }),
    ]));
    const captureAfterFailure = readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean);
    expect(captureAfterFailure).toEqual(captureBeforeFailure);
  }, 120_000);

  it('queues four dispatches behind a live root owner beyond five minutes, then launches each packet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const repoPath = createRemoteBackedRepo();
    await import('@/lib/repos/registry').then(({ addRepo }) => addRepo(repoPath));
    const [{ runDispatchTick }, lanes, leases, controlPlane] = await Promise.all([
      import('@/lib/orchestrator/scheduling'), import('@/lib/lane/registry'),
      import('@/lib/orchestrator/workspace-lifecycle-lease'), import('@/lib/orchestrator/control-plane'),
    ]);
    const packets = Array.from({ length: 4 }, (_, index) => packet(repoPath, `pkt-root-queue-${index}`));
    const initial = { ...await mission(repoPath, packets[0]), packets };
    controlPlane.writeOrchestratorControlPlaneState(initial);
    const rootKey = createHash('sha256').update(realpathSync(repoPath)).digest('hex');
    const owner = await leases.acquireWorkspaceLifecycleLease(`managed-worktree-root:${rootKey}`);
    queueProbe.entered = 0;
    const dispatches = packets.map((target) => runDispatchTick({ ...initial, packets: [target] }, {
      launchBudget: { maxLaunches: 1 },
    }));
    let queuedOrder: string[] = [];
    const clock = Date.now.bind(Date);
    let dateSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await waitFor(() => queueProbe.entered === 4 ? true : null, 'four provisioning requests');
      await waitFor(() => {
        const waiting = controlPlane.reconcileOrchestratorControlPlaneState(initial).packets;
        return waiting.every((target) => target.blockedReason?.startsWith('Queued for provisioning')) ? waiting : null;
      }, 'visible provisioning queue');
      const waiting = controlPlane.reconcileOrchestratorControlPlaneState(initial).packets;
      queuedOrder = [...waiting].sort((left, right) =>
        Number(left.blockedReason!.match(/position (\d+)/)![1])
        - Number(right.blockedReason!.match(/position (\d+)/)![1])).map((target) => target.id);
      expect(waiting.map((target) => Number(target.blockedReason!.match(/position (\d+)/)![1])).sort()).toEqual([1, 2, 3, 4]);
      const waitingLane = lanes.findLatestLaneByPacket(packets[0].id)!;
      for (let heartbeat = 0; heartbeat < 501; heartbeat += 1) {
        lanes.appendEvent(waitingLane.id, 'worktree_provision_queued', 'system', { packetId: packets[0].id, position: 1 });
      }
      dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock() + 6 * 60_000);
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      dateSpy?.mockRestore();
      leases.releaseWorkspaceLifecycleLease(owner);
    }
    const results = await Promise.all(dispatches);
    const { getSqlite } = await import('@/lib/db');
    const startedOrder = getSqlite().prepare(`
      SELECT payload_json FROM lane_events WHERE verb = 'worktree_provision_started' ORDER BY rowid
    `).all() as Array<{ payload_json: string }>;
    expect(startedOrder.map((event) => JSON.parse(event.payload_json).packetId)
      .filter((id: string) => packets.some((target) => target.id === id))).toEqual(queuedOrder);
    expect(getSqlite().prepare('SELECT COUNT(*) FROM workspace_provision_queue').pluck().get()).toBe(0);
    for (const [index, result] of results.entries()) {
      const lane = lanes.findLatestLaneByPacket(packets[index].id)!;
      const events = lanes.getLaneEvents(lane.id, 200);
      expect(result.packets[0].status, result.packets[0].blockedReason ?? undefined).toBe('launching');
      expect(events.some((event) => event.verb === 'worktree_provision_failed')).toBe(false);
      expect(events.some((event) => event.payload.eventLabel === 'session_launched')).toBe(true);
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ verb: 'worktree_provision_queued', payload: expect.objectContaining({
          packetId: packets[index].id, position: expect.any(Number),
        }) }),
      ]));
    }
  }, 120_000);

  it('retries changing artifact accounting before spawning and records the admission cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    mkdirSync(ownedRoot, { recursive: true });
    artifactRace.file = join(realpathSync(ownedRoot), 'active-writer.log');
    artifactRace.accounting = false;
    artifactRace.injected = false;
    writeFileSync(artifactRace.file, 'initial writer output\n');
    const repoPath = createRemoteBackedRepo();
    await import('@/lib/repos/registry').then(({ addRepo }) => addRepo(repoPath));
    const [{ runDispatchTick }, lanes] = await Promise.all([
      import('@/lib/orchestrator/scheduling'), import('@/lib/lane/registry'),
    ]);
    const packetId = 'pkt-artifact-admission-retry';
    const before = existsSync(capturePath) ? readFileSync(capturePath, 'utf8').trim().split('\n').length : 0;
    try {
      const result = await runDispatchTick(await mission(repoPath, packet(repoPath, packetId)), {
        launchBudget: { maxLaunches: 1 },
      });
      const lane = lanes.findLatestLaneByPacket(packetId)!;
      expect(result.packets[0].status, result.packets[0].blockedReason ?? undefined).toBe('launching');
      expect(lanes.getLaneEvents(lane.id, 200)).toEqual(expect.arrayContaining([
        expect.objectContaining({ verb: 'artifact_admission_retry', payload: expect.objectContaining({
          attempt: 1, cause: expect.stringContaining('artifact accounting changed'),
        }) }),
      ]));
      await waitFor(() => readFileSync(capturePath, 'utf8').trim().split('\n').length === before + 1 ? true : null,
        'one admitted spawn');
      expect(readFileSync(artifactRace.file, 'utf8')).toContain('writer update');
    } finally {
      rmSync(artifactRace.file, { force: true });
      artifactRace.file = '';
    }
  }, 120_000);

  it('stops after three admission retries when the writer never settles, without spawning or deleting evidence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    mkdirSync(ownedRoot, { recursive: true });
    artifactRace.file = join(realpathSync(ownedRoot), 'continuous-writer.log');
    artifactRace.accounting = false;
    artifactRace.injected = false;
    artifactRace.continuous = true;
    writeFileSync(artifactRace.file, 'initial writer output\n');
    const repoPath = createRemoteBackedRepo();
    await import('@/lib/repos/registry').then(({ addRepo }) => addRepo(repoPath));
    const [{ runDispatchTick }, lanes] = await Promise.all([
      import('@/lib/orchestrator/scheduling'), import('@/lib/lane/registry'),
    ]);
    const packetId = 'pkt-artifact-admission-bounded';
    const before = existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '';
    try {
      const result = await runDispatchTick(await mission(repoPath, packet(repoPath, packetId)), {
        launchBudget: { maxLaunches: 1 },
      });
      const lane = lanes.findLatestLaneByPacket(packetId)!;
      expect(result.packets[0].status).toBe('blocked');
      expect(result.packets[0].blockedReason).toContain('artifact accounting changed');
      expect(lanes.getLaneEvents(lane.id, 200).filter((event) => event.verb === 'artifact_admission_retry')
        .map((event) => event.payload.attempt)).toEqual([1, 2, 3]);
      expect(existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '').toBe(before);
      expect(readFileSync(artifactRace.file, 'utf8').match(/writer update/g)).toHaveLength(4);
    } finally {
      rmSync(artifactRace.file, { force: true });
      artifactRace.file = '';
      artifactRace.continuous = false;
    }
  }, 120_000);

  it('retries a busy artifact namespace before launch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const repoPath = createRemoteBackedRepo();
    await import('@/lib/repos/registry').then(({ addRepo }) => addRepo(repoPath));
    const [{ runDispatchTick }, lanes, { withOwnedArtifactRootLock }] = await Promise.all([
      import('@/lib/orchestrator/scheduling'), import('@/lib/lane/registry'),
      import('@/lib/runtimes/shared/owned-session/artifact-admission'),
    ]);
    const packetId = 'pkt-busy-artifact-namespace';
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const held = withOwnedArtifactRootLock(ownedRoot, () => new Promise<void>((resolve) => { release = resolve; entered(); }));
    await ready;
    let finished = false;
    const dispatch = runDispatchTick(await mission(repoPath, packet(repoPath, packetId)), { launchBudget: { maxLaunches: 1 } })
      .then((result) => { finished = true; return result; });
    try {
      await waitFor(() => {
        const lane = lanes.findLatestLaneByPacket(packetId);
        return finished || (lane && lanes.getLaneEvents(lane.id, 200).some((event) => event.verb === 'artifact_admission_retry')) ? true : null;
      }, 'artifact namespace retry');
    } finally {
      release();
      await held;
    }
    const result = await dispatch;
    expect(result.packets[0].status, result.packets[0].blockedReason ?? undefined).toBe('launching');
  }, 120_000);

  it('records a failed backend handoff on the real declarative packet lane and never spawns', async () => {
    readinessBoundary.real = true;
    const captureBefore = existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '';
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('private transport details', { cause: { code: 'ECONNREFUSED' } });
    }));
    const repoPath = createRemoteBackedRepo();
    await import('@/lib/repos/registry').then(({ addRepo }) => addRepo(repoPath));
    const [{ runDispatchTick }, lanes] = await Promise.all([
      import('@/lib/orchestrator/scheduling'), import('@/lib/lane/registry'),
    ]);
    const packetId = 'pkt-backend-handoff-refused';
    const result = await runDispatchTick(await mission(repoPath, packet(repoPath, packetId)), {
      launchBudget: { maxLaunches: 1 },
    });
    const lane = lanes.findLatestLaneByPacket(packetId)!;
    const events = lanes.getLaneEvents(lane.id, 200);
    const steps = events.filter((event) => event.verb === 'runtime_launch_step' && event.payload.step === 'backend_readiness');
    expect(steps.map((event) => event.payload.phase)).toEqual(['started', 'failed']);
    expect(steps[0].payload).toMatchObject({ packetId, runtime: 'qoder', step: 'backend_readiness', deadlineMs: 20_000 });
    expect(steps[1].payload).toMatchObject({
      code: 'dispatch_backend_not_ready', reason: 'fetch_failed', transportCode: 'ECONNREFUSED',
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/api\/setup\/status$/),
      elapsedMs: expect.any(Number), portSource: expect.any(String),
    });
    expect(Number(steps[1].payload.elapsedMs)).toBeLessThan(25_000);
    expect(lane.status).not.toBe('launching');
    expect(lane.sessionKey).toBeNull();
    expect(result.packets[0].blockedReason).toContain('ECONNREFUSED');
    expect(result.packets[0].blockedReason).not.toMatch(/warming|private/);
    expect(events.some((event) => event.payload.eventLabel === 'session_launched')).toBe(false);
    expect(existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '').toBe(captureBefore);
  }, 120_000);

  it('verifies a materialized dev binary and blocks launch when the binary is incomplete', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const [{ runDispatchTick, mergeDispatchTickOutcome }, laneRegistry, repoRegistry, controlPlane] = await Promise.all([
      import('@/lib/orchestrator/scheduling'),
      import('@/lib/lane/registry'),
      import('@/lib/repos/registry'),
      import('@/lib/orchestrator/control-plane'),
    ]);

    const completeRepo = createDependencyRemoteBackedRepo(false);
    const completeRegistration = await repoRegistry.addRepo(completeRepo);
    expect(completeRegistration.setup).toMatchObject({
      installCommand: 'npm ci --prefer-offline',
      installOnCreateWorkspace: true,
    });
    const completeId = 'pkt-dependency-materialized';
    const launched = await runDispatchTick(await mission(
      completeRepo,
      packet(completeRepo, completeId),
    ), { launchBudget: { maxLaunches: 1 } });
    const completeLane = laneRegistry.findLatestLaneByPacket(completeId);
    expect(launched.packets[0]?.status, launched.packets[0]?.blockedReason ?? undefined).toBe('launching');
    expect(completeLane?.worktreePath).toBeTruthy();
    expect(existsSync(join(completeLane!.worktreePath!, 'node_modules', '.bin', 'gate-check'))).toBe(true);
    expect(laneRegistry.getLaneEvents(completeLane!.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'dependency_materialized',
        payload: expect.objectContaining({
          mode: 'native',
          recipeKey: expect.stringMatching(/^[0-9a-f]{64}$/),
          topLevelEntryCount: expect.any(Number),
          verifiedBinaries: ['gate-check'],
          missingBinaries: [],
        }),
      }),
    ]));

    const incompleteRepo = createDependencyRemoteBackedRepo(true);
    const incompleteRegistration = await repoRegistry.addRepo(incompleteRepo);
    expect(incompleteRegistration.setup.installOnCreateWorkspace).toBe(true);
    const incompleteId = 'pkt-dependency-incomplete';
    const initial = await mission(incompleteRepo, packet(incompleteRepo, incompleteId));
    controlPlane.writeOrchestratorControlPlaneState(initial);
    const captureCountBefore = existsSync(capturePath)
      ? readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean).length
      : 0;
    const blocked = await runDispatchTick(initial, { launchBudget: { maxLaunches: 1 } });
    await controlPlane.withLockedState((fresh) => {
      mergeDispatchTickOutcome(fresh, initial, blocked);
    });
    const incompleteLane = laneRegistry.findLatestLaneByPacket(incompleteId);
    const persistedPacket = controlPlane.readOrchestratorControlPlaneState().packets
      .find((candidate) => candidate.id === incompleteId);
    const captureCountAfter = existsSync(capturePath)
      ? readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean).length
      : 0;
    expect(blocked.packets[0]?.status).toBe('blocked');
    expect(persistedPacket?.blockedReason).toContain('dependency_materialization_incomplete');
    expect(persistedPacket?.blockedReason).toContain('gate-check');
    expect(incompleteLane?.status).toBe('failed');
    expect(laneRegistry.getLaneEvents(incompleteLane!.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'dependency_materialization_incomplete',
        payload: expect.objectContaining({
          code: 'dependency_materialization_incomplete',
          mode: 'native',
          missingBinaries: ['gate-check'],
        }),
      }),
    ]));
    expect(captureCountAfter).toBe(captureCountBefore);
  }, 120_000);

  it('keeps a never-launched lane live while slow worktree provisioning fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const repoPath = createRemoteBackedRepo();
    await import('@/lib/repos/registry').then(({ addRepo }) => addRepo(repoPath));
    const [{ runDispatchTick, mergeDispatchTickOutcome }, laneRegistry, controlPlane, ancestry] = await Promise.all([
      import('@/lib/orchestrator/scheduling'),
      import('@/lib/lane/registry'),
      import('@/lib/orchestrator/control-plane'),
      import('@/lib/orchestrator/merged-by-ancestry'),
    ]);

    const packetId = 'pkt-slow-provision-race';
    const initial = await mission(repoPath, packet(repoPath, packetId));
    controlPlane.writeOrchestratorControlPlaneState(initial);
    provisioningRace.enabled = true;
    const dispatchPromise = runDispatchTick(initial, {
      launchBudget: { maxLaunches: 1 },
    });
    const openedLane = await waitFor(() => {
      if (!provisioningRace.promptEntered) return null;
      return laneRegistry.findLatestLaneByPacket(packetId);
    }, 'opened pre-launch lane');

    const sweepResult = await ancestry.sweepPacketsMergedByAncestry();
    provisioningRace.releasePrompt = true;
    await waitFor(
      () => provisioningRace.provisioningEntered ? true : null,
      'slow worktree provisioning',
    );
    const laneDuringProvisioning = laneRegistry.getLane(openedLane.id);
    provisioningRace.releaseProvisioning = true;
    const dispatched = await dispatchPromise;
    await controlPlane.withLockedState((fresh) => {
      mergeDispatchTickOutcome(fresh, initial, dispatched);
    });
    const persistedPacket = controlPlane.readOrchestratorControlPlaneState().packets
      .find((candidate) => candidate.id === packetId);

    controlPlane.writeOrchestratorControlPlaneState({
      ...initial,
      packets: [],
      updatedAt: new Date().toISOString(),
    });
    const postFailureSweep = await ancestry.sweepPacketsMergedByAncestry();

    expect(sweepResult.merged).toBe(0);
    expect(postFailureSweep.merged).toBe(0);
    expect(laneDuringProvisioning).toMatchObject({
      status: 'launching',
      outcome: null,
    });
    expect(persistedPacket).toMatchObject({
      status: 'failed',
      blockedReason: expect.stringContaining('packet_worktree_provision_failed'),
    });
    expect(laneRegistry.getLane(openedLane.id)).toMatchObject({
      status: 'failed',
      outcome: null,
    });
    expect(laneRegistry.getLaneEvents(openedLane.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'worktree_provision_failed',
        payload: expect.objectContaining({
          code: 'packet_worktree_provision_failed',
          packetId,
          cause: worktreeFailure.message,
        }),
      }),
    ]));
    expect(laneRegistry.getLaneEvents(openedLane.id, 200)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({ reason: 'branch_missing_reconciled' }),
      }),
    ]));
    expect(existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '').not.toContain(packetId);
  }, 40_000);

  it('stops the worker and retains its workspace when the real route cannot persist its governance lane', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const repoPath = createRemoteBackedRepo();
    await import('@/lib/repos/registry').then(({ addRepo }) => addRepo(repoPath));
    const laneRegistry = await import('@/lib/lane/registry');
    const { getRuntime } = await import('@/lib/runtimes');
    const runtime = getRuntime('qoder')!;
    const sessionsBefore = new Set((await runtime.discoverSessions()).map((session) => session.sessionKey));
    const createLane = vi.spyOn(laneRegistry, 'createLane').mockImplementationOnce(() => {
      throw new Error('synthetic lane persistence failure');
    });
    try {
      const { POST } = await import('@/app/api/runtime/launch/route');
      const response = await POST(new NextRequest('http://localhost/api/runtime/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runtime: 'qoder',
          prompt: 'prove launch rollback',
          repoPath,
          isolate: true,
          clientMutationId: 'runtime-launch-lane-failure',
        }),
      }));

      expect(response.status).toBe(409);
      const result = await response.json();
      expect(result).toMatchObject({
        ok: false,
        outcomeUnknown: true,
        retryable: false,
        surfaceId: expect.stringMatching(/^qoder-owned:/),
        note: expect.stringContaining('its worktree could not be cleaned after governance registration failed'),
      });
      expect(existsSync(result.worktree.path)).toBe(true);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const extra = (await runtime.discoverSessions())
          .filter((session) => !sessionsBefore.has(session.sessionKey));
        if (extra.length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect((await runtime.discoverSessions())
        .filter((session) => !sessionsBefore.has(session.sessionKey))).toEqual([]);
      const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: repoPath,
        encoding: 'utf8',
      });
      expect(worktrees.match(/^worktree /gm)).toHaveLength(2);
    } finally {
      createLane.mockRestore();
    }
  }, 40_000);
});
