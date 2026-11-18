import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Socket } from 'node:net';
import { expect, it } from 'vitest';
import { O8dProducer } from '@/lib/ws-server/o8d-producer';

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw Error('Producer fixture deadline'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
it('attaches over the private socket, replaces a disconnected owner and bounds the publication queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-producer-peer-')), path = join(root, 'producer.sock');
  const peers = new Set<Socket>(), grants: Record<string, unknown>[] = [], batches: unknown[] = [];
  let generation = 0;
  const server = createServer(peer => {
    peers.add(peer); peer.once('close', () => peers.delete(peer)); peer.on('error', () => {});
    let pending = '';
    peer.on('data', chunk => {
      pending += chunk.toString();
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n'), line = pending.slice(0, end); pending = pending.slice(end + 1);
        const value = JSON.parse(line);
        if (!Array.isArray(value)) {
          grants.push(value); generation++;
          peer.write(JSON.stringify({ version: 1, pid: process.pid, generation, epoch: value.epoch }) + '\n');
        } else batches.push(value);
      }
    });
  });
  const producer = new O8dProducer(path, 'isolated-bridge-fixture', '127.0.0.1:18002', 'node-epoch', () => JSON.stringify({ apiPort: 18001 }));
  try {
    await new Promise<void>(resolve => server.listen(path, resolve)); chmodSync(path, 0o600);
    await producer.start(); expect(producer.status).toEqual({ transport: 'o8d', pid: process.pid, generation: 1 });
    expect(grants).toEqual([{ version: 1, key: 'isolated-bridge-fixture', upstream: '127.0.0.1:18002', epoch: 'node-epoch', startupPortInfo: { apiPort: 18001 } }]);
    producer.publish([{ seq: 1 }]); await until(() => batches.length === 1);
    for (const peer of peers) peer.destroy(); await until(() => producer.status.generation === 2);
    expect(grants).toHaveLength(2); expect(grants[1]).toEqual(grants[0]);
    producer.publish([{ data: 'x'.repeat(1024 * 1024) }]); await until(() => producer.status.pid === null);
    expect(batches).toHaveLength(1);
  } finally { producer.stop(); for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
it.each(['permission', 'malformed', 'version', 'epoch', 'oversized'])('fails closed for an invalid %s attachment', async kind => {
  const root = mkdtempSync(join(tmpdir(), 'o8-producer-refusal-')), path = join(root, 'producer.sock');
  const peers = new Set<Socket>(); let connected = false;
  const server = createServer(peer => {
    connected = true; peers.add(peer); peer.on('error', () => {}); peer.once('close', () => peers.delete(peer));
    peer.once('data', () => peer.write(kind === 'malformed' ? 'invalid\n' : kind === 'oversized' ? 'x'.repeat(4097) : JSON.stringify({ version: kind === 'version' ? 2 : 1, pid: process.pid, generation: 1, epoch: kind === 'epoch' ? 'wrong' : 'node-epoch' }) + '\n'));
  });
  const producer = new O8dProducer(path, 'isolated-bridge-fixture', '127.0.0.1:18002', 'node-epoch', () => undefined);
  try {
    await new Promise<void>(resolve => server.listen(path, resolve)); chmodSync(path, kind === 'permission' ? 0o666 : 0o600);
    await producer.start(); expect(producer.status.pid).toBeNull(); expect(connected).toBe(kind !== 'permission');
  } finally { producer.stop(); for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

it('binds private bridge admission to the current producer epoch', async () => {
  const { createServer: httpServer } = await import('node:http');
  const { vi } = await import('vitest');
  vi.stubEnv('O8_API_FRONT_DOOR', '1');
  vi.stubEnv('O8D_PRODUCER_SOCKET', '/isolated-fixture/producer.sock');
  vi.stubEnv('O8D_BRIDGE_KEY', 'producer-binding-fixture-key');
  const { O8dBridge } = await import('@/lib/ws-server/o8d-bridge');
  const bridge = new O8dBridge(httpServer(), 18001, 'next-epoch');
  const request = (key: string) => ({ headers: { 'x-o8d-bridge': key } }) as unknown as import('node:http').IncomingMessage;
  try {
    expect(bridge.bridged(request('producer-binding-fixture-key:next-epoch'))).toBe(true);
    expect(bridge.bridged(request('producer-binding-fixture-key:past-epoch'))).toBe(false);
    expect(bridge.bridged(request('producer-binding-fixture-key'))).toBe(false);
    expect(bridge.bridged(request('wrong-binding-fixture-key:next-epoch'))).toBe(false);
  } finally { bridge.stop(); vi.unstubAllEnvs(); }
});
