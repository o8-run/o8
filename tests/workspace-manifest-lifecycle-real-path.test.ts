import { createHash } from 'node:crypto';
import type { ExecFileOptions } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

type SetupMode = 'complete' | 'timeout' | 'cancel' | 'block_once';

const execution = vi.hoisted(() => ({
  mode: 'complete' as SetupMode,
  blockedOnce: false,
  invocations: [] as Array<{ command: string; cwd: string }>,
  children: [] as Array<{
    command: string;
    killed: boolean;
    release: (() => void) | null;
  }>,
  crashSeed: null as null | {
    packetId: string;
    laneId: string;
    manifestHash: string;
    port: number;
  },
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = (
    file: string,
    args: string[] = [],
    options: ExecFileOptions = {},
    callback?: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const cwd = String(options.cwd ?? '');
    seedCrashedReceiptAtProcessBoundary(cwd);
    const setupCommand = ['manifest-step-one', 'manifest-step-two']
      .find((candidate) => args.includes(candidate));
    if (!setupCommand) return actual.execFile(file, args, options, callback as never);

    execution.invocations.push({ command: setupCommand, cwd });
    const child = {
      command: setupCommand,
      killed: false,
      release: null as (() => void) | null,
    };
    const finish = () => queueMicrotask(() => callback?.(null, '', ''));
    if (execution.mode === 'complete') {
      finish();
    } else if (execution.mode === 'block_once' && !execution.blockedOnce) {
      execution.blockedOnce = true;
      child.release = finish;
    } else if (execution.mode === 'block_once') {
      finish();
    }
    execution.children.push(child);
    return {
      kill: () => {
        child.killed = true;
        child.release = null;
        return true;
      },
    } as never;
  };
  const promisifySymbol = Symbol.for('nodejs.util.promisify.custom');
  Object.defineProperty(execFile, promisifySymbol, {
    value: (actual.execFile as unknown as Record<symbol, unknown>)[promisifySymbol],
  });
  return { ...actual, execFile };
});

const tempRoot = realpathSync(mkdtempSync(path.join(os.homedir(), '.tmp-o8-manifest-lifecycle-')));
const dataDir = path.join(tempRoot, 'data');
const repoPath = path.join(tempRoot, 'repo');
const worktreeRoot = path.join(tempRoot, 'worktrees');
const manifestPath = path.join(repoPath, 'o8.workspace.json');
const preferredPort = 44_100;
const controlledEnvKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'O8_WORKTREE_ROOT',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
] as const;
const priorEnv: Record<string, string | undefined> = {};
let launchSequence = 0;

function seedCrashedReceiptAtProcessBoundary(cwd: string): void {
  const seed = execution.crashSeed;
  if (!seed
    || !cwd.startsWith(worktreeRoot)
    || !existsSync(path.join(cwd, 'o8.workspace.json'))) return;
  const receiptPath = path.join(cwd, '.o8', 'workspace-manifest-receipt.json');
  if (existsSync(receiptPath)) return;
  mkdirSync(path.dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify({
    version: 1,
    packetId: seed.packetId,
    laneId: seed.laneId,
    manifestHash: seed.manifestHash,
    state: 'running',
    pid: 2_147_483_647,
    startedAt: '2026-08-28T04:00:00.000Z',
    step: 'setup:1',
    ports: { app: seed.port },
    setup: [],
    services: [],
  }, null, 2)}\n`);
  execution.crashSeed = null;
}

function resetExecution(mode: SetupMode): void {
  execution.mode = mode;
  execution.blockedOnce = false;
  execution.invocations.length = 0;
  execution.children.length = 0;
  execution.crashSeed = null;
}

function setupChild(command = 'manifest-step-one') {
  return execution.children.find((child) => child.command === command) ?? null;
}

async function bindLaneWorktree(laneId: string, worktreePath: string) {
  const { getLane, updateLane } = await import('@/lib/lane/registry');
  const { getWorktreeManager } = await import('@/lib/worktree/launch');
  const { bindOwnedPacketSession } = await import('./helpers/managed-packet-worktree');
  const lane = getLane(laneId)!;
  const worktree = (await getWorktreeManager(repoPath).list()).find((entry) => entry.path === worktreePath)!;
  const sessionKey = await bindOwnedPacketSession(repoPath, worktree, { packetId: lane.packetId!, branch: lane.branch });
  updateLane(laneId, { worktreePath, sessionKey }, 'system');
}

async function launchPacket(input: {
  packetId: string;
  branch?: string;
  bindWorktree?: boolean;
}) {
  launchSequence += 1;
  const branch = input.branch ?? `issue/1910-lifecycle-${launchSequence}`;
  const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
  const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');
  const lane = createLane({
    repoPath,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    label: `${input.packetId}-${launchSequence}`,
    packetId: input.packetId,
  });
  setLaneStatus(lane.id, 'launching', 'system', 'fixture launch');
  const prepared = await prepareLaunchWorktree({
    repoRoot: repoPath,
    agentType: 'codex',
    taskName: input.packetId,
    branchName: branch,
    baseBranch: 'main',
    isolate: true,
    skipSetup: true,
    packetId: input.packetId,
    laneId: lane.id,
  });
  if (!prepared) throw new Error(`Worktree launch returned no workspace for ${input.packetId}.`);
  if (input.bindWorktree !== false) {
    await bindLaneWorktree(lane.id, prepared.cwd);
  }
  return { lane, prepared };
}

async function waitForNoLaneLeases(laneId: string): Promise<void> {
  const { readWorkspacePortLeases } = await import('@/lib/workspace/manifest/port-leases');
  await vi.waitFor(async () => {
    expect(Object.values(await readWorkspacePortLeases()).some(
      (lease) => lease.laneId === laneId,
    )).toBe(false);
  }, { timeout: 30_000 });
}

async function terminalCleanup(laneId: string): Promise<void> {
  const { getLane, setLaneStatus } = await import('@/lib/lane/registry');
  if (getLane(laneId)?.status !== 'failed') {
    setLaneStatus(laneId, 'failed', 'system', 'test cleanup');
  }
  await waitForNoLaneLeases(laneId);
}

async function archivedReceipts(worktreePath: string) {
  const directory = path.join(worktreePath, '.o8');
  return readdirSync(directory)
    .filter((name) => name.startsWith('workspace-manifest-receipt.') && name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as {
      state: string;
      laneId: string;
    });
}

describe.sequential('workspace manifest lifecycle through packet launch', () => {
  beforeAll(async () => {
    for (const key of controlledEnvKeys) priorEnv[key] = process.env[key];
    mkdirSync(dataDir, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
    writeFileSync(path.join(repoPath, 'README.md'), 'workspace manifest lifecycle fixture\n');
    writeFileSync(path.join(repoPath, '.gitignore'), '.o8/\n');
    writeFileSync(manifestPath, `${JSON.stringify({
      version: 1,
      setup: ['manifest-step-one', 'manifest-step-two'],
      services: [{
        name: 'app',
        command: 'exec sleep 600',
        port: { preferred: preferredPort, env: 'APP_PORT' },
      }],
    }, null, 2)}\n`);
    execFileSync('git', ['add', 'README.md', '.gitignore', 'o8.workspace.json'], { cwd: repoPath });
    execFileSync('git', [
      '-c', 'user.email=test@o8.test',
      '-c', 'user.name=o8-test',
      'commit', '-qm', 'fixture',
    ], { cwd: repoPath });
    execFileSync('git', ['remote', 'add', 'origin', repoPath], { cwd: repoPath });

    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.O8_DATA_DIR = dataDir;
    process.env.O8_WORKTREE_ROOT = worktreeRoot;
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    await updateOperatorDefaults({
      productTelemetryEnabled: false,
      storageReserveRatio: 0.0001,
      storageReserveFloorGb: 0.001,
      workspaceManifestPolicy: 'auto',
    });
  });

  afterAll(async () => {
    const { listManagedRuns } = await import('@/lib/runtimes/managed-runs/registry');
    const { settleTerminalWorkspaceManifest } = await import('@/lib/workspace/manifest/lifecycle');
    for (const run of await listManagedRuns()) {
      if (run.workspaceService && run.cwd.startsWith(`${tempRoot}${path.sep}`)) await settleTerminalWorkspaceManifest(run.workspaceService);
    }
    const { setWorkspaceManifestSetupTimeoutForTest } = await import(
      '@/lib/workspace/manifest/apply'
    );
    setWorkspaceManifestSetupTimeoutForTest(null);
    const { closeDb } = await import('@/lib/db');
    closeDb();
    for (const key of controlledEnvKeys) {
      const prior = priorEnv[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('persists a completed receipt with every setup command', async () => {
    resetExecution('complete');
    const { getLaneEvents } = await import('@/lib/lane/registry');
    const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest');
    const launch = await launchPacket({ packetId: 'packet-manifest-completed' });

    const receipt = await readWorkspaceManifestReceipt(launch.prepared.cwd);
    expect(receipt).toMatchObject({
      packetId: 'packet-manifest-completed',
      laneId: launch.lane.id,
      state: 'completed',
      ports: { app: preferredPort },
    });
    expect(receipt?.setup).toHaveLength(2);
    expect(receipt?.setup.map((entry) => entry.index)).toEqual([0, 1]);
    expect(receipt?.services).toHaveLength(1);
    expect(getLaneEvents(launch.lane.id, 100).find(
      (event) => event.verb === 'workspace_manifest_applied',
    )?.payload).toMatchObject({ state: 'completed' });
    expect(execFileSync('git', ['check-ignore', '.o8/workspace-manifest-receipt.json'], {
      cwd: launch.prepared.cwd,
      encoding: 'utf8',
    }).trim()).toBe('.o8/workspace-manifest-receipt.json');

    await terminalCleanup(launch.lane.id);
  }, 90_000);

  it('settles a timed-out setup step and releases its lease on terminal cleanup', async () => {
    resetExecution('timeout');
    const { getLaneEvents } = await import('@/lib/lane/registry');
    const {
      setWorkspaceManifestSetupTimeoutForTest,
    } = await import('@/lib/workspace/manifest/apply');
    const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest');
    setWorkspaceManifestSetupTimeoutForTest(40);
    const launch = await launchPacket({ packetId: 'packet-manifest-timeout' });
    setWorkspaceManifestSetupTimeoutForTest(null);

    const receipt = await readWorkspaceManifestReceipt(launch.prepared.cwd);
    expect(receipt).toMatchObject({
      state: 'timed_out',
      step: 'setup:1',
      commandId: expect.stringMatching(/^[a-f0-9]{64}$/),
      error: expect.stringContaining('timed out after 40ms'),
    });
    expect(setupChild()?.killed).toBe(true);
    expect(getLaneEvents(launch.lane.id, 100).find(
      (event) => event.verb === 'workspace_manifest_failed',
    )?.payload).toMatchObject({
      state: 'timed_out',
      step: 'setup:1',
      commandId: receipt?.commandId,
    });

    await terminalCleanup(launch.lane.id);
  }, 90_000);

  it('aborts a blocked setup command and settles cancellation before releasing leases', async () => {
    resetExecution('cancel');
    const {
      createLane,
      getLane,
      getLaneEvents,
      setLaneStatus,
    } = await import('@/lib/lane/registry');
    const { prepareLaunchWorktree, getWorktreeManager } = await import('@/lib/worktree/launch');
    const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest');
    const packetId = 'packet-manifest-cancel';
    const branch = 'issue/1910-lifecycle-cancel';
    const lane = createLane({
      repoPath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: packetId,
      packetId,
    });
    setLaneStatus(lane.id, 'launching', 'system', 'fixture launch');
    const launchPromise = prepareLaunchWorktree({
      repoRoot: repoPath,
      agentType: 'codex',
      taskName: packetId,
      branchName: branch,
      baseBranch: 'main',
      isolate: true,
      skipSetup: true,
      packetId,
      laneId: lane.id,
    });
    const launchOutcome = launchPromise.then(prepared => ({ prepared, error: null }), error => ({ prepared: null, error }));
    let worktreePath = '';
    await vi.waitFor(async () => {
      const setupWorktree = (await getWorktreeManager(repoPath).list())
        .find((worktree) => worktree.branch === branch && worktree.status === 'setup');
      worktreePath = setupWorktree?.path ?? '';
      expect((await readWorkspaceManifestReceipt(worktreePath))?.state).toBe('running');
      expect((await readWorkspaceManifestReceipt(worktreePath))?.step).toBe('setup:1');
    }, { timeout: 30_000 });

    await bindLaneWorktree(lane.id, worktreePath);
    setLaneStatus(lane.id, 'failed', 'system', 'cancel manifest setup');
    const outcome = await launchOutcome;
    expect(outcome.prepared).toBeNull();
    expect(outcome.error).toMatchObject({
      message: expect.stringContaining('Managed worktree was prepared without an exact unbound pre-launch lane. Exact retirement was refused; durable workspace ownership was retained:'),
      cause: expect.objectContaining({ message: 'Creation rollback has no matching durable creation authority.' }),
    });
    expect(setupChild()?.killed).toBe(true);
    expect(await readWorkspaceManifestReceipt(worktreePath)).toMatchObject({
      state: 'cancelled',
      step: 'setup:1',
    });
    expect(getLaneEvents(lane.id, 100).find(
      (event) => event.verb === 'workspace_manifest_failed',
    )?.payload).toMatchObject({ state: 'cancelled', step: 'setup:1' });
    await waitForNoLaneLeases(lane.id);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(existsSync(worktreePath)).toBe(true);
    expect(getLane(lane.id)?.worktreePath).toBe(worktreePath);
    expect(getLaneEvents(lane.id, 100).some((event) => (
      event.payload.phase === 'terminal_cleanup'
      || event.payload.reason === 'terminal_worktree_cleanup'
    ))).toBe(false);
  }, 90_000);

  it('settles a completed transition before removing its worktree', async () => {
    resetExecution('complete');
    const { getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
    const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest');
    const launch = await launchPacket({ packetId: 'packet-manifest-completed-cleanup',
      branch: 'issue/1910-lifecycle-completed-cleanup' });
    const lane = launch.lane;
    const worktreePath = launch.prepared.cwd;
    const receipt = await readWorkspaceManifestReceipt(worktreePath);
    expect(receipt?.state).toBe('completed');
    const servicePid = receipt!.services[0].pid!;
    expect(servicePid).toBeGreaterThan(0);
    setLaneStatus(lane.id, 'completed', 'system', 'completed');
    await waitForNoLaneLeases(lane.id);
    // The valid post-provisioning transition settles its owned service before
    // maintenance can remove the directory and lifecycle evidence.
    expect(() => process.kill(servicePid, 0)).toThrow();
    expect((await readWorkspaceManifestReceipt(worktreePath))?.cleanup?.state).toBe('completed');
    const { runWorktreeMaintenanceTick } = await import('@/lib/lane/worktree-reaper');
    await vi.waitFor(async () => {
      await runWorktreeMaintenanceTick(repoPath);
      expect(existsSync(worktreePath)).toBe(false);
      expect(getLane(lane.id)?.worktreePath).toBeNull();
      expect(getLaneEvents(lane.id, 100).some((event) => (
        event.payload.phase === 'bounded_maintenance'
        && event.payload.worktreeRemoved === true
      ))).toBe(true);
    }, { timeout: 60_000 });
  }, 90_000);

  it('rewrites a dead owner as crashed, releases stale leases, and starts a fresh attempt', async () => {
    resetExecution('complete');
    const { createLane, getLaneEvents } = await import('@/lib/lane/registry');
    const {
      allocateWorkspaceServicePorts,
      readWorkspacePortLeases,
    } = await import('@/lib/workspace/manifest/port-leases');
    const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest');
    const packetId = 'packet-manifest-crash';
    const oldLane = createLane({
      repoPath,
      branch: 'issue/1910-lifecycle-crash-old',
      baseBranch: 'main',
      runtime: 'codex',
      label: `${packetId}-old`,
      packetId,
    });
    await allocateWorkspaceServicePorts({
      packetId,
      laneId: oldLane.id,
      services: [{ name: 'app', preferred: preferredPort }],
    });
    execution.crashSeed = {
      packetId,
      laneId: oldLane.id,
      manifestHash: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
      port: preferredPort,
    };

    const launch = await launchPacket({
      packetId,
      branch: 'issue/1910-lifecycle-crash-new',
    });
    expect(await readWorkspaceManifestReceipt(launch.prepared.cwd)).toMatchObject({
      laneId: launch.lane.id,
      state: 'completed',
      ports: { app: preferredPort },
    });
    expect(await archivedReceipts(launch.prepared.cwd)).toContainEqual(expect.objectContaining({
      laneId: oldLane.id,
      state: 'crashed',
    }));
    expect(getLaneEvents(oldLane.id, 100).find(
      (event) => event.verb === 'workspace_manifest_failed',
    )?.payload).toMatchObject({ state: 'crashed', step: 'setup:1' });
    const leases = Object.values(await readWorkspacePortLeases());
    expect(leases.some((lease) => lease.laneId === oldLane.id)).toBe(false);
    expect(leases.some((lease) => lease.laneId === launch.lane.id)).toBe(true);

    await terminalCleanup(launch.lane.id);
  }, 90_000);

  it('archives a reset attempt and restores it beside the fresh receipt', async () => {
    resetExecution('complete');
    const { getLaneEvents } = await import('@/lib/lane/registry');
    const { resetPacket } = await import('@/lib/orchestrator/operator-mission-service/reset');
    const { getWorktreeManager, prepareLaunchWorktree } = await import('@/lib/worktree/launch');
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest');
    const packetId = 'packet-manifest-reset';
    const branch = 'issue/1910-lifecycle-reset';
    const first = await launchPacket({ packetId, branch });
    const firstReceipt = await readWorkspaceManifestReceipt(first.prepared.cwd);
    expect(firstReceipt?.state).toBe('completed');

    const reset = await resetPacket({ packetId, clearWorktree: true, reason: 'lifecycle proof' });
    expect(reset.reset).toBe(true);
    expect(reset.worktreePruned).toBe(true);
    await waitForNoLaneLeases(first.lane.id);

    resetExecution('block_once');
    const { getPacketStorageAdmissionCoordinator } = await import(
      '@/lib/orchestrator/storage-admission'
    );
    const { recordLaneEvent } = await import('@/lib/lane/events');
    const storagePacket = {
      id: packetId,
      referenceLabel: packetId,
      title: packetId,
      summary: packetId,
      workspaceTargetPath: repoPath,
      branchTarget: branch,
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'queued',
      launchAttempts: 0,
      storageAdmissionEpoch: 1,
    } as OrchestratorPacket;
    const admission = getPacketStorageAdmissionCoordinator();
    const storageLease = await admission.reserveForLaunch(storagePacket);
    const lane = createLane({
      repoPath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      label: `${packetId}-replacement`,
      packetId,
    });
    setLaneStatus(lane.id, 'launching', 'system', 'fixture replacement launch');
    const launchPromise = prepareLaunchWorktree({
      repoRoot: repoPath,
      agentType: 'codex',
      taskName: packetId,
      branchName: branch,
      baseBranch: 'main',
      isolate: true,
      skipSetup: true,
      packetId,
      laneId: lane.id,
      storageAdmissionReservationId: storageLease.reservation.reservationId,
    });
    let worktreePath = '';
    let runningStartedAt = '';
    await vi.waitFor(async () => {
      const setupWorktree = (await getWorktreeManager(repoPath).list())
        .find((worktree) => worktree.branch === branch && worktree.status === 'setup');
      worktreePath = setupWorktree?.path ?? '';
      const receipt = await readWorkspaceManifestReceipt(worktreePath);
      expect(receipt?.state).toBe('running');
      runningStartedAt = receipt?.startedAt ?? '';
      expect(await archivedReceipts(worktreePath)).toContainEqual(expect.objectContaining({
        laneId: first.lane.id,
        state: 'completed',
      }));
      expect(setupChild()?.release).toBeTypeOf('function');
    }, { timeout: 30_000 });

    const blocked = setupChild();
    expect(blocked?.release).toBeTypeOf('function');
    blocked?.release?.();
    const prepared = await launchPromise;
    if (!prepared) throw new Error('Reset launch returned no worktree.');
    await admission.commitAfterLaunch(storageLease);
    recordLaneEvent(lane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: storageLease.receipt.ownerGeneration,
      storageAdmissionReservationId: storageLease.reservation.reservationId,
    });
    await bindLaneWorktree(lane.id, prepared.cwd);
    expect(await readWorkspaceManifestReceipt(prepared.cwd)).toMatchObject({
      laneId: lane.id,
      state: 'completed',
      startedAt: runningStartedAt,
    });
    expect(getLaneEvents(lane.id, 100).find(
      (event) => event.verb === 'workspace_manifest_applied',
    )?.payload).toMatchObject({ state: 'completed' });

    await terminalCleanup(lane.id);
  }, 120_000);
});
