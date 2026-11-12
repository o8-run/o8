import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import { createApproval, getApproval } from '@/lib/approvals/store';
import { POST } from '@/app/api/panel/approvals/route';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { withLockedState } from '@/lib/orchestrator/control-plane';

vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ requestRealtimeRefresh: vi.fn(async () => true), publishRealtimeMutation: vi.fn(async () => true) }));
vi.mock('@/lib/orchestrator/headless-loop', () => ({ runHeadlessSprintTick: vi.fn(async () => undefined) }));
const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');

const saved = () => JSON.parse(readFileSync(join(getDataDir(), 'orchestrator-state.json'), 'utf8')).mission as {
  missionId: string; repoPath: string | null; summary: string; creationMutationId: string | null; creationReceipt: unknown;
  activeComparisonGroups?: string[]; packets: Array<{ id: string; title: string; status: string; referenceLabel: string }>;
};
const savedPackets = () => saved().packets;
const approvePlan = async (issueNumber: number, repoPath: string, titles: string[]) => {
  const card = createApproval({ source: 'runtime', runtime: 'codex', agent: 'Fixture', sessionKey: `intake:plan-${issueNumber}`,
    title: 'Plan', description: 'Plan', summary: 'Plan', risk: 'low',
    continuation: { kind: 'plan', repoPath, issueNumber, issueTitle: 'Fixture plan', issueUrl: `https://example.invalid/issues/${issueNumber}`,
      runtime: 'codex', tasks: titles.map(title => ({ title, body: `Do ${title}` })) } });
  const response = await POST(new NextRequest('http://localhost/api/panel/approvals', { method: 'POST',
    headers: { authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve', id: card.id }) }));
  return { card, response };
};

describe('approved plan dispatch', () => {
  it('saves the packets it reports as dispatched', async () => {
    const { card, response } = await approvePlan(5994, '/fixture/plan-persist', ['First task', 'Second task']);
    expect(response.status).toBe(200);
    expect((await response.json()).note).toContain('Dispatched 2 packets for issue #5994.');
    expect(getApproval(card.id)?.status).toBe('approved');
    expect(savedPackets().map(packet => packet.title)).toEqual(['#5994: First task', '#5994: Second task']);
    expect(saved().missionId).toMatch(/^intake-5994-/);
    expect(runHeadlessSprintTick).toHaveBeenCalledTimes(1);
  });

  it('appends to the current mission without dropping inactive packets or changing its settings', async () => {
    // Draft packets are not running, launching or queued: the old check replaced them.
    await withLockedState(current => { for (const packet of current.packets) { packet.queueState = 'draft'; packet.status = 'draft'; } });
    const before = saved();
    expect(before.packets.map(packet => packet.status)).toEqual(['draft', 'draft']);
    const { response } = await approvePlan(6001, '/fixture/other-repo', ['Third task']);
    expect(response.status).toBe(200);
    const after = saved();
    expect(after.missionId).toBe(before.missionId);
    expect(after.repoPath).toBe('/fixture/plan-persist');
    expect(after.packets.map(packet => [packet.title, packet.status, packet.referenceLabel])).toEqual([
      ['#5994: First task', 'draft', 'P1'], ['#5994: Second task', 'draft', 'P2'], ['#6001: Third task', 'queued', 'P3'],
    ]);
  });

  it('starts a fresh intake mission without the previous creation receipt or comparison groups', async () => {
    await withLockedState(current => {
      current.packets = [];
      current.creationMutationId = 'old-mutation';
      current.creationReceipt = { missionId: current.missionId ?? '', packets: [], branchPreparation: [] };
      current.activeComparisonGroups = ['old-group'];
    });
    const previous = saved().missionId;
    const { response } = await approvePlan(6002, '/fixture/fresh', ['Fresh task']);
    expect(response.status).toBe(200);
    const after = saved();
    expect(after.missionId).toMatch(/^intake-6002-/);
    expect(after.missionId).not.toBe(previous);
    expect(after.creationMutationId).toBeNull();
    expect(after.creationReceipt).toBeNull();
    expect(after.activeComparisonGroups ?? []).toEqual([]);
    expect(after.packets.map(packet => packet.title)).toEqual(['#6002: Fresh task']);
  });

  it('keeps a mission state returned from the locked callback', async () => {
    const { state } = await withLockedState(current => ({ ...current, summary: 'returned state', packets: [] }));
    expect(state.summary).toBe('returned state');
    expect(JSON.parse(readFileSync(join(getDataDir(), 'orchestrator-state.json'), 'utf8')).mission.summary).toBe('returned state');
  });

  it('keeps in-place changes when the callback returns something else', async () => {
    const { result, state } = await withLockedState(current => { current.summary = 'mutated in place'; return { packets: 3 }; });
    expect(result).toEqual({ packets: 3 });
    expect(state.summary).toBe('mutated in place');
    const { state: kept } = await withLockedState(current => { current.summary = 'kept again'; return { version: 2, packets: [] }; });
    expect(kept.summary).toBe('kept again');
  });
});
