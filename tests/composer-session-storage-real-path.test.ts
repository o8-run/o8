/** @vitest-environment jsdom */
import { act, createElement, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/components/desktop/onboarding/useRuntimeInventory', () => ({
  useRuntimeInventory: () => ({ inventory: [], loading: false, error: null, refresh: () => {} }),
}));
vi.mock('@/components/desktop/thoughts/chat-panel/useDurableComposerQueue', () => ({
  useDurableComposerQueue: () => ({ items: [], removing: new Set(), ready: true, error: null, hasPending: () => false }),
}));
const transport = vi.hoisted(() => ({ socket: null as WebSocket | null }));
vi.mock('@/components/desktop/thoughts/use-orchestrator-stream/shared', async (original) => ({
  ...await original<typeof import('@/components/desktop/thoughts/use-orchestrator-stream/shared')>(),
  openOrchestratorWebSocket: () => transport.socket,
}));

import { useOrchestratorStream } from '@/components/desktop/thoughts/useOrchestratorStream';
import { useDefaultComposerSendBuffer } from '@/components/desktop/thoughts/chat-panel/useDefaultComposerSendBuffer';
import { queueOrchestratorSessionPrelude } from '@/lib/orchestrator/store';
import type { ThoughtsAttachedImage } from '@/components/desktop/thoughts/chat-panel/useThoughtsComposerAttachments';

const image = { name: 'fixture.png', mimeType: 'image/png', dataUri: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==' };
const repoPath = '/synthetic/session-storage';
const threadId = 'thoughts-session-storage';
let host: HTMLDivElement;
let root: Root;
function Harness() {
  const stream = useOrchestratorStream(repoPath, { threadId });
  const [input, setInput] = useState('Inspect this picture');
  const [images, setImages] = useState<ThoughtsAttachedImage[]>([image]);
  const latestInputRef = useRef(input);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composer = useDefaultComposerSendBuffer({
    active: true, backend: 'codex', busy: stream.status === 'busy', threadId, repoPath,
    attachedImages: images, latestInputRef, inputRef, setInput,
    addAttachedImage: item => setImages(previous => [...previous, item]),
    clearAttachments: () => setImages([]),
    dispatch: (text, attached) => stream.send(text, { backend: 'codex', model: 'gpt-5.6-sol', attachments: attached }),
    captureQueuedSend: () => { throw new Error('This journey uses an idle direct send.'); },
    interrupt: stream.interrupt, undoSend: stream.undoSend,
    shouldBypass: () => false, sendUnbuffered: () => undefined,
  });
  useEffect(() => { latestInputRef.current = input; }, [input]);
  useEffect(() => {
    inputRef.current = host.querySelector('textarea');
    return () => { inputRef.current = null; };
  }, []);
  return createElement('div', null,
    createElement('textarea', { value: input, readOnly: true }),
    createElement('span', { 'data-image-count': images.length }),
    createElement('button', { onClick: composer.handleSend }, 'Send'),
    createElement('output', null, stream.messages.map(entry => entry.text).join('\n')),
  );
}
function sends() {
  return (transport.socket!.send as ReturnType<typeof vi.fn>).mock.calls
    .map(([payload]) => JSON.parse(payload as string) as Record<string, unknown>)
    .filter(payload => payload.type === 'orchestrator-send');
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  localStorage.clear();
  transport.socket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  await act(async () => transport.socket?.onmessage?.({ data: JSON.stringify({
    channel: 'orchestrator', event: 'status', data: { threadId, backend: 'codex', status: 'ready', snapshot: true },
  }) } as MessageEvent));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => root.unmount());
  host.remove(); transport.socket = null; vi.unstubAllGlobals(); localStorage.clear();
});

it('preserves the exact composer and queued context when storage access rejects, then sends once after recovery', async () => {
  queueOrchestratorSessionPrelude(repoPath, 'Retain the existing project constraints.', 'replace', threadId);
  const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
  await act(async () => host.querySelector('button')!.click());
  expect(host.querySelector('textarea')!.value).toBe('Inspect this picture');
  expect(host.querySelector('[data-image-count]')!.getAttribute('data-image-count')).toBe('1');
  expect(host.querySelector('output')!.textContent).toContain('storage');
  expect(sends()).toHaveLength(0);
  read.mockRestore();
  await act(async () => host.querySelector('button')!.click());
  expect(sends()).toHaveLength(1);
  expect(sends()[0]).toMatchObject({
    threadId, repoPath, displayMessage: 'Inspect this picture',
    attachments: [{ name: image.name, dataUri: image.dataUri }],
  });
  expect(String(sends()[0].message)).toContain('Retain the existing project constraints.');
  expect(host.querySelector('textarea')!.value).toBe('Inspect this picture');
  await act(async () => transport.socket?.onmessage?.({ data: JSON.stringify({
    channel: 'orchestrator', event: 'send-ack', data: { threadId, state: 'accepted', clientMessageId: sends()[0].clientMessageId },
  }) } as MessageEvent));
  expect(host.querySelector('textarea')!.value).toBe('');
  expect(host.querySelector('[data-image-count]')!.getAttribute('data-image-count')).toBe('0');
});
