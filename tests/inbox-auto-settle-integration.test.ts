import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST, PATCH, DELETE } from '@/app/api/v2/chat-history/route';
import { GET as historyList } from '@/app/api/v2/chat-history/list/route';
import { createLane, setLaneStatus } from '@/lib/lane/registry';
import { getSqlite } from '@/lib/db';
import { waitForTerminalLaneWork } from '@/lib/lane/terminal-work';
import { prepareDurableMergeRelease } from '@/lib/lane/durable-merge-release';
import { recordMission } from '@/lib/db/missions-store';
import { createEmptyOrchestratorMissionState } from '@/lib/orchestrator/store';
import { writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { readMissionRegistryEntry } from '@/lib/orchestrator/mission-registry';
import { markPacketReleased } from '@/lib/orchestrator/packet-release-truth';
import { attachPullRequestContext } from '@/lib/orchestrator/pull-request-context';
import { upsertGitHubPullRequest, type GitHubPullRequestSnapshot } from '@/lib/github-broker/store';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { runInboxAutoSettleSweep } from '@/lib/inbox/auto-settle';
import { inboxSubject, readInboxState, recordInboxConversationEvent } from '@/lib/inbox/store';
import { enqueueComposerSend } from '@/lib/orchestrator/composer-queue';

// Only external runtime discovery is fixed. Routes, SQLite, histories and lanes are real.
const fixture = vi.hoisted(() => ({ agents: [] as Array<Record<string, unknown>> }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: fixture.agents }) }));
const ids: string[] = [];
const prefix = `thoughts-autosettle-${process.pid}`;
const patch = (body: Record<string, unknown>) => PATCH(new NextRequest('http://localhost/api/v2/chat-history', {
  method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
async function seed(suffix: string, pinned = false, at = 100) {
  const tabId = `${prefix}-${suffix}`;
  ids.push(tabId);
  expect((await POST(new NextRequest('http://localhost/api/v2/chat-history', {
    method: 'POST', body: JSON.stringify({ tabId, pinned, repoPath: process.cwd(), messages: [
      { id: 'u', role: 'user', content: 'Ship it', timestamp: at },
      { id: 'a', role: 'assistant', content: 'Done', timestamp: at + 1 },
    ] }),
  }))).status).toBe(200);
  return tabId;
}
async function row(tabId: string) {
  const body = await (await historyList(new NextRequest('http://localhost/api/v2/chat-history/list?include=orchestrator'))).json();
  return body.conversations.find((candidate: { tabId: string }) => candidate.tabId === tabId);
}
function child(tabId: string, suffix: string, released: boolean) {
  const id = `${prefix}-p-${suffix}`;
  const lane = createLane({ repoPath: process.cwd(), branch: `auto-${suffix}`, runtime: 'codex', sessionKey: `codex:${id}`, packetId: id, baseCommit: 'a'.repeat(40) });
  const packet = { id, referenceLabel: `inline-${suffix}`, title: 'Child', summary: 'Child', workspaceTargetPath: process.cwd(),
    branchTarget: `auto-${suffix}`, runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [], queueState: 'held',
    releaseState: 'pending', status: 'idle', review: null, orchestratorThreadId: tabId,
    releaseStatePayload: null } as unknown as OrchestratorPacket;
  if (released) markPacketReleased(packet, { source: 'approve_and_merge', evidenceKind: 'merge_command',
    mergeCommit: 'b'.repeat(40), headSha: 'a'.repeat(40), releasedAt: new Date(Date.now() + 1000).toISOString() });
  return { lane, packet };
}
async function canonicalMerge(tabId: string, suffix: string) {
  const kid = child(tabId, suffix, false);
  const mission = { ...createEmptyOrchestratorMissionState(), missionId: `${prefix}-mission-${suffix}`,
    repoPath: process.cwd(), packets: [kid.packet] };
  recordMission({ id: mission.missionId, repoPath: process.cwd(), runtime: 'codex', prompt: 'Auto-settle fixture',
    summary: 'Auto-settle fixture', constraints: '', packetMeta: [], totalWaves: 1, missionState: mission });
  writeOrchestratorControlPlaneState(mission);
  // Drive the actual inner-merge release callback and durable owner. The merge
  // result is a fixture; this does not perform a remote merge or run a model.
  const release = await prepareDurableMergeRelease(kid.lane);
  await release('b'.repeat(40), 'a'.repeat(40));
  const saved = readMissionRegistryEntry(mission.missionId, { includeArchived: true })!.mission.packets[0];
  expect(saved).toMatchObject({ releaseState: 'released', releaseStatePayload: {
    source: 'approve_and_merge', evidenceKind: 'merge_command', mergeCommit: 'b'.repeat(40), headSha: 'a'.repeat(40),
  } });
  return { ...kid, missionId: mission.missionId, saved };
}
function pull(number: number, mergedAt: string | null): GitHubPullRequestSnapshot {
  return { pullRequestId: number, repositoryId: 1, repoFullName: 'example/autosettle', number, title: 'Fixture',
    state: mergedAt ? 'closed' : 'open', author: null, body: '', headRefName: `work-${number}`, baseRefName: 'main',
    additions: 1, deletions: 0, changedFiles: 1, reviewDecision: null, statusCheckRollup: [],
    url: `https://github.com/example/autosettle/pull/${number}`, createdAt: '2026-01-01T00:00:00Z',
    updatedAt: mergedAt ?? '2026-01-01T00:00:00Z', closedAt: mergedAt, mergedAt,
    headSha: 'a'.repeat(40), mergeCommit: mergedAt ? 'b'.repeat(40) : null };
}
afterAll(async () => {
  await waitForTerminalLaneWork();
  for (const tabId of ids) await DELETE(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`));
});

describe('server auto-settle sweep', () => {
  it('exposes and persists the existing auto-settle defaults through the native Settings route', async () => {
    const defaults = await import('@/app/api/panel/operator-defaults/route');
    const url = 'http://localhost/api/panel/operator-defaults?include=native';
    const read = async () => (await defaults.GET(new Request(url))).json();
    const initial = await read();
    expect(initial.values).toMatchObject({ autoSettleEnabled: true, autoSettleIdleDays: 3 });
    for (const values of [{ autoSettleEnabled: false, autoSettleIdleDays: 0 }, { autoSettleEnabled: true, autoSettleIdleDays: 3 }]) {
      const before = await read();
      const saved = await defaults.POST(new Request(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...values, settingsTomlRevision: before.settingsToml.revision }),
      }));
      expect(saved.status).toBe(200);
      expect((await read()).values).toMatchObject(values);
    }
  });

  it('settles a normally completed WS run only after its latest activity has been idle for N days', async () => {
    const tabId = await seed('completed-run', false, Date.now() - 86_400_000);
    const kid = child(tabId, 'completed-run', false);
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'auto-settle-completed-run', repoPath: process.cwd(), packets: [kid.packet] });
    const event = (status: string) => recordInboxConversationEvent({ event: 'status', data: { threadId: tabId, repoPath: process.cwd(), status } });
    event('busy');
    event('ready');
    const state = readInboxState(inboxSubject('conversation', tabId, process.cwd()));
    expect(state.runStatus).toBe('idle');
    const completedAt = Date.parse(state.runAt!);
    fixture.agents = [];
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 3, now: completedAt + 2 * 86_400_000 })).not.toContain(tabId);
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 3, now: completedAt + 4 * 86_400_000 })).toContain(tabId);
    expect(await row(tabId)).toMatchObject({ settledOverride: 'settled', autoSettledReason: 'idle' });
  }, 60_000);

  it('keeps idle running, approval-blocked and durably queued threads active', async () => {
    const running = await seed('idle-running');
    const waiting = await seed('idle-approval');
    const queued = await seed('idle-queued');
    const kids = [child(running, 'idle-running', false), child(waiting, 'idle-approval', false), child(queued, 'idle-queued', false)];
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'auto-settle-idle-guards', repoPath: process.cwd(), packets: kids.map(k => k.packet) });
    recordInboxConversationEvent({ event: 'status', data: { threadId: running, repoPath: process.cwd(), status: 'busy' } });
    enqueueComposerSend({ id: `${prefix}-queue`, repoPath: process.cwd(), threadId: queued, intent: 'send-next', payload: {
      text: 'next', wireMessage: 'next', images: [], routing: { backend: 'codex', model: 'gpt-5', effort: 'high', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false },
    } });
    fixture.agents = [{ sessionKey: kids[1].lane.sessionKey, workspace: process.cwd(), runtime: 'codex', status: 'waiting', approvalStatus: 'pending' }];
    try {
      const settled = await runInboxAutoSettleSweep({ force: true, idleDays: 3, now: Date.now() + 4 * 86_400_000 });
      for (const id of [running, waiting, queued]) {
        expect(settled).not.toContain(id);
        expect(await row(id)).not.toHaveProperty('settledOverride');
      }
    } finally { fixture.agents = []; }
  }, 60_000);

  it('settles canonical merges, skips archived-only/pinned/opted-out/needs-input/open ones, and undo sticks', async () => {
    const merged = await seed('merged');
    const cleaned = await seed('cleaned');
    const pinned = await seed('pinned', true);
    const optedOut = await seed('optout');
    const waiting = await seed('waiting');
    const open = await seed('open');
    const kids = [child(merged, 'm', true), child(cleaned, 'c', false), child(pinned, 'p', true),
      child(optedOut, 'o', true), child(waiting, 'w', true), child(open, 'x', false)];
    setLaneStatus(kids[1].lane.id, 'archived');
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'auto-settle', repoPath: process.cwd(), packets: kids.map(k => k.packet) });
    expect((await patch({ tabId: optedOut, inboxAction: 'auto-settle', inboxRevision: 0, enabled: false })).status).toBe(200);
    expect(await row(optedOut)).toMatchObject({ autoSettleDisabledAt: expect.any(String) });
    fixture.agents = [{ sessionKey: kids[4].lane.sessionKey, workspace: process.cwd(), runtime: 'codex', status: 'waiting', approvalStatus: 'pending' }];

    const settled = await runInboxAutoSettleSweep({ force: true, idleDays: 0 });
    expect(settled).toEqual([merged]);
    expect(await row(merged)).toMatchObject({ settledOverride: 'settled', autoSettledReason: 'released' });
    for (const id of [cleaned, pinned, optedOut, waiting, open]) expect(await row(id)).not.toHaveProperty('settledOverride');

    // Undo is the ordinary unsettle; the next sweep leaves it alone.
    const undone = await (await patch({ tabId: merged, inboxAction: 'unsettle' })).json();
    expect(undone).toMatchObject({ settledOverride: 'active', autoSettledReason: null });
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 0 })).toEqual([]);
    expect(await row(merged)).not.toHaveProperty('autoSettledReason');

    // A manual settle carries no automatic note.
    await patch({ tabId: merged, inboxAction: 'settle' });
    expect(await row(merged)).toMatchObject({ settledOverride: 'settled' });
    expect(await row(merged)).not.toHaveProperty('autoSettledReason');

    // Needs input resolved: the waiting thread settles next sweep.
    fixture.agents = [];
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 0 })).toEqual([waiting]);
  }, 120_000);

  it('is off when the operator default is off', async () => {
    const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
    const tabId = await seed('toggle');
    const kid = child(tabId, 't', true);
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'auto-settle-off', repoPath: process.cwd(), packets: [kid.packet] });
    await updateOperatorDefaults({ autoSettleEnabled: false });
    try {
      expect(await runInboxAutoSettleSweep()).toEqual([]);
      expect(await row(tabId)).not.toHaveProperty('settledOverride');
    } finally { await updateOperatorDefaults({ autoSettleEnabled: true }); }
    expect(await runInboxAutoSettleSweep()).toContain(tabId);
    expect(await row(tabId)).toMatchObject({ autoSettledReason: 'released' });
  }, 60_000);

  it('settles idle threads with a PR or worker after N days, never bare or pinned ones', async () => {
    const idle = await seed('idle', false, Date.now());
    const bare = await seed('bare', false, Date.now());
    const pinnedIdle = await seed('idlepin', true, Date.now());
    const kids = [child(idle, 'i', false), child(pinnedIdle, 'ip', false)];
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'auto-settle-idle', repoPath: process.cwd(), packets: kids.map(k => k.packet) });
    fixture.agents = [];
    // Not idle long enough yet; and 0 days is off.
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 3, now: Date.now() + 86_400_000 })).not.toContain(idle);
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 0, now: Date.now() + 9 * 86_400_000 })).not.toContain(idle);
    const settled = await runInboxAutoSettleSweep({ force: true, idleDays: 3, now: Date.now() + 4 * 86_400_000 });
    expect(settled).toContain(idle);
    expect(settled).not.toContain(bare);
    expect(settled).not.toContain(pinnedIdle);
    expect(await row(idle)).toMatchObject({ settledOverride: 'settled', autoSettledReason: 'idle' });
    expect(await row(bare)).not.toHaveProperty('settledOverride');
  }, 60_000);

  it('settles from the canonical inner-merge writer and durable mission after the current mirror moves on', async () => {
    const tabId = await seed('durable-merge');
    const kid = await canonicalMerge(tabId, 'durable-merge');
    writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
    await waitForTerminalLaneWork();
    const mission = () => getSqlite().prepare('SELECT mission_state_json FROM missions WHERE id = ?').get(kid.missionId);
    const lane = () => getSqlite().prepare('SELECT * FROM lanes WHERE id = ?').get(kid.lane.id);
    const beforeMission = mission(), beforeLane = lane();
    expect(beforeMission).toMatchObject({ mission_state_json: expect.any(String) });
    expect(beforeLane).toMatchObject({ id: kid.lane.id });
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 0 })).toContain(tabId);
    expect(await row(tabId)).toMatchObject({ settledOverride: 'settled', autoSettledReason: 'released' });
    // Settlement changes attention metadata, not release truth or worker state.
    expect(mission()).toEqual(beforeMission);
    expect(lane()).toEqual(beforeLane);
  }, 60_000);

  it('settles linked PR evidence only after every associated PR is mirrored as merged', async () => {
    const tabId = await seed('linked-merge');
    writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
    for (const number of [1, 2]) {
      upsertGitHubPullRequest(pull(number, null));
      attachPullRequestContext(tabId, { host: 'github.com', repositoryId: 1, pullRequestId: number, number });
    }
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 0 })).not.toContain(tabId);
    upsertGitHubPullRequest(pull(1, new Date().toISOString()));
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 0 })).not.toContain(tabId);
    upsertGitHubPullRequest(pull(2, new Date().toISOString()));
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 0 })).toContain(tabId);
    expect(await row(tabId)).toMatchObject({ settledOverride: 'settled', autoSettledReason: 'pr-merged' });
  }, 60_000);

  it('falls back to idle settlement when newer work follows a canonical merged packet', async () => {
    const tabId = await seed('merge-then-work');
    const kid = await canonicalMerge(tabId, 'merge-then-work');
    await new Promise(resolve => setTimeout(resolve, 10));
    for (const status of ['busy', 'ready']) recordInboxConversationEvent({ event: 'status', data: {
      threadId: tabId, repoPath: process.cwd(), status,
    } });
    const completedAt = Date.parse(readInboxState(inboxSubject('conversation', tabId, process.cwd())).runAt!);
    expect(completedAt).toBeGreaterThan(Date.parse(kid.saved.releaseStatePayload!.releasedAt!));
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 0 })).not.toContain(tabId);
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 3, now: completedAt + 2 * 86_400_000 })).not.toContain(tabId);
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 3, now: completedAt + 4 * 86_400_000 })).toContain(tabId);
    expect(await row(tabId)).toMatchObject({ autoSettledReason: 'idle' });
  }, 60_000);

  it.each(['read-only', 'unproved-release', 'archived-only'] as const)('keeps %s evidence active until the idle threshold', async evidence => {
    const at = Date.now();
    const tabId = await seed(`nonmerge-${evidence}`, false, at);
    const kid = child(tabId, `nonmerge-${evidence}`, false);
    if (evidence === 'read-only') markPacketReleased(kid.packet, { source: 'read_only_completed',
      evidenceKind: 'read_only_no_merge_required', releasedAt: new Date(at).toISOString() });
    if (evidence === 'unproved-release') Object.assign(kid.packet, { releaseState: 'released', status: 'released',
      releaseStatePayload: { releasedAt: new Date(at).toISOString() } });
    if (evidence === 'archived-only') setLaneStatus(kid.lane.id, 'archived');
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
      missionId: `${prefix}-nonmerge-${evidence}`, repoPath: process.cwd(), packets: [kid.packet] });
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 0 })).not.toContain(tabId);
    expect(await row(tabId)).not.toHaveProperty('settledOverride');
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 3, now: at + 2 * 86_400_000 })).not.toContain(tabId);
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 3, now: at + 4 * 86_400_000 })).toContain(tabId);
    expect(await row(tabId)).toMatchObject({ autoSettledReason: 'idle' });
  }, 60_000);

  it('does not settle a merged thread while another owned packet remains unfinished', async () => {
    const tabId = await seed('unfinished-sibling');
    const kids = [child(tabId, 'merged-sibling', true), child(tabId, 'unfinished-sibling', false)];
    writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
      missionId: `${prefix}-unfinished-sibling`, repoPath: process.cwd(), packets: kids.map(k => k.packet) });
    expect(await runInboxAutoSettleSweep({ force: true, idleDays: 0 })).not.toContain(tabId);
    expect(await row(tabId)).not.toHaveProperty('settledOverride');
  }, 60_000);
});
