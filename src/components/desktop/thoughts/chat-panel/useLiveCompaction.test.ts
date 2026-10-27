// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopWebSocketProvider } from '@/components/desktop/hooks/DesktopWebSocketContext';
import { useLiveCompaction } from './useLiveCompaction';
import type { RealtimeDeliveryMode, RealtimeMutationRecord } from '@/lib/realtime/types';

vi.mock('@/lib/panel/ws-port-client', () => ({ getBrowserWsPort: () => 47125 }));
class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  send() {}
  close() {}
  constructor() { FakeSocket.instances.push(this); }
}
let root: Root;
let host: HTMLDivElement;
let seq = 0;
const scope = { repoPath: '/repo/sample', surfaceId: 'thoughts-live' };
function View({ threadId = scope.surfaceId }: { threadId?: string }) {
  const active = useLiveCompaction(scope.repoPath, threadId);
  return createElement('output', null, String(active));
}
function render(threadId = scope.surfaceId) {
  act(() => root.render(createElement(DesktopWebSocketProvider, null, createElement(View, { threadId }))));
}
function receive(id: string, status: RealtimeMutationRecord['status'], patch: Partial<RealtimeMutationRecord> = {}, delivery: RealtimeDeliveryMode = 'live') {
  const mutation: RealtimeMutationRecord = { ...scope, mutationId: id, source: 'server', action: 'orchestrator-compaction',
    status, createdAt: new Date().toISOString(), ...patch };
  act(() => FakeSocket.instances.at(-1)!.onmessage?.({ data: JSON.stringify({ channel: 'realtime', event: 'batch', data: {
    delivery, stream: 'global', events: [{ protocol: 1, seq: ++seq, stream: 'global', channel: 'mutation', event: status === 'pending' ? 'mutation.record' : 'mutation.settled',
      ts: mutation.createdAt, data: { mutation } }],
  } }) } as MessageEvent));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', FakeSocket);
  FakeSocket.instances = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  render();
  act(() => FakeSocket.instances.at(-1)!.onopen?.());
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('uses server operation IDs so an older finish cannot hide another live compaction', () => {
  receive('one', 'pending'); expect(host.textContent).toBe('true');
  receive('two', 'pending'); receive('one', 'completed'); expect(host.textContent).toBe('true');
  receive('two', 'failed'); expect(host.textContent).toBe('false');
  receive('one', 'pending'); expect(host.textContent).toBe('false');
});
it('ignores replayed starts, old failures, other threads, other repositories and non-server events', () => {
  receive('old', 'pending', {}, 'replay');
  receive('checkpoint', 'pending', {}, 'bootstrap');
  receive('failure', 'failed');
  receive('other-thread', 'pending', { surfaceId: 'thoughts-other' });
  receive('other-repo', 'pending', { repoPath: '/repo/other' });
  receive('client', 'pending', { source: 'desktop' });
  expect(host.textContent).toBe('false');
});
it('forgets the prior view when switching threads, even when returning before its finish', () => {
  receive('one', 'pending'); expect(host.textContent).toBe('true');
  render('thoughts-other'); expect(host.textContent).toBe('false');
  render(); expect(host.textContent).toBe('false');
  receive('one', 'failed'); expect(host.textContent).toBe('false');
});
