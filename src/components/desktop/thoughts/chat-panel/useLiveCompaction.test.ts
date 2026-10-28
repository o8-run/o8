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
const operations = new Map<string, import('@/lib/orchestrator/compaction-status').CompactionOperation>();
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
  if (mutation.source === 'server' && mutation.repoPath === scope.repoPath && mutation.surfaceId === scope.surfaceId && delivery === 'live') {
    const prior = operations.get(id);
    operations.set(id, { operationId: id, repoPath: scope.repoPath, threadId: scope.surfaceId,
      phase: status === 'pending' ? 'compacting' : status === 'completed' ? 'complete' : 'failed',
      requestedAt: prior?.requestedAt ?? Date.now() + seq, startedAt: prior?.startedAt ?? Date.now(), updatedAt: Date.now(),
      ...(status === 'pending' ? {} : { settledAt: Date.now() }) });
  }
  act(() => FakeSocket.instances.at(-1)!.onmessage?.({ data: JSON.stringify({ channel: 'realtime', event: 'batch', data: {
    delivery, stream: 'global', events: [{ protocol: 1, seq: ++seq, stream: 'global', channel: 'mutation', event: status === 'pending' ? 'mutation.record' : 'mutation.settled',
      ts: mutation.createdAt, data: { mutation } }],
  } }) } as MessageEvent));
}
beforeEach(() => {
  operations.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const target = new URL(input, 'http://localhost').searchParams.get('threadId');
    const operation = target === scope.surfaceId ? [...operations.values()].sort((a, b) => b.requestedAt - a.requestedAt)[0] ?? null : null;
    return Response.json({ operation });
  }));
  FakeSocket.instances = [];
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  render();
  act(() => FakeSocket.instances.at(-1)!.onopen?.());
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function reconcile() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
it('uses server operation IDs so an older finish cannot hide another live compaction', async () => {
  receive('one', 'pending'); await reconcile(); expect(host.textContent).toBe('true');
  receive('two', 'pending'); receive('one', 'completed'); await reconcile(); expect(host.textContent).toBe('true');
  receive('two', 'failed'); await reconcile(); expect(host.textContent).toBe('false');
  receive('one', 'pending'); await reconcile(); expect(host.textContent).toBe('false');
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
it('reconciles each thread independently when switching and returning before its finish', async () => {
  receive('one', 'pending'); await reconcile(); expect(host.textContent).toBe('true');
  render('thoughts-other'); expect(host.textContent).toBe('false');
  await reconcile(); render(); await reconcile(); expect(host.textContent).toBe('true');
  receive('one', 'failed'); await reconcile(); expect(host.textContent).toBe('false');
});
