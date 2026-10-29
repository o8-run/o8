// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const fixtures = vi.hoisted(() => ({ start: vi.fn(), invoke: vi.fn(async () => []) }));
vi.mock('./ManagedSymonVoiceHost', () => ({ ManagedSymonVoiceHost: () => null }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true, canUseTauriEvents: () => true }));
vi.mock('@/lib/mobile/ws-token-client', () => ({ getMobileWsToken: () => 'fixture' }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixtures.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@/lib/voice/realtime-client', () => ({ startRealtimeSession: fixtures.start }));
vi.mock('@/lib/symon/voice-transcript-recorder', () => ({ createSymonVoiceTranscriptRecorder: () => ({ observe: () => {} }) }));
import { RealtimeVoiceHost } from './RealtimeVoiceHost';
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it.each([false, true])('disconnect cancels pending Symon availability selection (managed=%s)', async enabled => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let resolve!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const managedToggle = vi.fn(); window.addEventListener('o8:managed-symon-toggle', managedToggle);
  const host = document.createElement('div'); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(RealtimeVoiceHost)));
    await act(async () => window.dispatchEvent(new Event('o8:symon-voice-toggle')));
    await act(async () => window.dispatchEvent(new Event('o8:voice-host-stop-all')));
    await act(async () => resolve(Response.json({ enabled })));
    expect(fixtures.start).not.toHaveBeenCalled();
    expect(managedToggle).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount()); window.removeEventListener('o8:managed-symon-toggle', managedToggle);
  }
});
