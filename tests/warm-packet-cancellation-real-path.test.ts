import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, statfs: vi.fn(async (file: string) => {
    const info = await actual.statfs(file);
    // Model the same bounded-volume capability as the launch-budget fixture.
    return file.includes('warm-cancellation-')
      ? { ...info, blocks: Math.floor(4 * 1024 ** 3 / info.bsize) } : info;
  }) };
});
vi.mock('@/lib/worktree/storage-telemetry', async original => ({
  ...await original<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/',
    availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null })),
}));

const root = realpathSync(mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'warm-cancellation-')));
const repo = join(root, 'repo');
const bin = join(root, 'bin');
vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
vi.stubEnv('O8_DATA_DIR', root);
vi.stubEnv('O8_WORKTREE_ROOT', join(root, 'worktrees'));
vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
vi.stubEnv('O8_APFS_COW_WORKSPACES', '0');
const { getSqlite, closeDb } = await import('@/lib/db');
const lanes = await import('@/lib/lane/registry');
const { recordMission } = await import('@/lib/db/missions-store');
const control = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getPacketStorageAdmissionCoordinator } = await import('@/lib/orchestrator/storage-admission');
const { assertPreRunAdmission, withPreRunLaunchCancellation } = await import('@/lib/lane/pre-run-cancellation');
const { withManagedWorktreeRegistryQueue, withManagedWorktreeStorageAdmission } = await import('@/lib/worktree/launch-storage-admission');
const { scheduleWarmPacketWorktrees, shutdownWarmPacketWorktrees } = await import('@/lib/worktree/warm-packet-pool');
const { WorktreeManager } = await import('@/lib/worktree/manager');
const { readWorktreeMetaSnapshot } = await import('@/lib/worktree/metadata-store');
const stopRoute = await import('@/app/api/orchestrator/stop-mission/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

beforeAll(async () => {
  mkdirSync(repo);
  mkdirSync(bin);
  mkdirSync(join(root, 'worktrees'));
  const npmCli = process.env.npm_execpath!;
  const npmVersion = execFileSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8' }).trim();
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'warm-cancel-fixture', version: '1.0.0',
    packageManager: `npm@${npmVersion}`, o8DependencyClone: { lifecycleInputs: [] } }));
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
    packages: { 'node_modules/fixture': { version: '1.0.0' } } }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  git('remote', 'add', 'origin', repo);
  git('fetch', 'origin', 'main');
  writeFileSync(join(bin, 'npm'), [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    `if (args[0] !== 'ci') { const result = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(npmCli)}, ...args], { stdio: 'inherit' }); process.exit(result.status ?? 1); }`,
    "fs.mkdirSync('node_modules/fixture', { recursive: true });",
    "fs.writeFileSync('node_modules/fixture/package.json', '{\"name\":\"fixture\",\"version\":\"1.0.0\"}');",
    "fs.writeFileSync('node_modules/fixture/index.js', 'module.exports = 42;\\n');",
  ].join('\n'));
  chmodSync(join(bin, 'npm'), 0o755);
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
  const { addRepo, updateRepo } = await import('@/lib/repos/registry');
  const registration = await addRepo(repo);
  await updateRepo(registration.id, { setup: { ...registration.setup,
    workspaceIsolationPreference: 'git-worktree', installOnCreateWorkspace: true, installCommand: 'npm ci --offline' } });
});

async function packet(id: string, reserve: boolean) {
  const candidate = { id, referenceLabel: id, title: id, summary: 'Cancellation fixture', workspaceTargetPath: repo,
    branchTarget: `packet/${id}`, runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'queued', releaseState: 'pending', status: 'launching', blockedReason: null, lane: null,
  } as OrchestratorPacket;
  const admission = getPacketStorageAdmissionCoordinator();
  const lease = reserve ? await admission.reserveForLaunch(candidate) : undefined;
  const lane = lanes.createLane({ repoPath: repo, branch: candidate.branchTarget, packetId: id, runtime: 'codex' });
  lanes.setLaneStatus(lane.id, 'launching', 'orchestrator', 'launching_session');
  if (lease) lanes.appendEvent(lane.id, 'update', 'orchestrator', {
    storageAdmissionOwnerGeneration: lease.receipt.ownerGeneration,
    storageAdmissionReservationId: lease.receipt.reservationId,
  });
  candidate.lane = { tileId: lane.id, tabId: lane.id, repoPath: repo, worktreePath: null, runtime: 'codex',
    sessionKey: null, laneId: lane.id, lastHeartbeatAt: null, lastEventAt: null, lastEventLabel: null };
  const missionId = `mission-${id}`;
  const mission = { ...createEmptyOrchestratorMissionState(), missionId, repoPath: repo, packets: [candidate] };
  recordMission({ id: missionId, repoPath: repo, runtime: 'codex', prompt: '', summary: '', constraints: '',
    packetMeta: [{ id, title: id, referenceLabel: id }], missionState: mission, totalWaves: 1 });
  control.writeOrchestratorControlPlaneState(mission);
  return { candidate, lane, missionId, admission, lease };
}

async function stop(missionId: string) {
  const response = await stopRoute.POST(new NextRequest('http://localhost/api/orchestrator/stop-mission', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${getOrCreateWsToken()}` },
    body: JSON.stringify({ missionId, idempotencyKey: `stop-${missionId}` }),
  }));
  expect(response.status, JSON.stringify(await response.json())).toBe(200);
}

async function holdQueue() {
  const entered = deferred();
  const release = deferred();
  const done = withManagedWorktreeRegistryQueue(repo, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  return { done, release: release.resolve };
}

it.skipIf(process.platform !== 'linux')('packet cancel during a scheduled refill keeps the pool-owned refill', async () => {
  const owner = await packet('cancel-refill', false);
  const blocker = await holdQueue();
  const original = WorktreeManager.prototype.prepareWarmWorktree;
  let outcome: Promise<unknown> | undefined;
  const preparation = vi.spyOn(WorktreeManager.prototype, 'prepareWarmWorktree').mockImplementation(function (this: InstanceType<typeof WorktreeManager>, opts, created) {
    const work = original.call(this, opts, created);
    outcome = work.then(() => null, error => error);
    return work;
  });
  try {
    const { findRepoByLocalPath } = await import('@/lib/repos/registry');
    await withPreRunLaunchCancellation(owner.lane.id, async () => {
      scheduleWarmPacketWorktrees({ capacity: 1, repoRoot: repo, agentType: 'codex', baseBranch: 'main',
        repoSetup: (await findRepoByLocalPath(repo))!.setup }, new WorktreeManager(repo));
    });
    await vi.waitFor(() => expect(preparation).toHaveBeenCalledOnce(), { timeout: 15_000 });
    await vi.waitFor(() => expect(getSqlite().prepare('SELECT count(*) FROM workspace_provision_queue').pluck().get()).toBe(2));
    await stop(owner.missionId);
    expect(lanes.getLane(owner.lane.id)?.status).toBe('paused');
    blocker.release();
    await blocker.done;
    expect(await outcome, 'packet cancellation must not close the refill admission').toBeNull();
    await vi.waitFor(async () => {
      const prepared = Object.values(await readWorktreeMetaSnapshot(repo)).filter(entry => entry.warmPool);
      expect(prepared).toHaveLength(1);
      expect(prepared[0]).toMatchObject({ status: 'setup', warmPool: { seal: expect.any(Object) } });
      expect(prepared[0]!.packetId).toBeUndefined();
      expect(readFileSync(join(prepared[0]!.materializationIdentity!.canonicalPath, 'node_modules/fixture/index.js'), 'utf8')).toContain('42');
    });
  } finally {
    blocker.release();
    await blocker.done;
    await outcome;
    preparation.mockRestore();
  }
}, 120_000);

it('packet cancel immediately releases its empty reservation before the queued creator can bind', async () => {
  const owner = await packet('cancel-empty', true);
  const blocker = await holdQueue();
  const materialize = vi.fn(async () => {});
  const queued = withPreRunLaunchCancellation(owner.lane.id, () => withManagedWorktreeStorageAdmission({
    repoRoot: repo, packetId: owner.candidate.id, reservationId: owner.lease!.receipt.reservationId,
  }, materialize)).then(() => null, error => error);
  try {
    await vi.waitFor(() => expect(lanes.getLane(owner.lane.id)?.lastEventLabel).toMatch(/^worktree_provision_queued/));
    await stop(owner.missionId);
    expect(getSqlite().prepare('SELECT state FROM storage_admission_reservations WHERE reservation_id = ?').pluck()
      .get(owner.lease!.receipt.reservationId)).toBe('released');
    expect(materialize).not.toHaveBeenCalled();
  } finally {
    blocker.release();
    await blocker.done;
    expect(await queued).toBeInstanceOf(Error);
  }
  expect(materialize).not.toHaveBeenCalled();
}, 120_000);

it('a stalled attempt that entered provisioning stays charged until its creator settles', async () => {
  const owner = await packet('cancel-started', true);
  const blocker = await holdQueue();
  const entered = deferred();
  const release = deferred();
  const creation = withPreRunLaunchCancellation(owner.lane.id, () => withManagedWorktreeStorageAdmission({
    repoRoot: repo, packetId: owner.candidate.id, reservationId: owner.lease!.receipt.reservationId,
  }, async () => { entered.resolve(); await release.promise; assertPreRunAdmission(); })).then(() => null, error => error);
  try {
    await vi.waitFor(() => expect(lanes.getLane(owner.lane.id)?.lastEventLabel).toMatch(/^worktree_provision_queued/));
    lanes.setLaneStatus(owner.lane.id, 'awaiting_orchestrator', 'system', 'launch_stalled');
    blocker.release();
    await blocker.done;
    await entered.promise;
    await stop(owner.missionId);
    expect(getSqlite().prepare('SELECT state FROM storage_admission_reservations WHERE reservation_id = ?').pluck()
      .get(owner.lease!.receipt.reservationId)).toBe('reserved');
  } finally {
    blocker.release();
    release.resolve();
    await blocker.done;
    expect(await creation).toBeInstanceOf(Error);
    await owner.admission.settleFailedLaunch(owner.candidate, owner.lease!);
  }
  expect(getSqlite().prepare('SELECT state FROM storage_admission_reservations WHERE reservation_id = ?').pluck()
    .get(owner.lease!.receipt.reservationId)).toBe('released');
}, 120_000);

afterAll(async () => {
  await shutdownWarmPacketWorktrees();
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
}, 120_000);
