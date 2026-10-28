// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileOrchestratorThread } from '@/lib/mobile/types';
import { getPendingQueue } from '@/lib/mobile/pending-queue';
import { useOrchestratorMobile } from './useOrchestratorMobile';

vi.mock('@/lib/panel/ws-port-client', () => ({
  getBrowserWsPort: () => 47125,
}));

vi.mock('@/lib/mobile/ws-token-client', () => ({
  getMobileWsToken: () => 'test-token',
}));

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly sent: Array<Record<string, unknown>> = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
      this.emit({
        channel: 'system',
        event: 'connected',
      });
    });
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload) as Record<string, unknown>);
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  emit(payload: Record<string, unknown>) {
    this.onmessage?.({
      data: JSON.stringify(payload),
    } as MessageEvent);
  }
}

const thread: MobileOrchestratorThread = {
  id: 'thoughts-mobile-durable-send',
  title: 'Durable send',
  repoPath: '/tmp/mobile-durable-send',
  repoName: 'mobile-durable-send',
  repoBranch: 'main',
  githubOwner: null,
  githubRepo: null,
  runtime: 'codex',
  status: 'ready',
  lastMessageAt: new Date(0).toISOString(),
  messageCount: 0,
  projectId: null,
  backend: 'codex',
  agent: null,
};

type HookValue = ReturnType<typeof useOrchestratorMobile>;

function mountHook(onValue: (value: HookValue) => void): { root: Root; host: HTMLDivElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  function Harness(): ReactElement {
    const value = useOrchestratorMobile({ activeThread: thread });
    onValue(value);
    return createElement('div');
  }

  act(() => {
    root.render(createElement(Harness));
  });
  return { root, host };
}

async function flushConnection() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('mobile orchestrator durable send delivery', () => {
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    FakeWebSocket.instances = [];
    window.localStorage.clear();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/v2/chat-history?')) {
        return new Response(JSON.stringify({ messages: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/v2/chat-history' && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.body.replaceChildren();
  });

  it('retains legacy history rows without message ids when using the shared transcript adapter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ messages: [
      { role: 'user', content: 'Legacy prompt' }, { role: 'assistant', content: 'Legacy reply' },
    ] })));
    const values: HookValue[] = [];
    const mounted = mountHook(value => { values.push(value); });
    try {
      await flushConnection();
      expect(values.at(-1)!.transcript.map(entry => entry.text)).toEqual(['Legacy prompt', 'Legacy reply']);
      expect(values.at(-1)!.transcript.map(entry => entry.id)).toEqual(['history-0', 'history-1']);
    } finally { act(() => { mounted.root.unmount(); mounted.host.remove(); }); }
  });

  it('keeps both sides of a tool boundary before the render flush', async () => {
    const values: HookValue[] = [];
    const mounted = mountHook(value => { values.push(value); });
    try {
      await flushConnection();
      const socket = FakeWebSocket.instances.at(-1)!;
      const data = { repoPath: thread.repoPath, threadId: thread.id, assistantMessageId: 'assistant-burst' };
      act(() => {
        socket.emit({ channel: 'orchestrator', event: 'output', data: { ...data, text: 'Before tool.' } });
        socket.emit({ channel: 'orchestrator', event: 'tool-use', data: { ...data, toolUseId: 'burst-tool', name: 'read_file' } });
        socket.emit({ channel: 'orchestrator', event: 'output', data: { ...data, text: 'After tool.' } });
        socket.emit({ channel: 'orchestrator', event: 'tool-result', data: { ...data, toolUseId: 'burst-tool', result: 'Read complete' } });
        socket.emit({ channel: 'orchestrator', event: 'status', data: { ...data, status: 'ready' } });
      });
      expect(values.at(-1)!.transcript.map(entry => [entry.role, entry.text])).toEqual([
        ['assistant', 'Before tool.'], ['tool', 'read_file'], ['assistant', 'After tool.'],
      ]);
      expect(values.at(-1)!.transcript.filter(entry => entry.id === 'tool:burst-tool')).toHaveLength(1);
      expect(values.at(-1)!.transcript.find(entry => entry.id === 'tool:burst-tool')?.toolDone).toBe(true);
    } finally { act(() => { mounted.root.unmount(); mounted.host.remove(); }); }
  });

  it('retains displayed output after a sealed prefix when another phone message clears the buffer', async () => {
    const values: HookValue[] = [];
    const mounted = mountHook(value => { values.push(value); });
    try {
      await flushConnection();
      const socket = FakeWebSocket.instances.at(-1)!;
      const data = { repoPath: thread.repoPath, threadId: thread.id, assistantMessageId: 'assistant-continuing' };
      act(() => {
        socket.emit({ channel: 'orchestrator', event: 'output', data: { ...data, text: 'Before tool.' } });
        socket.emit({ channel: 'orchestrator', event: 'tool-use', data: { ...data, toolUseId: 'continuing-tool', name: 'read_file' } });
      });
      await act(async () => {
        socket.emit({ channel: 'orchestrator', event: 'output', data: { ...data, text: 'After tool.' } });
        await new Promise(resolve => setTimeout(resolve, 80));
      });
      expect(values.at(-1)!.transcript.map(entry => [entry.role, entry.text])).toEqual([
        ['assistant', 'Before tool.'], ['tool', 'read_file'], ['assistant', 'After tool.'],
      ]);
      act(() => { values.at(-1)!.sendMessage('Continue from the phone'); });
      expect(socket.sent).toContainEqual(expect.objectContaining({ type: 'orchestrator-send', message: 'Continue from the phone' }));
      act(() => {
        socket.emit({ channel: 'orchestrator', event: 'output', data: { ...data, text: 'Still running.' } });
        socket.emit({ channel: 'orchestrator', event: 'status', data: { ...data, status: 'ready' } });
      });
      const transcript = values.at(-1)!.transcript;
      expect(transcript.filter(entry => entry.role === 'assistant').map(entry => entry.text).join(''))
        .toBe('Before tool.After tool.Still running.');
      expect(transcript.filter(entry => entry.id === 'tool:continuing-tool')).toHaveLength(1);
      expect(transcript).toContainEqual(expect.objectContaining({ role: 'user', text: 'Continue from the phone' }));
    } finally { act(() => { mounted.root.unmount(); mounted.host.remove(); }); }
  });

  it('replays an unacked send after remount and removes it only after send-ack', async () => {
    let current: HookValue | null = null;
    const firstMount = mountHook((value) => { current = value; });
    await flushConnection();

    act(() => {
      current?.sendMessage('Keep this through reload');
    });

    const staged = getPendingQueue('orchestrator', thread.id);
    expect(staged).toHaveLength(1);
    expect(staged[0]?.text).toBe('Keep this through reload');
    const clientMessageId = staged[0]?.id;
    expect(clientMessageId).toBeTruthy();

    act(() => {
      firstMount.root.unmount();
      firstMount.host.remove();
    });

    current = null;
    const secondMount = mountHook((value) => { current = value; });
    await flushConnection();

    const replaySocket = FakeWebSocket.instances.at(-1);
    const replayedSends = replaySocket?.sent.filter((message) => message.type === 'orchestrator-send') ?? [];
    expect(replayedSends).toHaveLength(1);
    expect(replayedSends[0]).toMatchObject({
      message: 'Keep this through reload',
      clientMutationId: clientMessageId,
      threadId: thread.id,
    });

    act(() => {
      replaySocket?.emit({
        channel: 'orchestrator',
        event: 'send-ack',
        data: {
          repoPath: thread.repoPath,
          threadId: thread.id,
          backend: 'codex',
          clientMessageId,
          clientMutationId: clientMessageId,
          state: 'replayed',
          duplicate: true,
        },
      });
    });

    expect(getPendingQueue('orchestrator', thread.id)).toEqual([]);
    const sendsBeforeAnotherConnectedEvent = replayedSends.length;

    act(() => {
      replaySocket?.emit({ channel: 'system', event: 'connected' });
    });
    await flushConnection();

    expect(replaySocket?.sent.filter((message) => message.type === 'orchestrator-send'))
      .toHaveLength(sendsBeforeAnotherConnectedEvent);

    act(() => {
      secondMount.root.unmount();
      secondMount.host.remove();
    });
  });
});
