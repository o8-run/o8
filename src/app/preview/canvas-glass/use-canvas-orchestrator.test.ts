// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useCanvasOrchestrator, useThreadOrchestrator } from './use-canvas-orchestrator';

vi.mock('@/components/desktop/thoughts/use-orchestrator-stream/shared', () => ({ getWsUrl: () => 'ws://fixture' }));

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { Socket.instances.push(this); }
  send() {}
  close() { this.onclose?.(); }
  status(status: string, seq: number, reason?: string) {
    this.onmessage?.({ data: JSON.stringify({ channel: 'orchestrator', event: 'status', seq,
      data: { status, reason, repoPath: '/repo', threadId: 'thread', backend: 'codex' } }) } as MessageEvent);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.localStorage.clear();
});

it.each(['repo', 'thread'])('shows unreported attention and reason through the %s canvas handler', mode => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  const onStatus = vi.fn();
  const onEvent = vi.fn();
  function Harness() {
    const repo = useCanvasOrchestrator(mode === 'repo' ? '/repo' : null, { onStatus });
    const thread = useThreadOrchestrator(mode === 'thread' ? '/repo' : null, 'thread', onEvent);
    return createElement('output', null, mode === 'repo' ? repo.status : thread.status);
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(Harness)));
    const socket = Socket.instances[0];
    act(() => socket.onopen?.());
    act(() => socket.status('busy', 1));
    expect(host.textContent).toBe('busy');
    const reason = 'turn ended without an outcome report';
    act(() => socket.status('unreported', 2, reason));
    expect(host.textContent).toBe('unreported');
    if (mode === 'repo') expect(onStatus).toHaveBeenLastCalledWith('/repo', 'unreported', reason);
    else expect(onEvent).toHaveBeenLastCalledWith({ type: 'status', status: 'unreported', reason });
  } finally {
    act(() => root.unmount());
  }
});
