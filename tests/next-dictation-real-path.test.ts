// @vitest-environment jsdom
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, Fragment } from 'react';
import { createRoot } from 'react-dom/client';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

const hardware = vi.hoisted(() => ({ listeners: new Map<string, (event: { payload: Record<string, unknown> }) => void>(),
  invoke: vi.fn(), socket: null as WebSocket | null, token: '', url: '', native: 0, browser: false, next: 100 }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true, canUseTauriEvents: () => true }));
vi.mock('@/lib/tauri/events', () => ({
  listenTauriEvent: async (name: string, callback: (event: { payload: Record<string, unknown> }) => void) => {
    hardware.listeners.set(name, callback); return async () => { hardware.listeners.delete(name); };
  },
  subscribeTauriEvent: () => () => {},
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: hardware.invoke }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => hardware.token }));
vi.mock('@/components/desktop/thoughts/use-orchestrator-stream/shared', () => ({ openOrchestratorWebSocket: () => { hardware.socket = new WebSocket(hardware.url); return hardware.socket; } }));
vi.mock('@/lib/voice/managed-live/symon-backend', () => ({ subscribeManagedSymonConfirmation: () => () => {} }));
import { ChatLiveHost } from '@/components/desktop/dictation/ChatLiveHost';

let reference: Awaited<ReturnType<typeof startParityReference>>;
let origin = '';
let root: ReturnType<typeof createRoot>;
let node: HTMLDivElement;
let observer: WebSocket;
const frames: Array<{ kind?: string; payload?: Record<string, unknown> }> = [];
const target = { binding: 'composer', nonce: 'dictation-one', threadId: 'thoughts-dictation', repoPath: '' };
const realFetch = globalThis.fetch;
const post = (body: unknown) => realFetch(`${origin}/api/next/voice-host`, { method: 'POST',
  headers: { authorization: `Bearer ${hardware.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
beforeAll(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  reference = await startParityReference({ nativeHttp: true });
  origin = reference.url.replace('ws:', 'http:').replace('/ws', '');
  target.repoPath = reference.directory; hardware.token = reference.token;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const response = await realFetch(new URL(url, origin), init);
    return response;
  });
  (window as Window & { __O8_VOICE_HOST__?: boolean }).__O8_VOICE_HOST__ = true;
  hardware.invoke.mockImplementation(async (command: string, args?: { exclusive?: boolean; sessionId?: number }) => {
    if (command === 'o8_stt_start') {
      if (hardware.browser || args?.exclusive && hardware.native) throw new Error('Another voice input is active. Finish it before starting another microphone.');
      hardware.native = ++hardware.next; return hardware.native;
    }
    if (command === 'o8_stt_stop' && args?.sessionId === hardware.native) hardware.native = 0;
  });
}, 60_000);
afterAll(async () => {
  if (root) await act(async () => root.unmount());
  node?.remove(); observer?.terminate(); hardware.socket?.terminate();
  await reference?.stop(); vi.unstubAllGlobals();
});
it('answers 503 promptly before the host is mounted', async () => {
  const start = Date.now();
  const response = await post({ action: 'dictation-start', requestId: 'start-unavailable', ...target });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: 'VOICE_HOST_UNAVAILABLE' });
  expect(Date.now() - start).toBeLessThan(2500);
});
it('drives the actual route, WS bridge and textarea-free native host', async () => {
  observer = new WebSocket(`${reference.url}?token=${hardware.token}`);
  observer.on('message', bytes => frames.push(JSON.parse(String(bytes))));
  await once(observer, 'open');
  hardware.url = `${reference.url}?token=${hardware.token}`;
  const path = resolve('src/components/desktop/dictation/HeadlessDictationHost.tsx');
  const Headless = existsSync(path) ? (await import(path)).HeadlessDictationHost : () => null;
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
  await act(async () => root.render(createElement(Fragment, null, createElement(Headless), createElement(ChatLiveHost))));
  await vi.waitFor(async () => expect((await realFetch(`${origin}/api/next/voice-host`, { headers: { authorization: `Bearer ${hardware.token}` } })).status).toBe(200), { timeout: 8000 });
  expect((await post({ action: 'dictation-start', requestId: 'dictate-start', ...target })).status).toBe(202);
  await vi.waitFor(() => expect(hardware.invoke).toHaveBeenCalledWith('o8_stt_start', { exclusive: true }));
  expect(node.querySelector('textarea')).toBeNull();
  await received('dictation-state', target.nonce, { state: 'listening' });
  const sessionId = hardware.native;
  await nativeEvent({ type: 'partial', origin: 'system', sessionId, text: 'Fn must not land here' });
  await nativeEvent({ type: 'partial', origin: 'in-window', sessionId: sessionId - 1, text: 'Old session' });
  await nativeEvent({ type: 'partial', origin: 'in-window', sessionId, text: 'Check the' });
  await received('dictation-text', target.nonce, { text: 'Check the', final: false });
  expect(frames.some(frame => frame.payload?.text === 'Fn must not land here' || frame.payload?.text === 'Old session')).toBe(false);
  expect((await post({ action: 'dictation-stop', requestId: 'stop-stale', ...target, nonce: 'old', submit: true })).status).toBe(409);
  expect(hardware.native).toBe(sessionId);
  expect((await post({ action: 'dictation-stop', requestId: 'dictate-stop', ...target, submit: true })).status).toBe(202);
  await vi.waitFor(() => expect(hardware.native).toBe(0));
  await nativeEvent({ type: 'polished', origin: 'in-window', sessionId, text: 'Check the build.' });
  await received('dictation-text', target.nonce, { text: 'Check the build.', final: true });
  await received('dictation-state', target.nonce, { state: 'idle' });
  await nativeEvent({ type: 'polished', origin: 'in-window', sessionId, text: 'Duplicate final' });
  expect(frames.filter(frame => frame.kind === 'dictation-text' && frame.payload?.final)).toHaveLength(1);
});
async function nativeEvent(payload: Record<string, unknown>) {
  await act(async () => hardware.listeners.get('o8:stt-event')?.({ payload }));
}
async function received(kind: string, nonce: string, payload: Record<string, unknown>) {
  await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ kind,
    payload: expect.objectContaining({ binding: target.binding, nonce, threadId: target.threadId, repoPath: target.repoPath, ...payload }),
  })), { timeout: 5000 });
}
it('cancels without a final, rejects stale text, and binds retry IDs to their request body', async () => {
  const next = { ...target, nonce: 'cancelled' };
  const body = { action: 'dictation-start', requestId: 'cancel-start', ...next };
  expect((await post(body)).status).toBe(202);
  expect((await post(body)).status).toBe(202);
  expect((await post({ ...body, nonce: 'changed' })).status).toBe(409);
  await received('dictation-state', next.nonce, { state: 'listening' });
  const sessionId = hardware.native;
  expect((await post({ action: 'dictation-stop', requestId: 'cancel-stop', ...next, submit: false })).status).toBe(202);
  await received('dictation-state', next.nonce, { state: 'idle' });
  await nativeEvent({ type: 'polished', origin: 'in-window', sessionId, text: 'Must not submit' });
  expect(frames.some(frame => frame.kind === 'dictation-text' && frame.payload?.nonce === next.nonce && frame.payload.final)).toBe(false);
  const hostId = frames.find(frame => frame.payload?.action === 'dictation-start')!.payload!.hostId;
  const response = await realFetch(`${origin}/internal/next/voice-host`, { method: 'POST', headers: { authorization: `Bearer ${hardware.token}` },
    body: JSON.stringify({ action: 'publish', kind: 'dictation-text', payload: { ...target, hostId, text: 'stale', final: true } }),
  });
  expect(response.status).toBe(409);
  expect((await post({ action: 'dictation-start', requestId: 'same-binding-retry', ...next })).status).toBe(202);
  await received('dictation-state', next.nonce, { state: 'listening', requestId: 'same-binding-retry' });
  expect((await post({ action: 'dictation-stop', requestId: 'same-binding-stop', ...next, submit: false })).status).toBe(202);
  await received('dictation-state', next.nonce, { state: 'idle', requestId: 'same-binding-retry' });
});
it.each(['Fn', 'Live'])('reports busy without taking the microphone from %s', async owner => {
  const next = { ...target, nonce: `busy-${owner}` };
  hardware.native = owner === 'Fn' ? 700 : 0; hardware.browser = owner === 'Live';
  const before = hardware.invoke.mock.calls.filter(([name]) => name === 'o8_stt_stop').length;
  expect((await post({ action: 'dictation-start', requestId: `start-${owner}`, ...next })).status).toBe(202);
  await received('dictation-state', next.nonce, { state: 'error', error: expect.stringContaining('Another voice input is active') });
  expect(hardware.native).toBe(owner === 'Fn' ? 700 : 0);
  expect(hardware.browser).toBe(owner === 'Live');
  expect(hardware.invoke.mock.calls.filter(([name]) => name === 'o8_stt_stop')).toHaveLength(before);
  hardware.native = 0; hardware.browser = false;
});
it('keeps admitting sessions beyond its bounded request receipt cache', async () => {
  hardware.native = 700;
  for (let i = 0; i < 130; i++) {
    const nonce = `many-${i}`;
    expect((await post({ action: 'dictation-start', requestId: `many-start-${i}`, ...target, nonce })).status).toBe(202);
    await received('dictation-state', nonce, { state: 'error' });
  }
  expect(hardware.native).toBe(700);
  expect((await post({ action: 'dictation-start', requestId: 'reuse-recent', ...target, nonce: 'many-129' })).status).toBe(202);
  await received('dictation-state', 'many-129', { state: 'error', requestId: 'reuse-recent' });
  hardware.native = 0;
}, 30_000);
it('releases its exact native session on transport loss', async () => {
  const next = { ...target, nonce: 'disconnect' };
  expect((await post({ action: 'dictation-start', requestId: 'disconnect-start', ...next })).status).toBe(202);
  await received('dictation-state', next.nonce, { state: 'listening' });
  const sessionId = hardware.native;
  await act(async () => hardware.socket!.close());
  await vi.waitFor(() => expect(hardware.invoke).toHaveBeenCalledWith('o8_stt_stop', { sessionId }));
  await vi.waitFor(() => expect(hardware.native).toBe(0));
});
