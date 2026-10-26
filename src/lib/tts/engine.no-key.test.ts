/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ invoke: vi.fn(async () => {}), speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), events: new Map<string, (event: { payload: Record<string, unknown> }) => void>() }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name, handler) => { fixture.events.set(name, handler); return () => {}; }) }));
let engine: typeof import('./engine')['ttsEngine'];
class TestAudio {
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playbackRate = 1;
  currentTime = 0;
  duration = 1;
  play = vi.fn(async () => { this.onplay?.(); });
  pause = fixture.pause;
}
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); fixture.events.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('mp3', { status: 200 })));
  vi.stubGlobal('Audio', TestAudio);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('speechSynthesis', { getVoices: () => [], speak: fixture.speak, cancel: fixture.cancel });
  vi.stubGlobal('SpeechSynthesisUtterance', class { onend = null; onerror = null; rate = 1; lang = ''; });
  URL.createObjectURL = vi.fn(() => 'blob:test'); URL.revokeObjectURL = vi.fn();
  engine = (await import('./engine')).ttsEngine;
});
afterEach(() => { engine.stop(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('uses only the existing Edge endpoint on native desktop and stops its browser audio without a premium command', async () => {
  await engine.playNoKey('**Confirmed** reply', 'turn-voice:chat:turn');
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/tts', expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Confirmed reply', voice: 'en-US-SteffanNeural' }) }));
  expect(fixture.invoke).not.toHaveBeenCalled();
  expect(engine.state.activeMessageId).toBe('turn-voice:chat:turn');
  engine.stop(); expect(fixture.pause).toHaveBeenCalled();
  expect(engine.state.activeMessageId).toBeNull(); expect(fixture.invoke).not.toHaveBeenCalled();
});
it('falls back to system speech only when Edge fails and never invokes paid native reading', async () => {
  vi.mocked(fetch).mockRejectedValue(new Error('offline'));
  await engine.playNoKey('Confirmed reply', 'turn-voice:chat:turn');
  expect(fixture.speak).toHaveBeenCalledOnce(); expect(engine.state.usingFallback).toBe(true);
  expect(fixture.invoke).not.toHaveBeenCalled();
});
it.each(['edge_voice_update_required', 'edge_voice_unavailable'])('publishes %s before system speech and clears it on retry', async code => {
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ code, error: 'Steffan unavailable' }, { status: 503 }));
  const states: unknown[] = [];
  const unsubscribe = engine.subscribe(state => states.push({ ...state }));
  fixture.speak.mockImplementationOnce(() => {
    expect(engine.state).toMatchObject({ voiceError: code, usingFallback: true });
    expect(states).toContainEqual(expect.objectContaining({ voiceError: code, state: 'loading' }));
  });
  await engine.playNoKey('Confirmed reply', 'turn-voice:chat:turn');
  expect(fixture.speak).toHaveBeenCalledOnce();
  expect(engine.state).toMatchObject({ voiceError: code });
  await engine.playNoKey('Retry', 'retry');
  expect(engine.state).toMatchObject({ voiceError: null, usingFallback: false });
  unsubscribe();
});
it('ignores late Edge rejection after the owned playback was stopped', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(fetch).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  const playing = engine.playNoKey('Old reply', 'turn-voice:chat:turn');
  engine.stop(); reject(new Error('late failure')); await playing;
  expect(fixture.speak).not.toHaveBeenCalled(); expect(engine.state.activeMessageId).toBeNull();
});
it.each(['edge_voice_update_required', 'edge_voice_unavailable'])('reflects native say fallback with %s and clears it on retry', async voiceError => {
  await engine.play('Reply', 'reply');
  await vi.waitFor(() => expect(fixture.events.has('o8:tts-state')).toBe(true));
  fixture.events.get('o8:tts-state')!({ payload: { state: 'playing', messageId: 'reply', usingFallback: true, voiceError } });
  expect(engine.state).toMatchObject({ state: 'playing', activeMessageId: 'reply', usingFallback: true, voiceError });
  expect(fixture.speak).not.toHaveBeenCalled();
  await engine.play('Retry', 'retry');
  expect(engine.state).toMatchObject({ usingFallback: false, voiceError: null });
});
it.each(['stop', 'native-replacement', 'web-replacement'])('ignores stale native say fallback after %s', async action => {
  await engine.play('Old reply', 'old');
  await vi.waitFor(() => expect(fixture.events.has('o8:tts-state')).toBe(true));
  if (action === 'stop') engine.stop();
  else if (action === 'native-replacement') await engine.play('New reply', 'new');
  else await engine.playNoKey('Web reply', 'old');
  const before = { ...engine.state };
  fixture.events.get('o8:tts-state')!({ payload: { state: 'playing', messageId: 'old', usingFallback: true, voiceError: 'edge_voice_update_required' } });
  expect(engine.state).toEqual(before);
});
it.each(['stop', 'new-turn'])('ignores a late native failure after %s took playback ownership', async action => {
  let reject!: (error: Error) => void;
  fixture.invoke.mockImplementation(async (...args: unknown[]) => {
    if (args[0] === 'tts_speak') await new Promise<void>((_resolve, fail) => { reject = fail; });
  });
  const previous = engine.play('Previous chat reply', 'old-chat-message');
  await vi.waitFor(() => expect(reject).toBeTypeOf('function'));
  if (action === 'stop') engine.stop();
  else await engine.playNoKey('Current turn reply', 'turn-voice:current-chat:turn');
  reject(new Error('late native failure')); await previous;
  const requests = vi.mocked(fetch).mock.calls.map(([, options]) => JSON.parse(String(options?.body)).text);
  expect(requests).toEqual(action === 'stop' ? [] : ['Current turn reply']);
  expect(engine.state.activeMessageId).toBe(action === 'stop' ? null : 'turn-voice:current-chat:turn');
});
