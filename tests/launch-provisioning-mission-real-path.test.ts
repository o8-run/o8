import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const boundary = vi.hoisted(() => ({
  wedge: false,
  invalidateLane: false,
  humanDecision: false,
  spoofManifestReceipt: false,
  preparedPaths: [] as string[],
  refuseStorage: false,
  launch: vi.fn(async () => ({ ok: true, sessionKey: 'codex-owned:fixture', note: 'fixture launch' })),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => undefined) }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => undefined) }));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: vi.fn(async () => undefined) }));
vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/',
    availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null })),
}));

const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'launch-provisioning-'));
const repoPath = join(root, 'repo');
const bin = join(root, 'bin');
const failureReceipt = join(root, 'failure.json');
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const fixtureInputs = ['requirements.txt', 'go.mod', 'Cargo.toml'];
vi.stubEnv('O8_WORKTREE_ROOT', join(root, 'worktrees'));
vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
const registry = await import('@/lib/lane/registry');
const control = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getSqlite, closeDb } = await import('@/lib/db');
const dispatchRoute = await import('@/app/api/orchestrator/dispatch/route');
const statusRoute = await import('@/app/api/orchestrator/status/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');

beforeAll(async () => {
  mkdirSync(repoPath);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  writeFileSync(join(repoPath, 'README.md'), 'launch provisioning fixture\n');
  git('add', 'README.md');
  git('-c', 'user.email=test@o8.invalid', '-c', 'user.name=o8-test', 'commit', '-m', 'init');
  const origin = join(root, 'origin.git');
  execFileSync('git', ['clone', '--bare', repoPath, origin], { stdio: 'pipe' });
  git('remote', 'add', 'origin', origin);
  git('fetch', 'origin');
  mkdirSync(bin);
  for (const command of ['git', 'pip', 'go', 'cargo']) {
    const executable = join(bin, command);
    writeFileSync(executable, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `const receipt = ${JSON.stringify(failureReceipt)};`,
      `const command = ${JSON.stringify(command)};`,
      'const args = process.argv.slice(2);',
      "const failure = fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8')) : {};",
      "if (failure.command === command && (command !== 'git' || args.includes('add') && args.includes('worktree'))) {",
      "  if (command !== 'git') { fs.mkdirSync('partial-dependencies', { recursive: true }); fs.writeFileSync('partial-dependencies/partial', 'incomplete'); }",
      '  fs.writeFileSync(receipt, JSON.stringify({ ...failure, failedAt: Date.now(), attempts: (failure.attempts ?? 0) + 1 }));',
      "  console.error('fixture ' + command + ' provisioning refused'); process.exit(42);",
      '}',
      ...(command === 'git' ? [
        `const result = require('node:child_process').spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });`,
        'process.exit(result.status ?? 1);',
      ] : ['process.exit(0);']),
    ].join('\n'));
    chmodSync(executable, 0o755);
  }
  vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const { WorktreeManager } = await import('@/lib/worktree/manager');
  const create = WorktreeManager.prototype.create;
  vi.spyOn(WorktreeManager.prototype, 'create').mockImplementation(async function (this: InstanceType<typeof WorktreeManager>, opts) {
    if (boundary.refuseStorage) {
      writeFileSync(failureReceipt, JSON.stringify({ failedAt: Date.now(), attempts: 1 }));
      // Refuse the scheduler's proof at the real materialization admission gate.
      getSqlite().prepare('UPDATE storage_admission_reservations SET lease_expires_at = 0 WHERE reservation_id = ?')
        .run(opts.storageAdmissionReservationId);
    }
    return create.call(this, opts);
  });
  // Pause at the real manager's last setup boundary, before it publishes ready.
  const prototype = WorktreeManager.prototype as unknown as {
    resetTrackedWorkspaceChanges(path: string): Promise<void>;
  };
  const reset = prototype.resetTrackedWorkspaceChanges;
  vi.spyOn(prototype, 'resetTrackedWorkspaceChanges').mockImplementation(async function (this: typeof prototype, path: string) {
    await reset.call(this, path);
    boundary.preparedPaths.push(path);
    const packetId = control.readOrchestratorControlPlaneState().packets[0]!.id;
    const lane = registry.findLatestLaneByPacket(packetId)!;
    if (boundary.wedge) {
      const { enforceWedgeTimeouts, WEDGE_LAUNCHING_MS } = await import('@/lib/lane/wedge-timeouts');
      enforceWedgeTimeouts(Date.now() + WEDGE_LAUNCHING_MS + 1000);
    }
    if (boundary.invalidateLane) registry.setLaneStatus(lane.id, 'awaiting_orchestrator', 'system', 'launch_stalled');
    if (boundary.humanDecision) registry.setLaneStatus(lane.id, 'awaiting_human', 'user', 'operator_review');
    if (boundary.spoofManifestReceipt) {
      for (let heartbeat = 0; heartbeat < 501; heartbeat += 1) {
        registry.appendEvent(lane.id, 'worktree_provision_queued', 'system', { packetId, position: 1 });
      }
      registry.appendEvent(lane.id, 'workspace_manifest_applied', 'orchestrator', { state: 'completed' });
    }
  });
  const { getRuntime } = await import('@/lib/runtimes');
  vi.spyOn(getRuntime('codex')!, 'launch').mockImplementation(boundary.launch);
  boundary.launch.mockImplementation(async () => ({ ok: true, sessionKey: 'codex-owned:fixture', note: 'fixture launch' }));
});
afterEach(() => {
  boundary.wedge = false;
  boundary.invalidateLane = false;
  boundary.humanDecision = false;
  boundary.spoofManifestReceipt = false;
  boundary.refuseStorage = false;
  rmSync(failureReceipt, { force: true });
  for (const input of fixtureInputs) rmSync(join(repoPath, input), { force: true });
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

function persistMission(id: string) {
  const packet: OrchestratorPacket = {
    id, referenceLabel: 'inline-1', title: id, summary: 'exercise launch provisioning',
    workspaceTargetPath: repoPath, branchTarget: `inline/${id}`, runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending',
    status: 'queued', blockedReason: null, lane: null,
  };
  control.writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${id}`, repoPath, runtime: 'codex', packets: [packet] });
  return packet;
}
async function dispatch(packet: OrchestratorPacket) {
  const response = await dispatchRoute.POST(new NextRequest('http://localhost/api/orchestrator/dispatch', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getOrCreateWsToken()}` },
    body: JSON.stringify({ missionId: `mission-${packet.id}`, wait: true }),
  }));
  expect(response.status).toBe(200);
}
async function status(packet: OrchestratorPacket) {
  const response = await statusRoute.GET(new NextRequest(`http://localhost/api/orchestrator/status?missionId=mission-${packet.id}`, { headers: { Authorization: `Bearer ${getOrCreateWsToken()}` } }));
  expect(response.status).toBe(200);
  return (await response.json()).result.packets[0] as OrchestratorPacket;
}

async function callerStatuses(packet: OrchestratorPacket) {
  const priorFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(url)).pathname === '/api/orchestrator/status') {
      return statusRoute.GET(new NextRequest(String(url), { headers: init?.headers }));
    }
    return new Response('{}', { status: 200 });
  }));
  vi.stubEnv('O8_API_TOKEN', getOrCreateWsToken());
  const packets: OrchestratorPacket[] = [];
  try {
    const { handleGetMissionStatus } = await import('@/lib/mcp/operator-handlers/mission');
    const mcp = await handleGetMissionStatus({ missionId: `mission-${packet.id}` });
    const content = mcp.content[0] as { text: string };
    packets.push(JSON.parse(content.text).packets[0]);
    const { runMission } = await import('../cli/src/commands/mission');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await runMission({ human: false, verbose: false }, 'status', ['--mission', `mission-${packet.id}`])).toBe(0);
      packets.push(JSON.parse(output.mock.calls.map(([chunk]) => String(chunk)).join('')).status.packets[0]);
    } finally { output.mockRestore(); }
    return packets;
  } finally { vi.stubGlobal('fetch', priorFetch); }
}

describe('launch provisioning through mission HTTP entry points', () => {
  it.each([
    ['git', null], ['pip', 'requirements.txt'],
    ['go', 'go.mod'], ['cargo', 'Cargo.toml'], ['storage', null],
  ] as const)('surfaces %s provisioning refusal on one poll without relaunching', async (command, input) => {
    for (const file of fixtureInputs) rmSync(join(repoPath, file), { force: true });
    if (input) writeFileSync(join(repoPath, input), 'fixture\n');
    const git = (...args: string[]) => execFileSync(realGit, args, { cwd: repoPath, stdio: 'pipe' });
    git('add', '-A');
    git('-c', 'user.email=test@o8.invalid', '-c', 'user.name=o8-test', 'commit', '--allow-empty', '-m', `fixture ${command}`);
    git('push', 'origin', 'main');
    writeFileSync(failureReceipt, JSON.stringify({ command }));
    boundary.refuseStorage = command === 'storage';
    const packet = persistMission(`provisioning-failure-${command}`);
    const launches = boundary.launch.mock.calls.length;
    await dispatch(packet);
    const polled = await status(packet);
    const callers = await callerStatuses(packet);
    const firstPollMs = Date.now() - JSON.parse(readFileSync(failureReceipt, 'utf8')).failedAt;
    const lane = registry.findLatestLaneByPacket(packet.id)!;
    process.stdout.write(`[provisioning-refusal] ${JSON.stringify({ command, firstPollMs, status: polled.status, visible: Boolean(polled.blockedReason), launches: boundary.launch.mock.calls.length - launches })}\n`);
    expect.soft(firstPollMs).toBeLessThan(5_000);
    expect.soft(polled.status).toBe('failed');
    expect.soft(polled.blockedReason).toContain(command === 'storage' ? 'storage admission proof' : `fixture ${command} provisioning refused`);
    for (const caller of callers) {
      expect.soft(caller.status).toBe('failed');
      expect.soft(caller.blockedReason).toBe(polled.blockedReason);
    }
    expect.soft(lane.status).toBe('failed');
    expect.soft(boundary.launch).toHaveBeenCalledTimes(launches);
    expect.soft(getSqlite().prepare('SELECT state FROM storage_admission_reservations WHERE owner_id = ?').pluck().get(packet.id)).toBe('released');
    const { getWorktreeManager } = await import('@/lib/worktree');
    expect.soft((await getWorktreeManager(repoPath).list()).some((entry) => entry.branch === packet.branchTarget)).toBe(false);
    const { managedPacketWorktreeId, resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
    const base = resolveWorktreeRootLayout(repoPath).primaryBase;
    expect.soft(readdirSync(base).filter((entry) => entry.startsWith(managedPacketWorktreeId(packet.id)!))).toEqual([]);
    const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
    await runDispatchTick(control.readOrchestratorControlPlaneState());
    const { enforceWedgeTimeouts } = await import('@/lib/lane/wedge-timeouts');
    enforceWedgeTimeouts(Date.now() + 70 * 60_000);
    expect.soft((await status(packet)).status).toBe('failed');
    expect.soft(JSON.parse(readFileSync(failureReceipt, 'utf8')).attempts).toBe(1);
    expect(boundary.launch).toHaveBeenCalledTimes(launches);
  }, 120_000);

  it('finishes the same fresh launch when only its provisioning watchdog has escalated', async () => {
    boundary.wedge = true;
    const packet = persistMission('provisioning-watchdog');
    await dispatch(packet);
    const lane = registry.findLatestLaneByPacket(packet.id)!;
    const failure = registry.getLaneEvents(lane.id, 200).find((event) => event.verb === 'worktree_provision_failed');
    expect(failure?.payload.cause).toBeUndefined();
    expect(lane).toMatchObject({ status: 'running', sessionKey: 'codex-owned:fixture' });
    expect((await status(packet)).status).toBe('running');
    expect(boundary.launch).toHaveBeenCalledTimes(1);
    boundary.wedge = false;
  }, 120_000);

  it('does not let older lane history invalidate a new dispatch attempt', async () => {
    const packet = persistMission('provisioning-history');
    const lane = registry.createLane({ repoPath, branch: packet.branchTarget, packetId: packet.id, runtime: 'codex',
      baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim() });
    for (let index = 0; index < 501; index += 1) registry.appendEvent(lane.id, 'update', 'system', { priorAttempt: index });
    await dispatch(packet);
    expect(registry.getLane(lane.id)?.status).toBe('running');
    expect((await status(packet)).status).toBe('running');
  }, 120_000);

  it('keeps a human decision final and rolls back preparation without starting a provider', async () => {
    boundary.wedge = true;
    boundary.humanDecision = true;
    const packet = persistMission('provisioning-human-decision');
    const launches = boundary.launch.mock.calls.length;
    await dispatch(packet);
    expect(registry.findLatestLaneByPacket(packet.id)).toMatchObject({ status: 'awaiting_human', lastEventLabel: 'operator_review' });
    expect(boundary.launch).toHaveBeenCalledTimes(launches);
    expect(existsSync(boundary.preparedPaths.at(-1)!)).toBe(false);
    expect(getSqlite().prepare('SELECT state FROM storage_admission_reservations WHERE owner_id = ?').pluck().get(packet.id)).toBe('released');
    expect(await status(packet)).toMatchObject({ status: 'blocked', queueState: 'held', blockedReason: expect.stringContaining('exact unbound pre-launch lane') });
  }, 120_000);

  it('rolls back the exact checkout and reservation when provisioning loses its lane', async () => {
    boundary.wedge = false;
    boundary.invalidateLane = true;
    const packet = persistMission('provisioning-refusal');
    await dispatch(packet);
    const lane = registry.findLatestLaneByPacket(packet.id)!;
    expect(lane.status).toBe('failed');
    expect(existsSync(boundary.preparedPaths.at(-1)!)).toBe(false);
    expect(getSqlite().prepare('SELECT state FROM storage_admission_reservations WHERE owner_id = ?').pluck().get(packet.id)).toBe('released');
    const polled = await status(packet);
    expect(polled.status).toBe('failed');
    expect(polled.blockedReason).toContain('exact unbound pre-launch lane');
    boundary.invalidateLane = false;
  }, 120_000);

  it('exposes both orchestrator and human escalation on the next status poll from persisted queued state', async () => {
    const packet = persistMission('provisioning-escalation');
    const lane = registry.createLane({ repoPath, branch: packet.branchTarget, packetId: packet.id, runtime: 'codex' });
    for (const state of ['awaiting_orchestrator', 'awaiting_human'] as const) {
      registry.setLaneStatus(lane.id, state, 'system', state === 'awaiting_orchestrator' ? 'launch_stalled' : 'orchestrator_wedge_timeout');
      const polled = await status(packet);
      expect(polled.status).toBe('blocked');
      expect(polled.queueState).toBe('held');
      expect(polled.blockedReason).toContain(state === 'awaiting_orchestrator' ? 'launch_stalled' : 'orchestrator_wedge_timeout');
      for (const caller of await callerStatuses(packet)) {
        expect(caller).toMatchObject({ status: 'blocked', queueState: 'held', blockedReason: polled.blockedReason });
      }
    }
  });

  it('retains the provisioning cause for callers after the recent event window advances', async () => {
    boundary.invalidateLane = true;
    const packet = persistMission('provisioning-durable-cause');
    const launches = boundary.launch.mock.calls.length;
    await dispatch(packet);
    const lane = registry.findLatestLaneByPacket(packet.id)!;
    // Late progress receipts must not hide the durable failure from a queued snapshot.
    for (let index = 0; index < 101; index += 1) {
      registry.appendEvent(lane.id, 'update', 'system', { progressReceipt: index });
    }
    persistMission(packet.id);
    for (const polled of [await status(packet), ...await callerStatuses(packet)]) {
      expect.soft(polled.status).toBe('failed');
      expect.soft(polled.blockedReason).toContain('exact unbound pre-launch lane');
    }
    expect(lane.status).toBe('failed');
    expect(existsSync(boundary.preparedPaths.at(-1)!)).toBe(false);
    expect(getSqlite().prepare('SELECT state FROM storage_admission_reservations WHERE owner_id = ?').pluck().get(packet.id)).toBe('released');
    expect(boundary.launch).toHaveBeenCalledTimes(launches);
  }, 120_000);

  it.each(['applied', 'failed', 'skipped', 'watchdog', 'human', 'spoofed'] as const)(
    'preserves launch authority with a manifest outcome: %s', async (outcome) => {
      const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
      const { readWorkspaceManifestReceipt } = await import('@/lib/workspace/manifest');
      await updateOperatorDefaults({ workspaceManifestPolicy: outcome === 'skipped' ? 'disabled' : 'auto' });
      writeFileSync(join(repoPath, 'o8.workspace.json'), JSON.stringify({
        version: 1,
        setup: outcome === 'failed' ? ['exit 1'] : [],
      }));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
      git('add', 'o8.workspace.json');
      git('-c', 'user.email=test@o8.invalid', '-c', 'user.name=o8-test', 'commit', '--allow-empty', '-m', `manifest ${outcome}`);
      git('push', 'origin', 'main');
      boundary.wedge = outcome === 'watchdog' || outcome === 'human';
      boundary.humanDecision = outcome === 'human';
      boundary.spoofManifestReceipt = outcome === 'spoofed';
      const packet = persistMission(`provisioning-manifest-${outcome}`);
      const launches = boundary.launch.mock.calls.length;
      await dispatch(packet);
      const lane = registry.findLatestLaneByPacket(packet.id)!;
      const expectedVerb = outcome === 'failed'
        ? 'workspace_manifest_failed'
        : outcome === 'skipped' ? 'workspace_manifest_skipped' : 'workspace_manifest_applied';
      expect(registry.getLaneEvents(lane.id, 1000)).toContainEqual(expect.objectContaining({
        verb: expectedVerb, actor: 'system',
      }));
      if (outcome === 'human' || outcome === 'spoofed') {
        expect(boundary.launch).toHaveBeenCalledTimes(launches);
        expect(existsSync(boundary.preparedPaths.at(-1)!)).toBe(false);
        expect((await status(packet)).blockedReason).toContain('exact unbound pre-launch lane');
        if (outcome === 'human') {
          expect(lane).toMatchObject({ status: 'awaiting_human', lastEventLabel: 'operator_review' });
        }
      } else {
        expect(boundary.launch).toHaveBeenCalledTimes(launches + 1);
        expect(lane).toMatchObject({ status: 'running', sessionKey: 'codex-owned:fixture' });
        expect((await status(packet)).status).toBe('running');
        const receipt = await readWorkspaceManifestReceipt(lane.worktreePath!);
        if (outcome === 'skipped') expect(receipt).toBeNull();
        else expect(receipt).toMatchObject({ state: outcome === 'failed' ? 'failed' : 'completed' });
        registry.setLaneStatus(lane.id, 'failed', 'system', 'fixture complete');
      }
    }, 120_000,
  );
});
