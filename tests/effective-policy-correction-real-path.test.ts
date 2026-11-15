import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-policy-correction-')));
process.env.O8_DATA_DIR = root;
process.env.CORTEX_IDE_DATA_DIR = root;
const repoPath = join(root, 'repo');
mkdirSync(repoPath);
function git(...args: string[]) { return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim(); }
git('init', '-q', '-b', 'main');
writeFileSync(join(repoPath, 'fixture.txt'), 'fixture\n');
writeFileSync(join(repoPath, 'vitest.config.ts'), 'export default { test: {} };\n');
git('add', 'fixture.txt', 'vitest.config.ts');
git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
const head = git('rev-parse', 'HEAD');
vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn(), notifyAllInBackground: vi.fn() }));
const registry = await import('@/lib/lane/registry');
const { createApproval, resolveApproval } = await import('@/lib/approvals/store');
const { closeDb } = await import('@/lib/db');
const { createProject } = await import('@/lib/projects/store');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { recordMission } = await import('@/lib/db/missions-store');
const project = createProject({ name: 'Policy correction fixture' });
let lane: ReturnType<typeof registry.createLane>;
let packet: OrchestratorPacket;
let sequence = 0;
function persist(mergeHold = false) {
  packet = { ...packet, mergeHold };
  const state = { ...createEmptyOrchestratorMissionState(), missionId: `mission-${packet.id}`, repoPath, packets: [packet] };
  writeOrchestratorControlPlaneState(state);
  closeDb();
  return state;
}
function risk(extra: Record<string, unknown> = {}) {
  registry.appendEvent(lane.id, 'review_risk_classified', 'system', {
    reviewedHeadSha: head, tier: 'standard', reasons: [], responsibleFiles: [],
    diffBase: { comparisonRef: head, mergeBase: head, usedFallback: false, warning: null }, ...extra,
  });
}
beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.O8_REVIEW_MODE;
  writeFileSync(join(root, 'settings.toml'), '[review]\nrequire_approval = "never"\n');
  const id = `pkt-policy-correction-${++sequence}`;
  lane = registry.createLane({ projectId: project.id, repoPath, worktreePath: repoPath, packetId: id, branch: 'main', runtime: 'codex', baseCommit: head });
  registry.updateLane(lane.id, { status: 'reviewing', sessionKey: `policy:${id}` });
  packet = { id, referenceLabel: id, workspaceTargetPath: repoPath, branchTarget: 'main', title: 'Policy', summary: 'Policy', runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending', status: 'awaiting_review', lane: null, orchestratorThreadId: id };
  persist();
  const approval = createApproval({ source: 'test', runtime: 'codex', agent: 'Fixture', sessionKey: `policy:${id}`, title: id,
    description: 'Reviewed fixture', summary: 'Reviewed fixture', risk: 'low', toolName: 'orchestrator_review',
    args: { packetId: id, approved: true, reviewedHeadSha: head, reviewTurnId: id, reviewTurnOutcome: 'completed' }, metadata: { Packet: id, laneId: lane.id } });
  resolveApproval(approval.id, 'approve', 'test');
  risk();
  closeDb();
});
afterAll(() => { vi.restoreAllMocks(); closeDb(); rmSync(root, { recursive: true, force: true }); });
async function read(id = lane.id, token: string | null = getOrCreateWsToken()) {
  const { GET } = await import('@/app/api/lanes/[id]/policy/route');
  return GET(new NextRequest(`http://localhost/api/lanes/${id}/policy`, { headers: { host: 'localhost', ...(token ? { authorization: `Bearer ${token}` } : {}) } }), { params: Promise.resolve({ id }) });
}
async function policy() { return (await read()).json(); }
async function held(source: string) {
  const value = await policy();
  expect(value.nextAction.value).toBe('human');
  expect(value.holds.value).toEqual(expect.arrayContaining([expect.objectContaining({ source, blocks: expect.any(Array) })]));
}
it('reaches PR preparation with a durable approved review at HEAD and documents the incomplete assessment', async () => {
  const value = await policy();
  expect(value.durableReview.value.approved).toBe(true);
  expect(value.nextAction.value).toBe('prepare_pull_request');
  expect(value).toMatchObject({ actor: 'orchestrator', headSha: head, comparisonRef: head, readAt: expect.any(String) });
  expect(value.unevaluatedControls).toEqual(expect.arrayContaining(['runMergeGate', 'file-size-limit', 'contract-coverage', 'run-preflight']));
  expect(value.correctionBounds.maximum).toMatchObject({ value: 2, precedence: 'constant' });
});
it('uses the execution approval policy when approval is always required', async () => {
  writeFileSync(join(root, 'settings.toml'), '[review]\nrequire_approval = "always"\n');
  const value = await policy();
  expect(value.nextAction.value).toBe('approval_required');
  expect(value.createPrApproval.value).toMatchObject({ requiresApproval: true, ruleId: 'lane-merge' });
});
for (const status of ['completed', 'archived', 'running'] as const) {
  it(`holds lane status ${status}`, async () => { registry.updateLane(lane.id, { status }); await held('lane-state'); });
}
it('allows a paused reviewed lane', async () => { registry.updateLane(lane.id, { status: 'paused' }); expect((await policy()).nextAction.value).toBe('prepare_pull_request'); });
it('holds a missing worktree', async () => { registry.updateLane(lane.id, { worktreePath: null }); await held('missing-worktree'); });
it('holds a lane with an existing PR', async () => { registry.updateLane(lane.id, { prNumber: 7 }); await held('existing-pull-request'); });
it('holds a PR whose lane has already merged', async () => { registry.updateLane(lane.id, { prNumber: 7, status: 'completed' }); await held('existing-pull-request'); });
it('holds a control-plane-only merge hold', async () => { persist(true); await held('merge-hold'); });
it('holds a registry-only merge hold', async () => {
  const state = { ...persist(), packets: [{ ...packet, mergeHold: true }] };
  recordMission({ id: state.missionId!, repoPath, runtime: 'codex', prompt: '', summary: '', constraints: '', packetMeta: [], missionState: state, totalWaves: 0 });
  await held('merge-hold');
});
it('holds a session no_merge rule', async () => {
  const { addSessionRule } = await import('@/lib/db/session-rules-store');
  addSessionRule(packet.id, 'Inspect before merging.', 'no_merge');
  await held('session-restriction');
});
it('uses the persisted high risk tier', async () => { risk({ tier: 'high', reasons: ['Fixture sensitive change'] }); await held('review-risk'); });
it('does not infer a tier for an unpinned risk event', async () => { risk({ reviewedHeadSha: null }); await held('review-risk-uncertain'); });
it('holds a fallback base recorded by review', async () => { risk({ diffBase: { comparisonRef: head, usedFallback: true, warning: 'Refresh failed' } }); await held('review-risk-uncertain'); });
it('holds a warning flag recorded by review', async () => {
  risk({ diffBase: { comparisonRef: head, mergeBase: head, usedFallback: false, warning: true } });
  await held('review-risk-uncertain');
});
it('holds a missing risk receipt', async () => {
  const { getSqlite } = await import('@/lib/db');
  getSqlite().prepare("DELETE FROM lane_events WHERE lane_id = ? AND verb = 'review_risk_classified'").run(lane.id);
  await held('review-risk-uncertain');
});
it('holds a recorded scope expansion', async () => {
  const { requestPacketScopeExpansion } = await import('@/lib/orchestrator/packet-scope-expansion');
  packet.allowedFiles = ['fixture.txt']; persist();
  const expansion = await requestPacketScopeExpansion({ packetId: packet.id, paths: ['extra.txt'], reason: 'Inspect the extra surface.' });
  await held('scope-expansion');
  // Progress must not erase a scope hold once it leaves the recent-event window.
  packet.allowedFiles = expansion.allowedPaths;
  packet.lastEventLabel = 'progress'; persist();
  const { getSqlite } = await import('@/lib/db');
  const db = getSqlite();
  const insert = db.prepare('INSERT INTO lane_events (id, lane_id, verb, actor, payload_json, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
  db.transaction(() => {
    for (let index = 0; index < 1001; index++) insert.run(`noise-${packet.id}-${index}`, lane.id, 'heartbeat', 'system', '{}', '9999-01-01T00:00:00.000Z');
  })();
  await held('scope-expansion');
});
it('holds protected test-control changes using the CI protected path classifier', async () => {
  writeFileSync(join(repoPath, 'vitest.config.ts'), 'export default {};\n'); git('add', 'vitest.config.ts');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'protected fixture');
  const next = git('rev-parse', 'HEAD');
  risk({ reviewedHeadSha: next, diffBase: { comparisonRef: head, mergeBase: head, usedFallback: false } });
  try { await held('protected-test-change'); } finally { git('reset', '--hard', head); }
});
it('holds protected test-control renames even with an approved review at the new HEAD', async () => {
  git('mv', 'vitest.config.ts', 'moved-config.ts');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'rename fixture');
  const next = git('rev-parse', 'HEAD');
  risk({ reviewedHeadSha: next, diffBase: { comparisonRef: head, mergeBase: head, usedFallback: false } });
  const approval = createApproval({ source: 'test', runtime: 'codex', agent: 'Fixture', sessionKey: `policy:${packet.id}`,
    title: 'Reviewed rename', description: 'Reviewed rename fixture', summary: 'Reviewed rename fixture', risk: 'low', toolName: 'orchestrator_review',
    args: { packetId: packet.id, approved: true, reviewedHeadSha: next, reviewTurnId: `${packet.id}-rename`, reviewTurnOutcome: 'completed' },
    metadata: { Packet: packet.id, laneId: lane.id } });
  resolveApproval(approval.id, 'approve', 'test');
  try { await held('protected-test-change'); } finally { git('reset', '--hard', head); }
});
it('never calls the fetching attribution resolver or writes FETCH_HEAD', async () => {
  const attribution = await import('@/lib/lane/attribution-base');
  const resolve = vi.spyOn(attribution, 'resolveLaneAttributionBase');
  const gitRunner = await import('@/lib/lane/lane-git');
  const laneCommands = vi.spyOn(gitRunner, 'laneGit');
  // Required contracts would otherwise make durable assessment enter the fetching coverage path.
  const { getSqlite } = await import('@/lib/db');
  getSqlite().prepare("DELETE FROM lane_events WHERE lane_id = ? AND verb = 'open_lane'").run(lane.id);
  packet.taskContractRequired = true; persist();
  const value = await policy();
  expect(value.nextAction.value).toBe('human');
  expect(value.durableReview.value.reason).toContain('coverage is unevaluated');
  expect(resolve).not.toHaveBeenCalled();
  expect(laneCommands.mock.calls.some(call => call[2].includes('fetch'))).toBe(false);
  expect(existsSync(join(repoPath, '.git', 'FETCH_HEAD'))).toBe(false);
});
it('holds when HEAD moves during the read', async () => {
  const heads = await import('@/lib/lane/head-sha-lock');
  vi.spyOn(heads, 'readHeadSha').mockResolvedValueOnce(head).mockResolvedValueOnce('b'.repeat(40));
  const value = await policy();
  expect(value.nextAction.value).toBe('human');
  expect(value.holds.value.some((hold: { reason: string }) => hold.reason.includes('revision changed'))).toBe(true);
});
it('returns 404 for an unknown lane and reads by packet ID', async () => {
  expect((await read('missing-policy-lane')).status).toBe(404);
  expect(await (await read(packet.id)).json()).toMatchObject({ laneId: lane.id, nextAction: { value: 'prepare_pull_request' } });
});
it('refuses anonymous, device and spectator callers before lookup', async () => {
  const { writeActiveTokenHashes } = await import('@/lib/mobile/device-token-file');
  const device = 'device-policy-fixture';
  writeActiveTokenHashes([createHash('sha256').update(device).digest('hex')]);
  const { getSpectatorTokenStore } = await import('@/lib/broadcast/spectator-token-store');
  const spectator = getSpectatorTokenStore().mint({ repoGrants: [repoPath] }).bearer;
  const lookup = vi.spyOn(registry, 'getLane');
  for (const token of [null, device, spectator]) expect((await read(lane.id, token)).status).toBeGreaterThanOrEqual(401);
  expect(lookup).not.toHaveBeenCalled();
});
