import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const launches = vi.hoisted(() => vi.fn(async () => { throw new Error('fixture launch boundary'); }));
vi.mock('@/lib/orchestrator/dispatch-packet-launch', () => ({ launchPacketWithStorageAdmission: launches }));
const root = mkdtempSync(join(tmpdir(), 'o8-backpressure-'));
process.env.CORTEX_IDE_DATA_DIR = root;
process.env.O8_DATA_DIR = root;
const repoPath = join(root, 'repo');
mkdirSync(repoPath);
execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
writeFileSync(join(repoPath, 'fixture.txt'), 'fixture\n');
execFileSync('git', ['add', 'fixture.txt'], { cwd: repoPath });
execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'], { cwd: repoPath });
const { getSqlite, closeDb } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const route = await import('@/app/api/orchestrator/status/route');
function packet(id: string): OrchestratorPacket {
  return { id, referenceLabel: id, title: id, summary: id, workspaceTargetPath: repoPath, branchTarget: id,
    runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending', status: 'queued', lane: null };
}
function seed(count = 4) {
  const packets = [packet('new-work'), { ...packet('stopped'), operatorStopped: true },
    { ...packet('held'), queueState: 'held' as const, holdIntent: 'operator' as const }];
  for (let i = 0; i < count; i++) {
    const p = { ...packet(`review-${i}`), status: 'awaiting_review' as const };
    packets.push(p);
    const lane = createLane({ repoPath, worktreePath: repoPath, packetId: p.id, branch: p.id, runtime: 'codex' });
    getSqlite().prepare("UPDATE lanes SET status = 'reviewing' WHERE id = ?").run(lane.id);
    getSqlite().prepare(`INSERT INTO review_queue (id, lane_id, repo_path, status, attempts, head_sha, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, datetime('now', '-10 minutes'), datetime('now'))`).run(p.id, lane.id, repoPath, 'a'.repeat(40));
  }
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'backpressure', repoPath, packets });
}
async function tick() {
  const next = await runDispatchTick(readOrchestratorControlPlaneState(), { force: true, launchBudget: { maxLaunches: 1 } });
  writeOrchestratorControlPlaneState(next);
  closeDb();
  return next;
}
async function status() {
  const response = await route.GET(new NextRequest('http://localhost/api/orchestrator/status?missionId=backpressure',
    { headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}` } }));
  expect(response.status).toBe(200);
  return (await response.json()).result;
}
beforeEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', async () => Response.json({ ok: true }));
  process.env.O8_REVIEW_BACKPRESSURE = '{"high":3,"low":1}';
  getSqlite().exec('DELETE FROM review_queue; DELETE FROM lane_events; DELETE FROM lanes; DELETE FROM app_state;');
  launches.mockClear();
});
afterAll(() => { delete process.env.O8_REVIEW_BACKPRESSURE; vi.unstubAllGlobals(); closeDb(); rmSync(root, { recursive: true, force: true }); });

it('holds new dispatch above high, persists through reopen, and releases only at low through route and MCP reads', async () => {
  seed();
  await tick();
  expect(launches).not.toHaveBeenCalled();
  let result = await status();
  expect(result.packets.find((p: OrchestratorPacket) => p.id === 'new-work').blockedReason).toContain('Review backlog:');
  expect(result.backpressure).toMatchObject({ state: 'held', depth: 4, high: 3, low: 1 });
  expect(result.backpressure.oldestWaitMs).toBeGreaterThanOrEqual(10 * 60_000);
  getSqlite().prepare("UPDATE review_queue SET status = 'completed' WHERE id IN ('review-0', 'review-1')").run();
  getSqlite().prepare("UPDATE lanes SET status = 'completed' WHERE packet_id IN ('review-0', 'review-1')").run();
  await tick();
  expect(launches).not.toHaveBeenCalled();
  expect((await status()).backpressure).toMatchObject({ state: 'held', depth: 2 });
  getSqlite().prepare("UPDATE review_queue SET status = 'completed' WHERE id = 'review-2'").run();
  getSqlite().prepare("UPDATE lanes SET status = 'completed' WHERE packet_id = 'review-2'").run();
  await tick();
  expect(launches).toHaveBeenCalledTimes(1);
  result = await status();
  expect(result.backpressure).toMatchObject({ state: 'open', depth: 1 });
  expect(result.packets.find((p: OrchestratorPacket) => p.id === 'stopped').status).toBe('queued');
  expect(result.packets.find((p: OrchestratorPacket) => p.id === 'held').queueState).toBe('held');
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    if (new URL(String(input)).pathname !== '/api/orchestrator/status') return Response.json({ ok: true });
    return route.GET(new NextRequest('http://localhost/api/orchestrator/status?missionId=backpressure', { headers: init?.headers }));
  });
  const { handleGetMissionStatus } = await import('@/lib/mcp/operator-handlers/mission');
  const mcp = await handleGetMissionStatus({ missionId: 'backpressure' });
  expect(mcp.isError).not.toBe(true);
  expect(JSON.parse(mcp.content[0].type === 'text' ? mcp.content[0].text : '{}').backpressure.state).toBe('open');
  process.env.O8_API_TOKEN = getOrCreateWsToken();
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    const { runMission } = await import('../cli/src/commands/mission');
    expect(await runMission({ human: false, verbose: false }, 'status', ['--mission', 'backpressure'])).toBe(0);
    expect(output.mock.calls.some(([text]) => String(text).includes('o8/review-backpressure/v1'))).toBe(true);
  } finally { output.mockRestore(); delete process.env.O8_API_TOKEN; }

});

it('does not change dispatch defaults and fails closed on malformed configured or persisted policy', async () => {
  seed();
  delete process.env.O8_REVIEW_BACKPRESSURE;
  await tick();
  expect(launches).toHaveBeenCalledTimes(1);
  expect((await status()).backpressure.state).toBe('disabled');
  launches.mockClear();
  seed(0);
  process.env.O8_REVIEW_BACKPRESSURE = '{"high":1,"low":1}';
  await tick();
  expect(launches).not.toHaveBeenCalled();
  expect((await status()).backpressure).toMatchObject({ state: 'unknown', reason: expect.stringContaining('operator inspection') });
  process.env.O8_REVIEW_BACKPRESSURE = '{"high":3,"low":1}';
  getSqlite().prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('review_backpressure/v1', 'broken', 0)").run();
  await tick();
  expect(launches).not.toHaveBeenCalled();
  getSqlite().prepare("DELETE FROM app_state WHERE key = 'review_backpressure/v1'").run();
  getSqlite().prepare("INSERT INTO app_state (key, value, updated_at) VALUES ('review_scheduling/v1', 'broken', 0)").run();
  await tick();
  expect(launches).not.toHaveBeenCalled();
  expect((await status()).backpressure.state).toBe('unknown');
});

it('includes integration and retains active work, correction and external review admission', async () => {
  seed();
  getSqlite().prepare("DELETE FROM review_queue WHERE id = 'review-0'").run();
  getSqlite().prepare("UPDATE lanes SET status = 'merging' WHERE packet_id = 'review-0'").run();
  const state = readOrchestratorControlPlaneState();
  state.packets.push({ ...packet('running'), status: 'running' });
  writeOrchestratorControlPlaneState(state);
  await tick();
  expect((await status()).backpressure).toMatchObject({ depth: 4, reviewDepth: 3, integrationDepth: 1,
    availableReviewCapacity: null, capacityStatus: 'unknown', oldestWaitMs: expect.any(Number) });
  expect(readOrchestratorControlPlaneState().packets.find(p => p.id === 'running')?.status).toBe('running');
  const { isNewImplementation } = await import('@/lib/orchestrator/review-backpressure');
  expect(isNewImplementation({ ...packet('correction'), status: 'recovering' })).toBe(false);
  expect(isNewImplementation({ ...packet('read'), launchContext: { source: 'cli', presentation: 'split', repoContext: 'transient', workMode: 'read-only' } })).toBe(false);
});

it('claims with dependency priority, bounded project fairness, aging and durable ownership across reopen', async () => {
  seed();
  const { createProject } = await import('@/lib/projects/store');
  const a = createProject({ name: 'A' });
  const b = createProject({ name: 'B' });
  getSqlite().prepare('UPDATE lanes SET project_id = ?').run(a.id);
  getSqlite().prepare("UPDATE lanes SET project_id = ? WHERE packet_id = 'review-3'").run(b.id);
  getSqlite().prepare("UPDATE review_queue SET created_at = datetime('now'), updated_at = datetime('now')").run();
  const state = readOrchestratorControlPlaneState();
  state.packets.push({ ...packet('dependent'), dependencyPacketIds: ['review-2'] });
  writeOrchestratorControlPlaneState(state);
  const { claimNextReview } = await import('@/lib/lane/review-drain-recovery');
  const { markReviewDeferred, markReviewCompleted } = await import('@/lib/lane/review-queue-settlement');
  const first = claimNextReview()!;
  // Project identifiers are generated, so warm the other project if it wins the deterministic tie.
  const priority = first.id === 'review-3' ? claimNextReview()! : first;
  expect(priority.id).toBe('review-2');
  expect(markReviewDeferred({ reviewId: priority.id, claimOwner: priority.claim_owner, laneId: priority.lane_id, reason: 'retry fixture' })).toBe(true);
  if (first.id === 'review-3') markReviewCompleted({ reviewId: first.id, claimOwner: first.claim_owner });
  closeDb();
  const next = claimNextReview()!;
  if (first.id !== 'review-3') expect(next.id).toBe('review-3');
  expect(markReviewCompleted({ reviewId: priority.id, claimOwner: priority.claim_owner })).toBe(false);
  getSqlite().prepare("UPDATE review_queue SET updated_at = datetime('now', '-6 minutes') WHERE id = 'review-0'").run();
  markReviewCompleted({ reviewId: next.id, claimOwner: next.claim_owner });
  const aged = claimNextReview()!;
  expect(aged.id).toBe('review-0');
  const concurrent = await Promise.all([Promise.resolve().then(() => claimNextReview()), Promise.resolve().then(() => claimNextReview())]);
  const ids = concurrent.filter(c => c !== null).map(c => c!.id);
  expect(new Set([aged.id, ...ids]).size).toBe(ids.length + 1);
  expect(claimNextReview()).toBeNull(); // three durable active leases are the fixed ceiling
  const { setLaneStatus } = await import('@/lib/lane/registry');
  setLaneStatus(aged.lane_id, 'paused', 'user', 'operator_stopped');
  const projection = (await status()).backpressure;
  expect(projection.measurements.observedOperatorInterventions).toBe(1);
  expect(projection.measurements.queueWait.samples).toBeGreaterThan(0);
  expect(projection.measurements.queueWait.meanMs).toBeGreaterThan(0);
  expect(projection.activeReviews).toBeLessThanOrEqual(3);
});

it('holds through the dispatch POST route without launching a worker', async () => {
  seed();
  const { POST } = await import('@/app/api/orchestrator/dispatch/route');
  const response = await POST(new NextRequest('http://localhost/api/orchestrator/dispatch', {
    method: 'POST', headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ missionId: 'backpressure', force: true }),
  }));
  expect(response.status).toBe(200);
  expect(launches).not.toHaveBeenCalled();
  expect((await status()).packets.find((p: OrchestratorPacket) => p.id === 'new-work').blockedReason).toContain('Review backlog:');
});

it('serializes separate coordinator processes against the persisted reviewer ceiling', async () => {
  seed();
  closeDb();
  const run = promisify(execFile);
  const children = await Promise.allSettled(Array.from({ length: 2 }, () => run(process.execPath,
    ['--conditions=react-server', '--import', 'tsx', 'tests/fixtures/review-backpressure-claim.ts'],
    { cwd: process.cwd(), env: { ...process.env, CORTEX_IDE_DATA_DIR: root, O8_DATA_DIR: root }, timeout: 45_000 })));
  for (const child of children) if (child.status === 'rejected') throw child.reason;
  const claims = children.map(child => {
    if (child.status !== 'fulfilled') throw new Error('Coordinator fixture failed.');
    return JSON.parse(child.value.stdout.split('CLAIM:')[1].split('\n')[0]);
  });
  expect(claims[0].id).not.toBe(claims[1].id);
  expect(claims[0].claim_owner).not.toBe(claims[1].claim_owner);
  const { claimNextReview, isReviewClaimCurrent } = await import('@/lib/lane/review-drain-recovery');
  expect(claims.every(claim => isReviewClaimCurrent(claim))).toBe(true);
  expect(claimNextReview()).not.toBeNull();
  expect(claimNextReview()).toBeNull();
}, 60_000);

it('bounds policy work during ordinary status reads of a large backlog', async () => {
  seed(12);
  const policyModule = await import('@/lib/lane/effective-policy-read');
  const original = policyModule.readEffectivePolicy;
  let active = 0;
  let peak = 0;
  const observe = vi.spyOn(policyModule, 'readEffectivePolicy').mockImplementation(async id => {
    active++;
    peak = Math.max(peak, active);
    try { return await original(id); } finally { active--; }
  });
  try {
    const projection = (await status()).backpressure;
    expect(projection.waiting).toHaveLength(8);
    expect(projection.waitingTotal).toBe(12);
    expect(projection.waitingTruncated).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    expect(observe).toHaveBeenCalledTimes(8);
  } finally { observe.mockRestore(); }
});
