/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { TranscriptTurns } from './TranscriptTurns';
import { ThreadWorkerCard, useThreadWorkers } from '../thoughts/chat-panel/ThreadWorkerCard';
import { projectThreadWorkerGroups } from '../thoughts/chat-panel/thread-worker-groups';
import type { SwarmSessionView } from '../thoughts/chat-panel/SwarmStatusCard';

const { callbacks } = vi.hoisted(() => ({ callbacks: { current: null as null | { onRealtimeEvent: (event: unknown) => void } } }));
vi.mock('@/components/desktop/hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: (_: unknown, options: typeof callbacks.current) => { callbacks.current = options; } }));
vi.mock('@/lib/panel/durable-refresh', () => ({ DEGRADED_FALLBACK_REFRESH_MS: 60_000, startDurableRefresh: () => () => {} }));

const entries: MobileTranscriptEntry[] = [
  { id: 'user-1', role: 'user', text: 'First request' },
  { id: 'assistant-1', role: 'assistant', text: 'Delegating first' },
  { id: 'final-1', role: 'assistant', text: 'First reply' },
  { id: 'user-2', role: 'user', text: 'Second request' },
  { id: 'assistant-2', role: 'assistant', text: 'Second reply' },
];
const worker = (id: string, parentTurnId?: string): SwarmSessionView => ({
  sessionKey: `codex:${id}`, name: id, runtime: 'codex', status: 'running', parentTurnId,
});
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function Conversation({ agents = [], onFocusSession, threadId = 'thoughts-test' }: { agents?: Array<{ sessionKey: string; status: string }>; onFocusSession?: (id: string) => void; threadId?: string }) {
  const sessions = useThreadWorkers({ threadId, repoPath: '/repo', busy: false, agents });
  const { groups, unattributed } = projectThreadWorkerGroups({ entries, packets: [], sessions, busy: false });
  return <>
    <TranscriptTurns entries={entries} busy={false} nodes={entries.map(entry => <div key={entry.id} data-message={entry.id}>{entry.text}</div>)}
      turnContent={new Map([...groups].map(([id, group]) => [id, <ThreadWorkerCard key={id} group={group} onFocusSession={onFocusSession} />]))} />
    <ThreadWorkerCard group={unattributed} unattributed />
  </>;
}

describe('turn-local worker cards', () => {
  it('offers recovery on an isolated packet row using its saved session summary', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ session: { status: 'interrupted' }, recovery: {
      actions: ['resume', 'retire'], worktreePath: '/packet-checkout', branch: 'worker/packet', runId: 'run-packet', retired: false,
    } }) }));
    vi.stubGlobal('fetch', fetcher);
    const packet = { id: 'packet-recovery', title: 'Packet worker', status: 'blocked', runtime: 'codex',
      lane: { laneId: 'lane-recovery', sessionKey: 'codex-owned:packet-worker' } } as OrchestratorPacket;
    await act(async () => root.render(<ThreadWorkerCard group={{ packets: [packet], scouts: [], sessions: [] }} />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
    expect(fetcher).toHaveBeenCalledWith('/api/runtime/session-summary?sessionKey=codex-owned%3Apacket-worker', expect.any(Object));
    expect(host.textContent).toContain('Edits preserved on worker/packet at /packet-checkout');
    expect([...host.querySelectorAll('button')].filter(button => button.textContent === 'Resume' || button.textContent === 'Retire')).toHaveLength(2);
  });

  it('offers Resume and Retire on the interrupted worker and sends the exact saved session control', async () => {
    const session = { ...worker('Interrupted worker', 'assistant-1'), sessionKey: 'codex-owned:saved', status: 'interrupted',
      recovery: { actions: ['resume', 'retire'] as Array<'resume' | 'retire'>, worktreePath: '/checkout', branch: 'worker/saved', runId: 'run', retired: false } };
    let finish!: (value: unknown) => void;
    const fetcher = vi.fn((_url: string, _options?: RequestInit) => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetcher);
    await act(async () => root.render(<ThreadWorkerCard group={{ packets: [], scouts: [], sessions: [session] }} />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
    const buttons = () => [...host.querySelectorAll('button')];
    expect(host.textContent).toContain('Interrupted');
    expect(buttons().some(button => button.textContent === 'Resume')).toBe(true);
    expect(buttons().some(button => button.textContent === 'Retire')).toBe(true);
    await act(async () => buttons().find(button => button.textContent === 'Resume')!.click());
    expect(buttons().find(button => button.textContent === 'Resuming…')?.disabled).toBe(true);
    expect(buttons().find(button => button.textContent === 'Retire')?.disabled).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe('/api/agent-control/action');
    expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({
      ref: { kind: 'session', id: session.sessionKey }, action: { kind: 'resume' }, clientMutationId: expect.any(String),
    });
    await act(async () => finish({ ok: false, json: async () => ({ error: { message: 'Resume held: inspect the checkout.' } }) }));
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Resume held: inspect the checkout.');
    await act(async () => buttons().find(button => button.textContent === 'Retire')!.click());
    await act(async () => finish({ ok: true, json: async () => ({ result: { ok: true, note: 'Retired. Edits remain at /checkout on worker/saved.' } }) }));
    expect(host.textContent).toContain('Edits remain at /checkout on worker/saved.');
    expect(buttons().some(button => button.textContent === 'Resume')).toBe(false);
  });

  it('keeps two groups beside their replies through live status, duplicate receipts, hide/reopen and reload', async () => {
    const first = worker('First worker', 'assistant-1');
    const second = worker('Second worker', 'assistant-2');
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => ({ threadId: 'thoughts-test', workers: [first, second, first] }) }));
    vi.stubGlobal('fetch', fetcher);
    const focus = vi.fn();
    await act(async () => root.render(<Conversation onFocusSession={focus} />));
    const toggles = [...host.querySelectorAll<HTMLButtonElement>('[aria-expanded]')];
    expect(toggles).toHaveLength(2);
    const firstReply = host.querySelector('[data-message="final-1"]')!;
    expect(firstReply.compareDocumentPosition(toggles[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggles[0].compareDocumentPosition(host.querySelector('[data-message="user-2"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => toggles[0].click());
    const openFirst = () => host.querySelector<HTMLButtonElement>('[title="Open First worker"]')!;
    await act(async () => openFirst().click());
    expect(focus).toHaveBeenLastCalledWith(first.sessionKey);
    toggles[0].focus();
    await act(async () => root.render(<Conversation agents={[{ sessionKey: first.sessionKey, status: 'completed' }]} onFocusSession={focus} />));
    expect(host.querySelector('[aria-expanded]')).toBe(toggles[0]);
    expect(document.activeElement).toBe(toggles[0]);
    expect(toggles[0].textContent).toContain('1 completed');
    expect(toggles[1].textContent).toContain('1 running');
    await act(async () => {
      callbacks.current!.onRealtimeEvent({ channel: 'mutation', data: { mutation: { surfaceId: first.sessionKey } } });
      window.dispatchEvent(new CustomEvent('cortex:agent-supervisor-update', { detail: { launchContext: { parentThreadId: 'thoughts-test' } } }));
    });
    expect(host.querySelectorAll('[role="group"]')).toHaveLength(2);
    expect(host.querySelectorAll('[title="Open First worker"]')).toHaveLength(1);
    await act(async () => toggles[0].click());
    expect(openFirst()).toBeNull();
    await act(async () => toggles[0].click());
    await act(async () => openFirst().click());
    expect(focus).toHaveBeenLastCalledWith(first.sessionKey);
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<Conversation onFocusSession={focus} />));
    expect(host.querySelectorAll('[role="group"]')).toHaveLength(2);
    expect([...host.querySelectorAll('[aria-expanded]')].map(node => node.textContent)).toEqual(['1 subagent1 running', '1 subagent1 running']);
  });

  it('never infers an origin from ordering and keeps absent or unloaded origins unattributed', () => {
    const known = worker('Known', 'assistant-1');
    const absent = worker('Absent');
    const unloaded = worker('Unloaded', 'older-assistant');
    const packet = { id: 'packet', status: 'running', orchestratorTurnId: 'assistant-2', lane: { sessionKey: 'packet-worker', laneId: 'lane' } } as OrchestratorPacket;
    const result = projectThreadWorkerGroups({ entries, sessions: [known, absent, unloaded, { ...known }], packets: [packet, packet], busy: false });
    expect([...result.groups.keys()]).toEqual(['user-2', 'user-1']);
    expect(result.groups.get('user-1')!.sessions).toEqual([known]);
    expect(result.groups.get('user-2')!.packets).toEqual([packet]);
    expect(result.unattributed.sessions).toEqual([absent, unloaded]);
  });

  it.each(['interrupted', 'completed', 'retired', 'failed'])('keeps the durable %s state when fleet discovery reports idle', async status => {
    const saved = { ...worker('Saved worker', 'assistant-1'), status };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ threadId: 'thoughts-test', workers: [saved] }) })));
    await act(async () => root.render(<Conversation agents={[{ sessionKey: saved.sessionKey, status: 'idle' }]} />));
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
    expect(host.querySelector('[title="Open Saved worker"]')?.textContent).toContain(status[0].toUpperCase() + status.slice(1));
    expect(host.textContent).not.toContain('Idle');
  });

  it('leaves conflicting origins unattributed regardless of duplicate receipt order', () => {
    const first = worker('Conflicting', 'assistant-1');
    const second = { ...first, parentTurnId: 'assistant-2', status: 'completed' };
    for (const sessions of [[first, second], [second, first]]) {
      const result = projectThreadWorkerGroups({ entries, packets: [], sessions, busy: false });
      expect(result.groups.size).toBe(0);
      expect(result.unattributed.sessions).toHaveLength(1);
      expect(result.unattributed.sessions[0].sessionKey).toBe(first.sessionKey);
    }
    const missing = { ...first, parentTurnId: undefined };
    for (const sessions of [[first, missing], [missing, first]]) {
      const result = projectThreadWorkerGroups({ entries, packets: [], sessions, busy: false });
      expect(result.groups.get('user-1')!.sessions).toHaveLength(1);
      expect(result.unattributed.sessions).toHaveLength(0);
    }
    const packet = { id: 'packet', status: 'running', orchestratorTurnId: 'assistant-2', lane: { sessionKey: first.sessionKey, laneId: 'lane' } } as OrchestratorPacket;
    const result = projectThreadWorkerGroups({ entries, packets: [packet], sessions: [first], busy: false });
    expect(result.groups.size).toBe(0);
    expect(result.unattributed.packets).toEqual([packet]);
    expect(result.unattributed.sessions).toHaveLength(0);
  });

  it('clears the previous thread membership immediately while another thread loads', async () => {
    let complete: ((response: unknown) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('thoughts-other')
      ? new Promise(resolve => { complete = resolve; })
      : { ok: true, json: async () => ({ threadId: 'thoughts-test', workers: [worker('Old worker', 'assistant-1')] }) }));
    await act(async () => root.render(<Conversation />));
    expect(host.querySelectorAll('[role="group"]')).toHaveLength(1);
    await act(async () => root.render(<Conversation threadId="thoughts-other" />));
    expect(host.querySelectorAll('[role="group"]')).toHaveLength(0);
    await act(async () => complete!({ ok: true, json: async () => ({ threadId: 'thoughts-other', workers: [worker('New worker', 'assistant-2')] }) }));
    expect(host.querySelectorAll('[role="group"]')).toHaveLength(1);
    expect(host.querySelector('[data-message="assistant-2"]')!.compareDocumentPosition(host.querySelector('[role="group"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps workers waiting for input visibly unresolved and leaves input in their normal composer', async () => {
    const sessions = ['waiting', 'awaiting_input', 'needs-input'].map(status => ({ ...worker(status, 'assistant-1'), status }));
    await act(async () => root.render(<ThreadWorkerCard group={{ packets: [], scouts: [], sessions }} />));
    expect(host.textContent).toContain('3 waiting for input');
    expect(host.textContent).not.toContain('completed');
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-expanded]')!.click());
    expect(host.querySelectorAll('.fam-review')).toHaveLength(3);
    expect(host.querySelector('textarea')).toBeNull();
  });

  it('shows result delivery separately from execution and preserves the focused worker through updates', async () => {
    const session: SwarmSessionView = { ...worker('Return worker', 'assistant-1'), status: 'completed', returnStatus: 'pending' };
    const focus = vi.fn();
    const render = async (patch: Partial<SwarmSessionView>) => {
      await act(async () => root.render(<ThreadWorkerCard group={{ packets: [], scouts: [], sessions: [{ ...session, ...patch }] }} onFocusSession={focus} />));
    };
    await render({});
    const toggle = host.querySelector<HTMLButtonElement>('[aria-expanded]')!;
    expect(toggle.textContent).toContain('1 completed');
    expect(toggle.textContent).toContain('Result queued');
    await act(async () => toggle.click());
    const row = host.querySelector<HTMLButtonElement>('[title^="Open Return worker"]')!;
    expect(toggle.getAttribute('aria-controls')).toBe(host.querySelector('[data-swarm-crew]')!.id);
    row.focus();
    await render({ returnStatus: 'running' });
    expect(document.activeElement).toBe(row);
    expect(row.textContent).toContain('Returning result');
    expect(row.textContent).toContain('Completed');
    await render({ returnStatus: 'held', returnReason: 'Parent turn is busy. Retry after it settles.' });
    expect(row.textContent).toContain('Result needs attention: Parent turn is busy. Retry after it settles.');
    expect(row.title).toContain('Parent turn is busy. Retry after it settles.');
    expect(document.activeElement).toBe(row);
    await act(async () => row.click());
    expect(focus).toHaveBeenCalledWith(session.sessionKey);
    await render({ returnStatus: 'delivered' });
    expect(host.textContent).not.toMatch(/Result queued|Returning result|Result needs attention|Result delivered/);
    expect(toggle.textContent).toContain('1 completed');
    expect(document.activeElement).toBe(row);
  });

  it('retains native subagent evidence in each original turn after a later request', () => {
    const native: MobileTranscriptEntry[] = entries.map(entry => entry.id === 'assistant-1' ? { ...entry, toolCalls: [{ id: 'native', name: 'Task', status: 'done', args: { description: 'Inspect first' } }] } : entry);
    const { groups } = projectThreadWorkerGroups({ entries: native, sessions: [], packets: [], busy: false });
    expect(groups.get('user-1')!.scouts).toEqual([{ id: 'native', label: 'Inspect first', status: 'done' }]);
    expect(groups.has('user-2')).toBe(false);
  });
});
