import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChildProcess } from '@/lib/providers/child-process';
import { bindNextBrowserPipe } from '@/lib/next/browser-pipe';
import { POST } from './route';

const settings = vi.hoisted(() => ({ enabled: false, reads: 0 }));
vi.mock('@/lib/operator/defaults', () => ({ getOperatorDefaults: async () => { settings.reads++; return { values: { nativeDictationPill: settings.enabled } }; } }));
afterEach(() => { settings.enabled = false; settings.reads = 0; vi.useRealTimers(); });
it('defaults to web without sending any pipe frame when disabled', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
  bindNextBrowserPipe(child as unknown as ChildProcess);
  const frames: Record<string, unknown>[] = [];
  child.stdin.on('data', data => {
    const frame = JSON.parse(String(data));
    frames.push(frame);
    child.stdout.write('o8-next-browser-result:' + JSON.stringify({ id: frame.id, result: { ok: true } }) + '\n');
  });
  const response = await POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: JSON.stringify({ action: 'frame', checkSettings: true, snapshot: { state: 'recording' } }) }));
  expect(await response.json()).toMatchObject({ native: false, enabled: false });
  expect(frames).toHaveLength(0);
  child.emit('exit');
});
it('falls back when enabled but there is no owned native process', async () => {
  settings.enabled = true;
  const response = await POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: '{"action":"prepare"}' }));
  expect(await response.json()).toMatchObject({ native: false, absent: true });
});
it('rejects oversized and unknown controls', async () => {
  const oversized = await POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: 'x'.repeat(8193) }));
  expect(oversized.status).toBe(413);
  const unknown = await POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: '{"action":"start-capture"}' }));
  expect(unknown.status).toBe(400);
});

it('reports process exit during an outstanding frame as absent immediately', async () => {
  settings.enabled = true;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
  bindNextBrowserPipe(child as unknown as ChildProcess);
  child.stdin.on('data', () => child.emit('exit'));
  const response = await POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: '{"action":"frame","checkSettings":true}' }));
  expect(await response.json()).toMatchObject({ native: false, absent: true });
});

it('does not reread settings for level frames and distinguishes an acknowledgement timeout', async () => {
  vi.useFakeTimers();
  settings.enabled = true;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
  bindNextBrowserPipe(child as unknown as ChildProcess);
  const post = (body: object) => POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: JSON.stringify(body) }));
  child.stdin.on('data', data => {
    const frame = JSON.parse(String(data));
    child.stdout.write('o8-next-browser-result:' + JSON.stringify({ id: frame.id, result: { ok: true } }) + '\n');
  });
  await post({ action: 'prepare' });
  for (let i = 0; i < 10; i++) await post({ action: 'frame' });
  expect(settings.reads).toBe(1);
  child.stdin.removeAllListeners('data');
  const pending = post({ action: 'frame' });
  await vi.advanceTimersByTimeAsync(8000);
  expect(await (await pending).json()).toMatchObject({ native: false, absent: false });
  child.emit('exit');
});

it('forwards well-formed capsule clicks from the native panel and drops anything else', async () => {
  settings.enabled = true;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
  bindNextBrowserPipe(child as unknown as ChildProcess);
  const actions = [
    { session: 4, state: 'speaking', action: 'pause', value: null },
    { session: 4, state: 'speaking', action: 'speed', value: 0.85 },
    { session: 4, state: 'speaking', action: 'speed', value: null },
    { session: 4, state: 'working', action: 'pause', value: null },
    { session: 4, state: 'working', action: '__proto__', value: null },
    { session: '4', state: 'voice', action: 'voice-stop', value: null },
    { session: 4, state: 'voice', action: 'voice-stop', value: null },
  ];
  child.stdin.on('data', data => {
    const frame = JSON.parse(String(data));
    child.stdout.write('o8-next-browser-result:' + JSON.stringify({ id: frame.id, result: { ok: true, actions } }) + '\n');
  });
  const response = await POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: '{"action":"frame","checkSettings":true}' }));
  expect((await response.json()).actions).toEqual([
    { session: 4, state: 'speaking', action: 'pause', value: null },
    { session: 4, state: 'speaking', action: 'speed', value: 0.85 },
    { session: 4, state: 'voice', action: 'voice-stop', value: null },
  ]);
  child.emit('exit');
});
