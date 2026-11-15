import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChildProcess } from '@/lib/providers/child-process';
import { bindNextBrowserPipe } from '@/lib/next/browser-pipe';
import { POST } from './route';

const settings = vi.hoisted(() => ({ enabled: false, hud: false, ink: false, reads: 0 }));
vi.mock('@/lib/operator/defaults', () => ({ getOperatorDefaults: async () => { settings.reads++; return { values: { nativeDictationPill: settings.enabled, nativeDictationHud: settings.hud, nativeSpatialInk: settings.ink } }; } }));
afterEach(() => { settings.enabled = false; settings.hud = false; settings.ink = false; settings.reads = 0; vi.useRealTimers(); });

it('drives the caret/HUD panel only under its own flag, over its own frame type', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
  bindNextBrowserPipe(child as unknown as ChildProcess);
  const frames: Record<string, unknown>[] = [];
  child.stdin.on('data', data => {
    const frame = JSON.parse(String(data));
    frames.push(frame);
    child.stdout.write('o8-next-browser-result:' + JSON.stringify({ id: frame.id, result: { ok: true, finishSession: 3, actions: [{ session: 3, state: 'speaking', action: 'stop' }] } }) + '\n');
  });
  const post = (body: object) => POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: JSON.stringify(body) }));
  // The dock flag alone never turns the HUD native.
  settings.enabled = true;
  expect(await (await post({ action: 'prepare', surface: 'hud' })).json()).toMatchObject({ native: false, enabled: false });
  expect(frames).toHaveLength(0);
  settings.enabled = false; settings.hud = true;
  const reply = await (await post({ action: 'frame', checkSettings: true, surface: 'hud', snapshot: { state: 'recording' } })).json();
  expect(reply).toEqual({ enabled: true, native: true, absent: false });
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({ type: 'dictation-hud', verb: 'present', args: { action: 'frame', surface: 'hud' } });
  // The dock keeps reading its own flag.
  expect(await (await post({ action: 'prepare' })).json()).toMatchObject({ native: false, enabled: false });
  expect(frames).toHaveLength(1);
  child.emit('exit');
});
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

it('forwards a fleet tap and a revert naming its chip, and drops malformed ones', async () => {
  settings.enabled = true;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
  bindNextBrowserPipe(child as unknown as ChildProcess);
  const actions = [
    { session: 2, state: 'workers', action: 'workers-expand', value: null },
    { session: 2, state: 'voice', action: 'workers-expand', value: null },
    { session: 3, state: 'success', action: 'revert', value: null, edit: 7 },
    { session: 3, state: 'extras', action: 'revert', value: 9, edit: 8 },
    { session: 3, state: 'success', action: 'revert', value: null },
    { session: 3, state: 'success', action: 'revert', value: null, edit: '7' },
    { session: 3, state: 'idle', action: 'revert', value: null, edit: 7 },
    { session: 3, state: 'constructor', action: 'revert', value: null, edit: 7 },
  ];
  child.stdin.on('data', data => {
    const frame = JSON.parse(String(data));
    child.stdout.write('o8-next-browser-result:' + JSON.stringify({ id: frame.id, result: { ok: true, actions } }) + '\n');
  });
  const response = await POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: '{"action":"frame","checkSettings":true}' }));
  expect((await response.json()).actions).toEqual([
    { session: 2, state: 'workers', action: 'workers-expand', value: null },
    { session: 3, state: 'success', action: 'revert', value: null, edit: 7 },
    { session: 3, state: 'extras', action: 'revert', value: null, edit: 8 },
  ]);
  child.emit('exit');
});

it('rejects an out-of-range HUD placement before it reaches the native process', async () => {
  settings.hud = true;
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
  bindNextBrowserPipe(child as unknown as ChildProcess);
  const frames: unknown[] = [];
  child.stdin.on('data', data => {
    const frame = JSON.parse(String(data));
    frames.push(frame);
    child.stdout.write('o8-next-browser-result:' + JSON.stringify({ id: frame.id, result: { ok: true } }) + '\n');
  });
  const post = (placement: unknown) => POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: JSON.stringify({
    action: 'frame', checkSettings: true, surface: 'hud', snapshot: { state: 'recording', hud: { surface: 'caret', placement } },
  }) }));
  for (const placement of [
    { x: 1e7, y: 0, width: 460, height: 138 }, { x: 0, y: 0, width: 5000, height: 138 },
    { x: 0, y: 0, width: 460, height: -1 }, { x: '1', y: 0, width: 460, height: 138 }, null,
  ]) expect((await post(placement)).status).toBe(400);
  expect(frames).toHaveLength(0);
  expect(await (await post({ x: -1200, y: -300, width: 460, height: 138 })).json()).toMatchObject({ native: true });
  expect(frames).toHaveLength(1);
  child.emit('exit');
});

it('drives the ink panel only under its own flag and passes back well-formed points', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
  bindNextBrowserPipe(child as unknown as ChildProcess);
  const frames: Record<string, unknown>[] = [];
  let result: Record<string, unknown> = { ok: true, capturing: true, points: [[0, 0.25, 0.5, 0], [0, 0.3, 0.5, 16]], next: 2 };
  child.stdin.on('data', data => {
    const frame = JSON.parse(String(data));
    frames.push(frame);
    child.stdout.write('o8-next-browser-result:' + JSON.stringify({ id: frame.id, result }) + '\n');
  });
  const post = (body: object) => POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: JSON.stringify({ surface: 'ink', ...body }) }));
  const monitor = { x: -1920, y: 102, width: 1920, height: 1080 };
  // The dock and HUD flags never turn the ink native; flag off sends no frame.
  settings.enabled = true; settings.hud = true;
  expect(await (await post({ action: 'arm', session: 1, monitor })).json()).toEqual({ native: false, enabled: false });
  expect(frames).toHaveLength(0);
  settings.ink = true;
  expect(await (await post({ action: 'arm', session: 1, monitor, reducedMotion: false })).json())
    .toEqual({ enabled: true, absent: false, native: true, capturing: true, points: [[0, 0.25, 0.5, 0], [0, 0.3, 0.5, 16]], next: 2 });
  expect(frames[0]).toMatchObject({ type: 'spatial-ink', verb: 'present', args: { action: 'arm', session: 1, monitor, surface: 'ink' } });
  // The flag is read at arm, not per keep-alive.
  const reads = settings.reads;
  result = { ok: false, capturing: false, disarmed: 'lease', next: 2 };
  expect(await (await post({ action: 'frame', session: 1, from: 2 })).json()).toEqual({ enabled: true, absent: false, native: false, capturing: false, disarmed: 'lease', next: 2 });
  expect(settings.reads).toBe(reads);
  // A malformed point list is a failed reply.
  result = { ok: true, points: [[0, 2, 0.5, 0]] };
  expect(await (await post({ action: 'frame', session: 1 })).json()).toMatchObject({ native: false });
  // Malformed requests never reach the pipe.
  const sent = frames.length;
  for (const body of [{ action: 'arm', session: 1 }, { action: 'arm', session: 1, monitor: { ...monitor, width: 0 } }, { action: 'frame' }, { action: 'frame', session: 1, from: -1 }, { action: 'capture', session: 1 }]) {
    expect((await post(body)).status).toBe(400);
  }
  expect(frames).toHaveLength(sent);
  // The other surfaces still refuse the ink's arm action.
  expect((await POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: '{"action":"arm"}' }))).status).toBe(400);
  child.emit('exit');
});
