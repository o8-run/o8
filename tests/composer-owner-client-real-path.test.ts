import { createServer, type Socket } from 'node:net';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { O8dProducer } from '@/lib/ws-server/o8d-producer';
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true) }));

type Frame = Record<string, unknown>;
async function fixture(run: (path: string, frames: Frame[]) => Promise<void>) {
  // Darwin's sockaddr_un is only 104 bytes, shorter than the test runner's TMPDIR.
  const root = mkdtempSync('/tmp/o8-cq-');
  const path = join(root, 'owner.sock');
  const peers = new Set<Socket>();
  const frames: Frame[] = [];
  const server = createServer(socket => {
    peers.add(socket);
    socket.once('close', () => peers.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n');
        const frame = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        frames.push(frame);
        if (!frame.kind) {
          socket.write(JSON.stringify({ version: 1, pid: process.pid, generation: frames.length, epoch: frame.epoch,
            composerQueueEpoch: 'opaque-owner-epoch' }) + '\n');
        } else {
          socket.write(JSON.stringify({ v: 1, kind: 'composer-queue-response', epoch: frame.epoch,
            requestId: frame.requestId, ok: true, result: { changed: false } }) + '\n');
        }
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    chmodSync(path, 0o600);
    await run(path, frames);
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

it('multiplexes a fenced queue request over the existing authenticated producer connection', async () => {
  await fixture(async (path, frames) => {
    const producer = new O8dProducer(path, 'fixture-key', '127.0.0.1:18002', 'realtime-epoch', () => undefined);
    try {
      await producer.start();
      expect(await producer.composerRequest('admit', { id: 'fixture-send', claimToken: 'abcdefghijklmnopqrstuv' })).toEqual({ changed: false });
      expect(frames[0]).toMatchObject({ epoch: 'realtime-epoch', composerQueueBootId: expect.any(String) });
      expect(frames[1]).toEqual({ v: 1, kind: 'composer-queue-request', epoch: 'opaque-owner-epoch', requestId: expect.any(String),
        method: 'admit', params: { id: 'fixture-send', claimToken: 'abcdefghijklmnopqrstuv' } });
    } finally { producer.stop(); }
  });
});

it('keeps one composer boot identity across producer instances in the same WS process', async () => {
  await fixture(async (path, frames) => {
    const first = new O8dProducer(path, 'fixture-key', '127.0.0.1:18002', 'first-realtime-epoch', () => undefined);
    const second = new O8dProducer(path, 'fixture-key', '127.0.0.1:18003', 'second-realtime-epoch', () => undefined);
    try {
      await first.start();
      first.stop();
      await second.start();
      expect(frames).toHaveLength(2);
      expect(frames[0].composerQueueBootId).toEqual(expect.any(String));
      expect(frames[0].composerQueueBootId).toMatch(/^[a-f0-9-]{36}$/);
      expect(frames[1].composerQueueBootId).toBe(frames[0].composerQueueBootId);
      expect(frames[1].epoch).toBe('second-realtime-epoch');
    } finally { first.stop(); second.stop(); }
  });
});
