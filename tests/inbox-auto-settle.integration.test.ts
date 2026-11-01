import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST, PATCH, DELETE } from '@/app/api/v2/chat-history/route';
import { GET as historyList } from '@/app/api/v2/chat-history/list/route';
import { createLane, setLaneStatus } from '@/lib/lane/registry';
import { createEmptyOrchestratorMissionState } from '@/lib/orchestrator/store';
import { writeOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { runInboxAutoSettleSweep } from '@/lib/inbox/auto-settle';

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
    releaseState: released ? 'released' : 'pending', status: released ? 'released' : 'idle', review: null, orchestratorThreadId: tabId,
    releaseStatePayload: released ? { releasedAt: new Date(Date.now() + 1000).toISOString() } : null } as unknown as OrchestratorPacket;
  return { lane, packet };
}
afterAll(async () => {
  for (const tabId of ids) await DELETE(new NextRequest(`http://localhost/api/v2/chat-history?tabId=${tabId}`));
});

describe('server auto-settle sweep', () => {
  it('settles merged and cleaned threads, skips pinned/opted-out/needs-input/open ones, and undo sticks', async () => {
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
    fixture.agents = [{ sessionKey: kids[4].lane.sessionKey, workspace: process.cwd(), runtime: 'codex', status: 'waiting', approvalStatus: 'pending' }];

    const settled = await runInboxAutoSettleSweep({ force: true, idleDays: 0 });
    expect(settled.sort()).toEqual([cleaned, merged].sort());
    expect(await row(merged)).toMatchObject({ settledOverride: 'settled', autoSettledReason: 'released' });
    expect(await row(cleaned)).toMatchObject({ settledOverride: 'settled', autoSettledReason: 'cleaned' });
    for (const id of [pinned, optedOut, waiting, open]) expect(await row(id)).not.toHaveProperty('settledOverride');

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
    // Test one's orphaned archived lane is now a standalone worker and settles too.
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
});
