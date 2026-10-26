import { EventEmitter } from 'node:events';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ native: vi.fn(), spawn: vi.fn(), version: '7.2.8', pythonError: '', pendingPip: false }));
vi.mock('@/lib/tts/edge-neural', () => ({ synthesizeEdgeNeural: fixture.native }));
vi.mock('@/lib/providers/child-process', () => ({ spawn: fixture.spawn }));

function clearProcessVoice() {
  delete (globalThis as { __o8EdgeTtsEnsurer?: unknown }).__o8EdgeTtsEnsurer;
  delete (globalThis as { __o8EdgeTtsNativeDrift?: boolean }).__o8EdgeTtsNativeDrift;
}
afterEach(clearProcessVoice);
beforeEach(() => {
  clearProcessVoice();
  vi.resetModules(); vi.clearAllMocks();
  fixture.version = '7.2.8'; fixture.pythonError = ''; fixture.pendingPip = false;
  fixture.spawn.mockImplementation((_python: string, args: string[]) => {
    const proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    queueMicrotask(() => {
      if (args.includes('pip') && fixture.pendingPip) return;
      const failed = args.includes('edge_tts') && fixture.pythonError;
      if (args[0] === '-c') proc.stdout.emit('data', Buffer.from(fixture.version));
      else if (args.includes('pip')) fixture.version = '7.3.1';
      else if (failed) proc.stderr.emit('data', Buffer.from(failed));
      else proc.stdout.emit('data', Buffer.from([73, 68, 51, 42]));
      proc.emit('close', failed ? 1 : 0);
    });
    return proc;
  });
});

const request = () => new NextRequest('http://localhost/api/tts', { method: 'POST', body: JSON.stringify({ text: 'Steffan voice check.' }) });

it('retires native after a handshake 403, upgrades an old Python, and serves Python audio', async () => {
  fixture.native.mockRejectedValue(new Error('Unexpected server response: 403'));
  const { POST } = await import('./route');
  for (let i = 0; i < 2; i++) {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([73, 68, 51, 42]));
  }
  expect(fixture.native).toHaveBeenCalledTimes(1);
  expect(fixture.spawn.mock.calls.some(([, args]) => args.includes('pip') && args.includes('edge-tts>=7.3.1'))).toBe(true);
  expect(fixture.spawn.mock.calls.filter(([, args]) => args.includes('edge_tts')).every(([, args]) => args.includes('en-US-SteffanNeural'))).toBe(true);
});

it('does not retire native for transient failures', async () => {
  fixture.native.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(Buffer.from('native'));
  const { POST } = await import('./route');
  await POST(request());
  expect(await (await POST(request())).text()).toBe('native');
  expect(fixture.native).toHaveBeenCalledTimes(2);
});

it('shares upgrade preparation and native drift across server module reloads', async () => {
  fixture.native.mockRejectedValue(new Error('Unexpected server response: 403'));
  const first = await import('./route');
  expect((await first.POST(request())).status).toBe(200);
  await (await import('@/lib/tts/ensure-edge-tts')).ensureEdgeTtsInstalled();
  const checks = fixture.spawn.mock.calls.filter(([, args]) => args[0] === '-c').length;
  vi.resetModules();
  const reloaded = await import('./route');
  expect((await reloaded.POST(request())).status).toBe(200);
  expect(fixture.native).toHaveBeenCalledTimes(1);
  expect(fixture.spawn.mock.calls.filter(([, args]) => args[0] === '-c')).toHaveLength(checks);
});

it('rechecks Python after a native 403 even when startup already checked it', async () => {
  fixture.version = '7.3.1';
  const { ensureEdgeTtsInstalled } = await import('@/lib/tts/ensure-edge-tts');
  await ensureEdgeTtsInstalled();
  fixture.version = '7.2.8';
  fixture.native.mockRejectedValue(new Error('Unexpected server response: 403'));
  const { POST } = await import('./route');
  expect((await POST(request())).status).toBe(200);
  await vi.waitFor(() => expect(fixture.version).toBe('7.3.1'));
  expect(fixture.spawn.mock.calls.some(([, args]) => args.includes('edge-tts>=7.3.1'))).toBe(true);
});

it.each([
  ['7.2.8', '403, message=Forbidden', 'edge_voice_update_required'],
  ['7.3.1', 'network unavailable', 'edge_voice_unavailable'],
])('returns a typed failure for %s without waiting for pip', async (version, pythonError, code) => {
  fixture.version = version; fixture.pythonError = pythonError; fixture.pendingPip = true;
  fixture.native.mockRejectedValue(Object.assign(new Error('handshake forbidden'), { statusCode: 403 }));
  const { POST } = await import('./route');
  const response = await POST(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code });
  if (version === '7.2.8') expect(fixture.spawn.mock.calls.some(([, args]) => args.includes('edge-tts>=7.3.1'))).toBe(true);
});
