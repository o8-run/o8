/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => false }));
vi.mock('@/components/mobile/ThemeContext', () => ({ useTheme: () => ({ colors: {} }) }));

let root: Root;
let host: HTMLDivElement;
let engine: typeof import('@/lib/tts/engine')['ttsEngine'];

beforeEach(async () => {
  vi.resetModules();
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
