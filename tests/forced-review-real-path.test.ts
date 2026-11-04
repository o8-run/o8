import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const seams = vi.hoisted(() => ({ interrupt: vi.fn(), verify: vi.fn(), fresh: vi.fn(), capture: vi.fn() }));
vi.mock('@/lib/ws-server/next-fetch', () => ({ fetchRuntimeAction: seams.interrupt }));
vi.mock('@/lib/supervisor/completion-verification', async (original) => ({
  ...await original<typeof import('@/lib/supervisor/completion-verification')>(), runCompletionVerification: seams.verify,
}));
vi.mock('@/lib/supervisor/self-review-stall-guard', async (original) => ({
  ...await original<typeof import('@/lib/supervisor/self-review-stall-guard')>(), hasFreshSelfReviewTranscriptActivity: seams.fresh,
}));
vi.mock('@/lib/orchestrator/context-relay', () => ({ capturePacketCompletionContext: seams.capture }));
vi.mock('@/lib/lane/terminal-lane-cleanup', () => ({ scheduleTerminalLaneCleanup: vi.fn() }));
vi.mock('@/lib/lane/worktree-cleanup', () => ({ pruneRepoWorktrees: vi.fn(async () => []) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-forced-review-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const roots = [dataDir];
const { closeDb } = await import('@/lib/db');
const { createLane, getLane, updateLane, appendEvent } = await import('@/lib/lane/registry');
const control = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState, packetReleaseBlockedBy } = await import('@/lib/orchestrator/store');
const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
const { forceSelfReviewToReview } = await import('@/lib/supervisor/force-self-review');
let sequence = 0;
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-force-review-git-'));
  roots.push(root);
  const id = `force-review-${++sequence}`;
  git(root, 'init', '-qb', 'main');
  git(root, 'config', 'user.name', 'o8-test');
  git(root, 'config', 'user.email', 'test@example.test');
  writeFileSync(join(root, 'work.txt'), 'base');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-qb', `inline/${id}`);
  writeFileSync(join(root, 'work.txt'), 'preserve this work');
  const lane = createLane({ repoPath: root, worktreePath: root, branch: `inline/${id}`,
    baseBranch: 'main', runtime: 'codex', packetId: id, sessionKey: `codex-owned:${id}` });
  updateLane(lane.id, { status: 'running' }, 'system');
  const packet: OrchestratorPacket = { id, referenceLabel: id, title: 'Source work', summary: 'fixture',
    // A durable queue hold supersedes completion before preservation starts.
    workspaceTargetPath: root, branchTarget: lane.branch, runtime: 'codex', status: 'running', queueState: 'queued',
    releaseState: 'pending', dependencyLabels: [], dependencyPacketIds: [], attemptCount: 1,
    lane: { laneId: lane.id, tileId: lane.id, tabId: lane.id, sessionKey: lane.sessionKey,
      repoPath: root, worktreePath: root, runtime: 'codex' } };
  control.writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${id}`, repoPath: root, packets: [packet, { ...packet, id: `${id}-next`,
      referenceLabel: `${id}-next`, title: 'Dependent work', lane: null, status: 'queued', queueState: 'queued',
      dependencyPacketIds: [id] }] });
  const dependencies = { park: vi.fn(async () => {}), unregister: vi.fn(), enqueueAutoReview: vi.fn(async () => {}),
    triggerHeadlessSprintTick: vi.fn(runHeadlessSprintTick), queueReviewContinuation: vi.fn(), broadcastUpdate: vi.fn(), escalate: vi.fn() };
  const run = () => forceSelfReviewToReview(lane.sessionKey!, getLane(lane.id)!, { kind: 'force-review',
    reason: 'fixture stall', idleMs: 100_000, cwd: root,
    verification: { typecheckPassed: true, lintPassed: true, selfReviewLikely: true } }, dependencies);
  return { root, base, lane, dependencies, run };
}
beforeEach(() => {
  seams.interrupt.mockReset().mockResolvedValue({ ok: true });
  seams.verify.mockReset().mockResolvedValue({ ok: true, kind: 'typecheck', output: '' });
  seams.fresh.mockReset().mockResolvedValue(false);
  seams.capture.mockReset().mockResolvedValue({});
});
afterAll(() => { closeDb(); for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true }); });

describe('forced review through the server production handler', () => {
  it('preserves real dirty work, moves it to review, and leaves the next job blocked', async () => {
    const f = fixture();
    // The handler's own interrupt may emit an exit, but that is not a new turn.
    seams.interrupt.mockImplementationOnce(async () => { appendEvent(f.lane.id, 'runtime_process_exit', 'system', {}); });
    await f.run();
    expect(seams.interrupt).toHaveBeenCalledOnce();
    expect(git(f.root, 'status', '--porcelain')).toBe('');
    expect(git(f.root, 'rev-parse', 'HEAD')).not.toBe(f.base);
    expect(git(f.root, 'rev-parse', 'main')).toBe(f.base);
    expect(getLane(f.lane.id)).toMatchObject({ status: 'reviewing', sessionKey: null });
    const state = control.readOrchestratorControlPlaneState();
    expect(state.packets[0]).toMatchObject({ releaseState: 'pending', releaseStatePayload: null });
    expect(packetReleaseBlockedBy(state.packets[1], state.packets)?.id).toBe(state.packets[0].id);
    expect(f.dependencies.triggerHeadlessSprintTick).toHaveBeenCalledWith();
    expect(f.dependencies.enqueueAutoReview).toHaveBeenCalledWith(f.lane.id);
  });

  it('keeps the runtime bound when interrupt fails and never queues review or release', async () => {
    const f = fixture();
    seams.interrupt.mockRejectedValueOnce(new Error('interrupt unavailable'));
    await f.run();
    expect(seams.interrupt).toHaveBeenCalledOnce();
    expect(git(f.root, 'status', '--porcelain')).toBe('');
    expect(getLane(f.lane.id)).toMatchObject({ status: 'running', sessionKey: f.lane.sessionKey });
    expect(f.dependencies.unregister).not.toHaveBeenCalled();
    expect(f.dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(f.dependencies.triggerHeadlessSprintTick).not.toHaveBeenCalled();
    expect(control.readOrchestratorControlPlaneState().packets[0].releaseState).toBe('pending');
  });

  it.each(['verify', 'context', 'interrupt'] as const)('yields when a new steer arrives during %s', async (stage) => {
    const f = fixture();
    const action = async () => {
      appendEvent(f.lane.id, 'steered_packet', 'user', { message: 'new work' });
      return { ok: true, kind: 'typecheck', output: '' };
    };
    const seam = ({ verify: seams.verify, context: seams.capture, interrupt: seams.interrupt })[stage];
    seam.mockImplementationOnce(action);
    await f.run();
    expect(seam).toHaveBeenCalledOnce();
    expect(getLane(f.lane.id)).toMatchObject({ status: 'running', sessionKey: f.lane.sessionKey });
    expect(f.dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(f.dependencies.triggerHeadlessSprintTick).not.toHaveBeenCalled();
  });

  it('preserves a durable Stop that arrives during verification', async () => {
    const f = fixture();
    seams.verify.mockImplementationOnce(async () => {
      await control.withLockedState((state) => { state.packets[0].operatorStopped = true; });
      return { ok: true, kind: 'typecheck', output: '' };
    });
    await f.run();
    expect(seams.verify).toHaveBeenCalledOnce();
    expect(seams.interrupt).not.toHaveBeenCalled();
    expect(f.dependencies.enqueueAutoReview).not.toHaveBeenCalled();
    expect(control.readOrchestratorControlPlaneState().packets[0].operatorStopped).toBe(true);
  });
});
