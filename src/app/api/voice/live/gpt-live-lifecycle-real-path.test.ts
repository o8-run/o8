/** @vitest-environment jsdom */
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { act, createElement, Fragment, useState, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

// Only browser media and paid provider I/O are fixtures. The surface, session,
// /api/voice/live, credential lookup, admission and durable receipts stay real.
const provider = vi.hoisted(() => ({ native: false, listeners: new Map<string, (event: { payload: unknown }) => void>(), sockets: [] as Array<EventEmitter & {
  started: number; sent: Array<Record<string, unknown>>; close: () => void;
}> }));
vi.mock('ws', () => ({ default: class extends EventEmitter {
  static OPEN = 1; static CLOSED = 3;
  readyState = 0; started = Date.now(); sent: Array<Record<string, unknown>> = [];
  constructor() {
    super(); provider.sockets.push(this);
    queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
  }
  send(raw: string) {
    const event = JSON.parse(raw); this.sent.push(event);
    if (event.type === 'session.close') this.emit('message', Buffer.from(JSON.stringify({
      type: 'session.closed', event_id: 'fixture-closed', reason: 'close_requested',
      usage: { seconds: (Date.now() - this.started) / 1000 },
    })));
  }
  terminate() { this.close(); }
  close() { this.readyState = 3; this.emit('close'); }
} }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'live-operator-fixture' }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => provider.native, canUseTauriEvents: () => provider.native,
  currentWindowLabel: () => provider.native ? 'managed-chat-voice' : null }));
vi.mock('@/lib/tauri/events', () => ({ subscribeTauriEvent: (name: string, listener: (event: { payload: unknown }) => void) => {
  provider.listeners.set(name, listener); return () => provider.listeners.delete(name);
} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (command: string, args?: { presentation: unknown }) => {
  if (command === 'managed_voice_presentation_epoch') return 1;
  if (command === 'managed_voice_overlay_update') provider.listeners.get('o8:managed-chat-voice-presentation')?.({ payload: args?.presentation });
} }));
class Peer {
  localDescription = { sdp: 'v=0\nfixture-offer' }; connectionState = 'connected';
  addTrack() {} createDataChannel() {} close() {}
  async createOffer() { return this.localDescription; }
  async setLocalDescription() {} async setRemoteDescription() {}
}
class AudioFixture { srcObject = null; paused = true; async play() {} pause() {} }
class AudioContextFixture {
  async close() {}
  createAnalyser() { return { fftSize: 256, getByteTimeDomainData: (data: Uint8Array) => data.fill(128) }; }
  createMediaStreamSource() { return { connect() {} }; }
}
let directory: string; let root: Root; let container: HTMLDivElement;
let voice: typeof import('./route');
let Button: typeof import('@/components/desktop/thoughts/chat-panel/ManagedLiveButton').ManagedLiveButton;
let Overlay: typeof import('@/app/managed-chat-voice/page').default;
let admissions: Array<{ id: string; context: string; binding: string; source: string }>;
let creations: Array<{ body: { session: { model: string; delegation: { type: string }; instructions: string } }; authorization: string | null }>;
let releaseNarration: (() => void) | undefined;
let holdNarration: boolean;
const send = vi.fn(() => ({ userMessageId: 'new-task' }));
const stopTrack = vi.fn();
const receipt = (index = admissions.length - 1) => JSON.parse(readFileSync(join(directory, 'byok-voice-relay', `${admissions[index].id}.json`), 'utf8'));
const emit = (event: Record<string, unknown>, index = provider.sockets.length - 1) => provider.sockets[index].emit('message', Buffer.from(JSON.stringify(event)));
const flush = async () => { for (let i = 0; i < 30; i++) await setImmediate(); await delay(10); };
const advance = async (milliseconds: number) => act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); await flush(); });
const click = async (button: HTMLButtonElement) => act(async () => { button.click(); await flush(); });
const talk = () => container.querySelector<HTMLButtonElement>('button')!;
async function waitForAdmission(count: number) {
  // Account admission probes the real process on each platform. Let that I/O
  // settle without advancing the provider/idle clock under a slower CI runner.
  for (let attempt = 0; attempt < 200 && admissions.length < count; attempt++) await act(flush);
  expect(admissions, container.textContent ?? '').toHaveLength(count);
}
function Conversation() {
  const [messages, setMessages] = useState<MobileTranscriptEntry[]>([
    { id: 'cli-task', role: 'user', text: 'Check the fixture repository.', timestamp: 1 },
    { id: 'cli-result', role: 'assistant', text: 'The fixture branch is clean.', timestamp: 2 },
  ]);
  const props: ComponentProps<typeof Button> = {
    binding: 'fixture-repo:existing-chat:cli', messages, terminals: {}, busy: false, send, interrupt: vi.fn(),
    answerVisual: async () => 'The fixture result is ready.',
    transcript: entries => setMessages(current => [...new Map([...current, ...entries].map(entry => [entry.id, entry])).values()]),
  };
  return createElement(Button, props);
}
async function start() {
  await act(async () => { root.render(createElement(Fragment, null, createElement(Conversation),
    provider.native ? createElement('div', { 'data-fixture-overlay': true }, createElement(Overlay)) : null)); await flush(); });
  await click(talk());
  const choose = [...document.querySelectorAll('button')].find(button => button.textContent === 'Start Live with my key');
  expect(choose).toBeDefined(); await click(choose!);
  await waitForAdmission(1);
  expect(talk().getAttribute('aria-pressed'), container.textContent ?? '').toBe('true');
}
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-live-lifecycle-')));
  provider.sockets = []; provider.native = false; provider.listeners.clear();
  admissions = []; creations = []; holdNarration = false; releaseNarration = undefined;
  send.mockClear(); stopTrack.mockClear();
  vi.stubEnv('O8_DATA_DIR', directory); vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
  vi.stubEnv('WS_TOKEN', 'live-operator-fixture'); vi.stubEnv('OPENAI_API_KEY', 'sk-live-key-fixture');
  vi.stubEnv('O8_MANAGED_LIVE_ENABLED', '0');
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('RTCPeerConnection', Peer); vi.stubGlobal('Audio', AudioFixture); vi.stubGlobal('AudioContext', AudioContextFixture);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) } });
  voice = await import('./route');
  Button = (await import('@/components/desktop/thoughts/chat-panel/ManagedLiveButton')).ManagedLiveButton;
  Overlay = (await import('@/app/managed-chat-voice/page')).default;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    if (String(input) === 'https://api.openai.com/v1/live/sessions') {
      creations.push({ body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') });
      return Response.json({ session: { id: `live_fixture_${creations.length}` }, transport: { sdp: 'v=0\nfixture-answer' } }, { status: 201 });
    }
    expect(String(input)).toBe('/api/voice/live');
    const request = new Request('http://localhost/api/voice/live', init);
    if (!init?.method || init.method === 'GET') return voice.GET(request);
    const body = JSON.parse(String(init.body));
    const response = await voice.POST(request);
    if (body.action === 'start' && response.ok) admissions.push({ ...body, id: (await response.clone().json()).id });
    if (holdNarration && body.event?.type === 'session.commentary.append') await new Promise<void>(resolve => { releaseNarration = resolve; });
    return response;
  }));
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  releaseNarration?.();
  await act(async () => { root.unmount(); await vi.advanceTimersByTimeAsync(500); await flush(); });
  for (const socket of provider.sockets) socket.close();
  container.remove(); rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
});
it('shows elapsed time and estimated voice cost matching recorded provider duration', async () => {
  await start(); await advance(2000);
  emit({ type: 'session.usage.updated', event_id: 'usage-2', usage: { seconds: 2 } });
  await advance(10_000);
  expect(container.textContent).toContain('0:12 · Est. $0.01');
  emit({ type: 'session.usage.updated', event_id: 'usage-12', usage: { seconds: 12 } });
  await advance(500);
  const status = container.querySelector('[role="status"]');
  expect(status?.textContent ?? '').toContain('0:12 · Est. $0.01');
  expect((status as HTMLElement).style.clipPath).not.toBe('inset(50%)');
  await click(talk()); await advance(500);
  const final = receipt();
  expect(final.finalSeconds).toBe(12.5);
  expect(container.textContent).toContain('0:12 · Est. $0.01');
  expect(creations[0]).toMatchObject({ authorization: 'Bearer sk-live-key-fixture', body: { session: { model: 'gpt-live-1', delegation: { type: 'client' } } } });
});
it('shows the same estimate on the existing desktop voice overlay through its presentation events', async () => {
  provider.native = true; await start(); await advance(12_000);
  emit({ type: 'session.usage.updated', event_id: 'overlay-usage', usage: { seconds: 12 } });
  await advance(500);
  expect(container.querySelector('[data-fixture-overlay]')?.textContent).toContain('0:12 · Est. $0.01');
});
it('closes after silence and resumes the same conversation in one talk gesture', async () => {
  await start(); await advance(1000);
  emit({ type: 'session.input_transcript.delta', event_id: 'heard', delta: 'Remember the blue branch.', start_ms: 0, end_ms: 1000 });
  emit({ type: 'session.output_transcript.delta', event_id: 'said', delta: 'I will remember the blue branch.', start_ms: 0, end_ms: 1000 });
  await advance(30_500);
  expect(receipt()).toMatchObject({ state: 'closed', finalSeconds: 31 });
  expect(stopTrack).toHaveBeenCalledOnce();
  await advance(60_000); expect(creations).toHaveLength(1);
  await click(talk());
  await waitForAdmission(2);
  expect(admissions.map(item => item.binding)).toEqual(['fixture-repo:existing-chat:cli', 'fixture-repo:existing-chat:cli']);
  expect(admissions.map(item => item.source)).toEqual(['byok', 'byok']);
  expect(admissions[1].context).toContain('Remember the blue branch.');
  expect(admissions[1].context).toContain('I will remember the blue branch.');
  expect(admissions[1].context).toContain('The fixture branch is clean.');
  await advance(1000); expect(container.textContent).toContain('0:01 · Est. $0.00');
  expect(send).not.toHaveBeenCalled();
});
it('keeps queued narration alive, then closes after its quiet window', async () => {
  await start(); await advance(1000); holdNarration = true;
  emit({ type: 'session.input_transcript.delta', event_id: 'ask', delta: 'Read the result.', start_ms: 0, end_ms: 1000 });
  emit({ type: 'session.delegation.created', event_id: 'delegate', offset_ms: 1000, delegation: { id: 'read-result', target: 'client' } });
  await advance(500); expect(releaseNarration).toBeDefined();
  await advance(35_000); expect(receipt().state).toBe('active');
  await act(async () => { holdNarration = false; releaseNarration?.(); await flush(); });
  await advance(29_000); expect(receipt().state).toBe('active');
  await advance(2000); expect(receipt().state).toBe('closed');
});
it('shows the session-limit notice and continues once without changing key or context', async () => {
  await start();
  for (let i = 1; i <= 15; i++) {
    await advance(19_000);
    emit({ type: 'session.input_transcript.delta', event_id: `speech-${i}`, delta: 'Still here.', start_ms: i * 19_000 - 1000, end_ms: i * 19_000 });
    await advance(500);
  }
  await advance(8000);
  expect(receipt()).toMatchObject({ state: 'closed', finalSeconds: 300 });
  expect(container.textContent).toContain('5:00 · Est. $0.25 · Session limit reached.');
  expect(talk().textContent).toContain('Continue');
  expect(talk().getAttribute('aria-label')).toBe('Continue GPT Live for this conversation');
  await click(talk()); await waitForAdmission(2);
  expect(admissions[1].context).toContain('The fixture branch is clean.');
  expect(creations.every(item => item.authorization === 'Bearer sk-live-key-fixture')).toBe(true);
  expect(send).not.toHaveBeenCalled();
});
