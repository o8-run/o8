/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrchestratorHoverCard } from './OrchestratorHoverCard';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { SwarmSessionView } from './thoughts/chat-panel/SwarmStatusCard';

vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: vi.fn() }));
vi.mock('@/lib/panel/durable-refresh', () => ({ DEGRADED_FALLBACK_REFRESH_MS: 60_000, startDurableRefresh: () => () => {} }));
let host: HTMLDivElement;
let root: Root;
const worker = (name: string, status = 'running'): SwarmSessionView => ({ sessionKey: `codex:${name}`, name, runtime: 'codex', model: 'gpt-6.1-sol', status });
const response = (threadId: string, workers: SwarmSessionView[]) => new Response(JSON.stringify({ threadId, workers }));
const preview = (threadId: string | null, workspacePath = '/repo', packets: OrchestratorPacket[] = []) => createElement(OrchestratorHoverCard, {
  title: 'Parent conversation', repoLabel: 'repo', backendLabel: 'Codex', threadId, workspacePath, packets,
  anchorRect: new DOMRect(20, 700, 200, 28), onMouseEnter: () => {}, onMouseLeave: () => {},
});
const card = () => document.querySelector('[data-orchestrator-hover]')!;
const rows = () => [...card().querySelectorAll('[data-hover-worker]')];
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('conversation worker hover', () => {
  it('uses exact parent membership and deduplicates worktree and shared receipts with canonical states', async () => {
    const fetcher = vi.fn(async (_url: string) => response('parent-a', [worker('worktree'), worker('shared'), worker('stopped', 'interrupted'), worker('shared')]));
    vi.stubGlobal('fetch', fetcher);
    const packet = { id: 'packet-a', title: 'worktree', orchestratorThreadId: 'parent-a', status: 'released', runtime: 'codex',
      lane: { laneId: 'lane-a', sessionKey: 'codex:worktree' } } as OrchestratorPacket;
    const unrelated = { ...packet, id: 'packet-b', title: 'other parent', orchestratorThreadId: 'parent-b' };
    await act(async () => root.render(preview('parent-a', '/repo', [packet, packet, unrelated])));
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/orchestrator/shared-team/active?repoPath=%2Frepo&threadId=parent-a');
    expect(card().textContent).toContain('3 workers from this conversation');
    expect(rows()).toHaveLength(3);
    expect(rows().map(row => row.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Completed'), expect.stringContaining('Running'), expect.stringContaining('Interrupted'),
    ]));
    expect(card().textContent).not.toContain('Merged');
    expect(card().textContent).not.toContain('other parent');
    expect(card().textContent).toContain('gpt-6.1-sol');
    expect(Number.parseFloat((card() as HTMLElement).style.top)).toBeGreaterThanOrEqual(14);
  });

  it('aborts a prior hover and ignores its late response after another parent is hovered', async () => {
    const pending: Array<{ signal: AbortSignal; finish: (value: Response) => void }> = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>(finish => pending.push({ signal: options.signal as AbortSignal, finish }))));
    await act(async () => root.render(preview('parent-a')));
    await act(async () => root.render(preview('parent-b')));
    expect(pending[0].signal.aborted).toBe(true);
    await act(async () => pending[0].finish(response('parent-a', [worker('Old parent')])));
    expect(rows()).toHaveLength(0);
    await act(async () => pending[1].finish(response('parent-b', [worker('Current parent')])));
    expect(rows()).toHaveLength(1);
    expect(card().textContent).not.toContain('Old parent');
    expect(card().textContent).toContain('Current parent');
  });

  it('clears membership on repository changes and rejects a mismatched parent response', async () => {
    let finish: (value: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('%2Fother')
      ? new Promise<Response>(resolve => { finish = resolve; }) : Promise.resolve(response('parent-a', [worker('Old repository')]))));
    await act(async () => root.render(preview('parent-a')));
    expect(rows()).toHaveLength(1);
    await act(async () => root.render(preview('parent-a', '/other')));
    expect(rows()).toHaveLength(0);
    await act(async () => finish(response('wrong-parent', [worker('Wrong parent')])));
    expect(rows()).toHaveLength(0);
  });

  it('caps the preview and leaves empty or unowned hovers free of worker placeholders', async () => {
    const fetcher = vi.fn(async (_url: string) => response('parent-a', Array.from({ length: 8 }, (_, index) => worker(`Worker ${index}`))));
    vi.stubGlobal('fetch', fetcher);
    await act(async () => root.render(preview('parent-a')));
    expect(rows()).toHaveLength(6);
    expect(card().textContent).toContain('8 workers from this conversation');
    expect(card().textContent).toContain('+2 more');
    await act(async () => root.render(preview(null)));
    expect(rows()).toHaveLength(0);
    expect(card().textContent).not.toContain('workers');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
