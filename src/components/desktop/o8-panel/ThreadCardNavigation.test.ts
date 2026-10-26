// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ThreadWorkerCard } from '../thoughts/chat-panel/ThreadWorkerCard';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
const f = vi.hoisted(() => ({ review: vi.fn(), open: vi.fn(async () => ({ ok: true })) }));
vi.mock('../orchestrator-data-context', () => ({ useOrchestratorData: () => ({ onOpenO8Panel: f.review }) }));
vi.mock('./thread-navigation', () => ({ openCurrentThread: f.open }));
it('opens review and the exact persisted thread from a production transcript worker card without dispatch', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    const packet = { id: 'pkt-exact', title: 'Parser result', status: 'awaiting_review', runtime: 'codex', workspaceTargetPath: '/repo', lane: { laneId: 'lane-exact', sessionKey: 'codex:exact' } } as OrchestratorPacket;
    await act(async () => root.render(createElement(ThreadWorkerCard, { group: { packets: [packet], sessions: [], scouts: [] } })));
    const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons().some(button => button.textContent === 'Review')).toBe(true);
    await act(async () => buttons().find(button => button.textContent === 'Review')!.click());
    expect(f.review).toHaveBeenCalledWith({ repoPath: '/repo', tab: 'review', reviewLaneId: 'lane-exact' });
    await act(async () => buttons().find(button => button.textContent === 'View thread')!.click());
    expect(f.open).toHaveBeenCalledWith('/repo', 'pkt-exact');
  } finally { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
