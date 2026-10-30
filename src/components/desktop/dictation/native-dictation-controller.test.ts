import { afterEach, expect, it, vi } from 'vitest';
import { NativeDictationController, type DictationCommand, type DictationFrame } from './native-dictation-controller';

const target: DictationCommand = { action: 'dictation-start', hostId: 'host', requestId: 'start', binding: 'composer', nonce: 'one', threadId: 'thoughts-chat', repoPath: '/repo' };
const controllers: NativeDictationController[] = [];
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function fixture(ready = Promise.resolve<unknown>(undefined)) {
  const frames: DictationFrame[] = [];
  const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<unknown> => command === 'o8_stt_start' ? 12 : undefined);
  const controller = new NativeDictationController({ ready,
    invoke: invoke as ConstructorParameters<typeof NativeDictationController>[0]['invoke'], emit: frame => frames.push(frame) });
  controllers.push(controller); return { controller, invoke, frames };
}
afterEach(async () => { controllers.splice(0).forEach(controller => controller.dispose()); await flush(); vi.useRealTimers(); });
it('waits for the native listener and cancels before allocating capture', async () => {
  let ready!: () => void;
  const f = fixture(new Promise(resolve => { ready = () => resolve(undefined); }));
  f.controller.command(target); await flush(); expect(f.invoke).not.toHaveBeenCalled();
  f.controller.command({ ...target, action: 'dictation-stop', requestId: 'stop', submit: false });
  ready(); await flush(); expect(f.invoke).not.toHaveBeenCalled();
  expect(f.frames.at(-1)?.payload).toMatchObject({ nonce: 'one', state: 'idle' });
});
it.each(['stop', 'dispose'])('cleans a late native start acknowledgement after %s without stopping another session', async mode => {
  const f = fixture(); let accept!: (sid: unknown) => void;
  f.invoke.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
  f.controller.command(target); await flush();
  if (mode === 'dispose') f.controller.dispose();
  else f.controller.command({ ...target, action: 'dictation-stop', requestId: 'stop', submit: false });
  accept(33); await flush();
  expect(f.invoke).toHaveBeenCalledWith('o8_stt_stop', { sessionId: 33, cancel: true });
  expect(f.frames.some(frame => frame.payload.state === 'listening' || frame.kind === 'dictation-text')).toBe(false);
});
it('buffers pre-ack events, rejects Fn and stale sessions, and sends final text before idle once', async () => {
  const f = fixture(); let accept!: (sid: unknown) => void;
  f.invoke.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
  f.controller.command(target); await flush();
  f.controller.event({ type: 'partial', origin: 'system', sessionId: 33, text: 'Fn' });
  f.controller.event({ type: 'partial', origin: 'in-window', sessionId: 32, text: 'Stale' });
  f.controller.event({ type: 'partial', origin: 'in-window', sessionId: 33, text: 'Partial' });
  accept(33); await flush();
  expect(f.frames.filter(frame => frame.kind === 'dictation-text').map(frame => frame.payload.text)).toEqual(['Partial']);
  f.controller.command({ ...target, action: 'dictation-stop', requestId: 'stop', submit: true }); await flush();
  f.controller.event({ type: 'polished', origin: 'in-window', sessionId: 33, text: 'Final words.' });
  f.controller.event({ type: 'polished', origin: 'in-window', sessionId: 33, text: 'Duplicate' });
  expect(f.frames.slice(-2)).toMatchObject([{ kind: 'dictation-text', payload: { text: 'Final words.', final: true } }, { kind: 'dictation-state', payload: { state: 'idle' } }]);
});
it('cancels while polish is pending and ignores its late result after a replacement binding', async () => {
  const f = fixture(); f.controller.command(target); await flush();
  f.controller.command({ ...target, action: 'dictation-stop', requestId: 'finish', submit: true }); await flush();
  f.controller.command({ ...target, action: 'dictation-stop', requestId: 'cancel', submit: false }); await flush();
  f.invoke.mockResolvedValueOnce(44);
  f.controller.command({ ...target, nonce: 'two', requestId: 'new' }); await flush();
  f.controller.event({ type: 'polished', origin: 'in-window', sessionId: 12, text: 'Old final' });
  f.controller.command({ ...target, action: 'dictation-stop', requestId: 'stale-stop', submit: false });
  expect(f.frames.at(-1)?.payload).toMatchObject({ state: 'listening', nonce: 'two' });
  expect(f.invoke.mock.calls.filter(([command]) => command === 'o8_stt_stop')).toEqual([
    ['o8_stt_stop', { sessionId: 12 }], ['o8_stt_stop', { sessionId: 12, cancel: true }],
  ]);
});
it('reports listener failure without opening the microphone', async () => {
  const f = fixture(Promise.reject(new Error('Native listener unavailable.')));
  f.controller.command(target); await flush();
  expect(f.invoke).not.toHaveBeenCalled();
  expect(f.frames.at(-1)?.payload).toMatchObject({ state: 'error', error: 'Native listener unavailable.' });
});
it('releases ownership and reports failure when native STT errors', async () => {
  const f = fixture(); f.controller.command(target); await flush();
  f.controller.event({ type: 'error', origin: 'in-window', sessionId: 12, text: 'Recognition failed.' }); await flush();
  expect(f.invoke).toHaveBeenCalledWith('o8_stt_stop', { sessionId: 12, cancel: true });
  expect(f.frames.at(-1)?.payload).toMatchObject({ state: 'error', error: 'Recognition failed.' });
});
it('ends a missing final result with an error instead of leaving a binding stuck', async () => {
  vi.useFakeTimers();
  const f = fixture(); f.controller.command(target); await flush();
  f.controller.command({ ...target, action: 'dictation-stop', requestId: 'finish', submit: true }); await flush();
  for (let i = 0; i < 12; i++) {
    await vi.advanceTimersByTimeAsync(10_000); f.controller.replayState('host');
  }
  expect(f.frames.at(-1)?.payload).toMatchObject({ state: 'error', error: expect.stringContaining('No final dictation result') });
});
it('does not replay an old binding or abort a replacement when its old publication fails', async () => {
  const f = fixture(); f.controller.command(target); await flush();
  f.controller.command({ ...target, action: 'dictation-stop', requestId: 'cancel', submit: false }); await flush();
  let accept!: (sid: unknown) => void;
  f.invoke.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
  f.controller.command({ ...target, requestId: 'new' }); await flush();
  const count = f.frames.length;
  f.controller.replayState('host');
  expect(f.frames).toHaveLength(count);
  f.controller.abort('Stale relay failed.', target);
  accept(77); await flush();
  expect(f.frames.at(-1)?.payload).toMatchObject({ nonce: 'one', requestId: 'new', state: 'listening' });
  expect(f.invoke.mock.calls.filter(([command]) => command === 'o8_stt_stop')).toHaveLength(1);
});
it('releases capture when the host lease expires without another ready receipt', async () => {
  vi.useFakeTimers();
  const f = fixture(); f.controller.command(target); await flush();
  f.controller.replayState('host');
  await vi.advanceTimersByTimeAsync(15_001);
  expect(f.invoke).toHaveBeenCalledWith('o8_stt_stop', { sessionId: 12, cancel: true });
  expect(f.frames.at(-1)?.payload).toMatchObject({ state: 'error', error: expect.stringContaining('lease expired') });
});
it('ends Fn-preempted capture idle without delivering a late polished result', async () => {
  const f = fixture(); f.controller.command(target); await flush();
  f.controller.event({ type: 'status', origin: 'in-window', sessionId: 12, text: 'Stopped by Fn' });
  f.controller.event({ type: 'polished', origin: 'in-window', sessionId: 12, text: 'Must never submit' });
  await flush();
  expect(f.frames.at(-1)?.payload).toMatchObject({ state: 'idle', error: 'Stopped by Fn' });
  expect(f.frames.some(frame => frame.kind === 'dictation-text')).toBe(false);
});
it('discards buffered text when Fn preempts before the native start acknowledgement', async () => {
  const f = fixture(); let accept!: (session: unknown) => void;
  f.invoke.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
  f.controller.command(target); await flush();
  f.controller.event({ type: 'partial', origin: 'in-window', sessionId: 55, text: 'Old text' });
  f.controller.event({ type: 'status', origin: 'in-window', sessionId: 55, text: 'Stopped by Fn' });
  accept(55); await flush();
  expect(f.frames.some(frame => frame.kind === 'dictation-text' || frame.payload.state === 'listening')).toBe(false);
  expect(f.frames.at(-1)?.payload).toMatchObject({ state: 'idle', error: 'Stopped by Fn' });
});
it('reports busy for a new binding while the old capture is being retired', async () => {
  const f = fixture(); f.controller.command(target); await flush();
  f.controller.command({ ...target, nonce: 'replacement', requestId: 'replacement-start' });
  expect(f.frames.at(-1)?.payload).toMatchObject({ nonce: 'replacement', state: 'error', error: expect.stringContaining('Another dictation') });
  expect(f.invoke.mock.calls.filter(([name]) => name === 'o8_stt_start')).toHaveLength(1);
  expect(f.invoke.mock.calls.filter(([name]) => name === 'o8_stt_stop')).toHaveLength(0);
  f.controller.command({ ...target, action: 'dictation-stop', requestId: 'retire', submit: false }); await flush();
  expect(f.frames.at(-1)?.payload).toMatchObject({ nonce: target.nonce, state: 'idle' });
});
