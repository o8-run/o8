/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined), speak: vi.fn(), cancel: vi.fn() }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
let engine: typeof import('./engine')['ttsEngine'];
const platform = window as unknown as { __O8_HOST_PLATFORM__?: string };
const calls = (cmd: string) => fixture.invoke.mock.calls.filter(([name]) => name === cmd);

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks();
  platform.__O8_HOST_PLATFORM__ = 'linux';
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1)); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('speechSynthesis', { getVoices: () => [], speak: fixture.speak, cancel: fixture.cancel });
  vi.stubGlobal('SpeechSynthesisUtterance', class { onend = null; onerror = null; rate = 1; lang = ''; });
  engine = (await import('./engine')).ttsEngine;
});
afterEach(() => { engine.stop(); delete platform.__O8_HOST_PLATFORM__; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('speaks through the Linux system engine before WebKitGTK speechSynthesis', async () => {
  let finish!: (done: boolean) => void;
  fixture.invoke.mockImplementation(async (cmd) => {
    if (cmd === 'system_tts_speak') return new Promise<boolean>((resolve) => { finish = resolve; });
  });
  engine.setRate(1.5);
  // Let each fire-and-forget invoke land before the next one: concurrent first
  // dynamic imports of a mocked module can resolve the real one under vitest.
  await vi.waitFor(() => expect(calls('tts_set_speed')).toHaveLength(1));
  await engine.playNoKey('**Offline** reply', 'm1');
  await vi.waitFor(() => expect(calls('system_tts_speak')).toHaveLength(1));
  expect(calls('system_tts_speak')[0][1]).toEqual({ text: 'Offline reply', speed: 1.5 });
  expect(engine.state).toMatchObject({ state: 'playing', activeMessageId: 'm1', usingFallback: true });
  finish(true);
  await vi.waitFor(() => expect(engine.state).toMatchObject({ state: 'idle', activeMessageId: null }));
  expect(fixture.speak).not.toHaveBeenCalled();
});

it('stops system speech on stop and starts the next one', async () => {
  fixture.invoke.mockImplementation(async (cmd) => {
    if (cmd === 'system_tts_speak') return new Promise<boolean>(() => {});
  });
  await engine.playNoKey('First', 'm1');
  await vi.waitFor(() => expect(calls('system_tts_speak')).toHaveLength(1));
  engine.stop();
  await vi.waitFor(() => expect(calls('system_tts_stop')).toHaveLength(1));
  expect(engine.state.activeMessageId).toBeNull();

  await engine.playNoKey('Second', 'm2');
  await vi.waitFor(() => expect(calls('system_tts_speak')).toHaveLength(2));
  engine.stop();
  await vi.waitFor(() => expect(calls('system_tts_stop')).toHaveLength(2));
  await engine.playNoKey('Third', 'm3');
  await vi.waitFor(() => expect(calls('system_tts_speak')).toHaveLength(3));
  expect(engine.state.activeMessageId).toBe('m3');
});

it('falls back to speechSynthesis when no Linux engine is installed', async () => {
  fixture.invoke.mockImplementation(async (cmd) => {
    if (cmd === 'system_tts_speak') throw new Error('no Linux text-to-speech engine found');
  });
  await engine.playNoKey('Reply', 'm1');
  await vi.waitFor(() => expect(fixture.speak).toHaveBeenCalledOnce());
  expect(engine.state).toMatchObject({ state: 'playing', activeMessageId: 'm1', usingFallback: true });
});

it('ignores a late system speech result after the user moved on', async () => {
  let fail!: (error: Error) => void;
  fixture.invoke.mockImplementation(async (cmd) => {
    if (cmd === 'system_tts_speak') return new Promise<boolean>((_resolve, reject) => { fail = reject; });
  });
  await engine.playNoKey('Old', 'm1');
  await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
  engine.stop();
  fail(new Error('killed'));
  await new Promise((r) => setTimeout(r, 0));
  expect(fixture.speak).not.toHaveBeenCalled();
  expect(engine.state.activeMessageId).toBeNull();
});

it('leaves macOS and browser shells on speechSynthesis', async () => {
  platform.__O8_HOST_PLATFORM__ = 'macos';
  await engine.playNoKey('Reply', 'm1');
  expect(fixture.speak).toHaveBeenCalledOnce();
  expect(calls('system_tts_speak')).toHaveLength(0);
});
