import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChildProcess } from '@/lib/providers/child-process';
import { bindNextBrowserPipe } from '@/lib/next/browser-pipe';
import { POST } from './route';

const settings = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/lib/operator/defaults', () => ({ getOperatorDefaults: async () => ({ values: { nativeDictationPill: settings.enabled } }) }));
afterEach(() => { settings.enabled = false; });
it('defaults to web and only sends release when disabled, even for a requested recording', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), exitCode: null, signalCode: null });
  bindNextBrowserPipe(child as unknown as ChildProcess);
  const frames: Record<string, unknown>[] = [];
  child.stdin.on('data', data => {
    const frame = JSON.parse(String(data));
    frames.push(frame);
    child.stdout.write('o8-next-browser-result:' + JSON.stringify({ id: frame.id, result: { ok: true } }) + '\n');
  });
  const response = await POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: JSON.stringify({ action: 'frame', snapshot: { state: 'recording' } }) }));
  expect(await response.json()).toEqual({ native: false });
  expect(frames[0].args).toEqual({ action: 'release' });
  child.emit('exit');
});
it('falls back when enabled but there is no owned native process', async () => {
  settings.enabled = true;
  const response = await POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: '{"action":"prepare"}' }));
  expect(await response.json()).toEqual({ native: false });
});
it('rejects oversized and unknown controls', async () => {
  const oversized = await POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: 'x'.repeat(8193) }));
  expect(oversized.status).toBe(413);
  const unknown = await POST(new NextRequest('http://localhost/api/next/dictation-pill', { method: 'POST', body: '{"action":"start-capture"}' }));
  expect(unknown.status).toBe(400);
});
