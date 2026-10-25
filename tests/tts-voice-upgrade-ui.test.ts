/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ enabled: false, invoke: vi.fn(async () => {}), events: new Map<string, (event: { payload: Record<string, unknown> }) => void>() }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => native.enabled }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name, handler) => { native.events.set(name, handler); return () => {}; }) }));
vi.mock('@/components/mobile/ThemeContext', () => ({ useTheme: () => ({ colors: {} }) }));

let root: Root;
let host: HTMLDivElement;
let engine: typeof import('@/lib/tts/engine')['ttsEngine'];

beforeEach(async () => {
  vi.resetModules();
  native.enabled = false; native.events.clear(); vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'edge_voice_update_required' }, { status: 503 })));
  vi.stubGlobal('speechSynthesis', { getVoices: () => [], speak: vi.fn(), cancel: vi.fn() });
  vi.stubGlobal('SpeechSynthesisUtterance', class { rate = 1; lang = ''; });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  engine = (await import('@/lib/tts/engine')).ttsEngine;
});
afterEach(async () => {
  await act(async () => { engine.stop(); root.unmount(); });
  host.remove(); vi.unstubAllGlobals();
});

it.each(['desktop', 'mobile'])('shows the typed voice failure on the %s play control through the real engine', async surface => {
  const props = { messageId: 'reply', messageText: 'Hello' };
  const element = surface === 'desktop'
    ? createElement((await import('@/components/desktop/MessageActions')).MessageActions, props)
    : createElement((await import('@/components/mobile/MessageActions')).MessageActions, { ...props, visible: true });
  await act(async () => root.render(element));
  await act(async () => { await engine.playNoKey('Hello', 'reply'); });
  expect(speechSynthesis.speak).toHaveBeenCalledOnce();
  expect(host.querySelector('[role="status"]')?.textContent).toContain('Steffan needs a voice update');
  expect(host.querySelector('button[title*="Steffan needs a voice update"]')).not.toBeNull();
});

it.each([
  ['edge_voice_update_required', 'Steffan needs a voice update'],
  ['edge_voice_unavailable', 'Steffan is unavailable'],
])('shows %s when the native desktop play button falls back to say', async (voiceError, notice) => {
  native.enabled = true;
  const { MessageActions } = await import('@/components/desktop/MessageActions');
  await act(async () => root.render(createElement(MessageActions, { messageId: 'reply', messageText: 'Hello' })));
  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[title="Play"]')!.click();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('tts_speak', { text: 'Hello', messageId: 'reply' }));
    await vi.waitFor(() => expect(native.events.has('o8:tts-state')).toBe(true));
    native.events.get('o8:tts-state')!({ payload: { state: 'playing', messageId: 'reply', usingFallback: true, voiceError } });
  });
  expect(engine.state).toMatchObject({ voiceError, usingFallback: true });
  expect(host.querySelector('[role="status"]')?.textContent).toContain(notice);
  expect(host.querySelector(`button[title*="${notice}"]`)).not.toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  expect(speechSynthesis.speak).not.toHaveBeenCalled();
});
