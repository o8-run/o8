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

const savedPackets = () => JSON.parse(readFileSync(join(getDataDir(), 'orchestrator-state.json'), 'utf8')).mission.packets as Array<{ id: string; title: string }>;

describe('approved plan dispatch', () => {
  it('saves the packets it reports as dispatched', async () => {
    const card = createApproval({ source: 'runtime', runtime: 'codex', agent: 'Fixture', sessionKey: 'intake:plan-persist',
      title: 'Plan', description: 'Plan', summary: 'Plan', risk: 'low',
      continuation: { kind: 'plan', repoPath: '/fixture/plan-persist', issueNumber: 5994, issueTitle: 'Fixture plan',
        issueUrl: 'https://example.invalid/issues/5994', runtime: 'codex',
        tasks: [{ title: 'First task', body: 'Do the first task' }, { title: 'Second task', body: 'Do the second task' }] } });
    const response = await POST(new NextRequest('http://localhost/api/panel/approvals', { method: 'POST',
      headers: { authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'approve', id: card.id }) }));
    expect(response.status).toBe(200);
    expect((await response.json()).note).toContain('Dispatched 2 packets for issue #5994.');
    expect(getApproval(card.id)?.status).toBe('approved');
    expect(savedPackets().map(packet => packet.title)).toEqual(['#5994: First task', '#5994: Second task']);
    expect(runHeadlessSprintTick).toHaveBeenCalledTimes(1);
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
  });
});
