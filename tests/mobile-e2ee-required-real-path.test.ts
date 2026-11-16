import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  b64decode,
  b64encode,
  decryptFrame,
  deriveSessionKey,
  initTranscript,
  isEncryptedFrame,
  signDetached,
} from '@/lib/mobile/e2ee-crypto';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-mobile-e2ee-required-'));
const sockets = new Set<WebSocket>();
let wsProcess: ChildProcess;
let wsPort = 0;
let deviceToken = '';
let serverOutput = '';
const deviceIdentity = nacl.sign.keyPair();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function nonLoopbackAddress(): string {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === 'IPv4') return entry.address;
    }
  }
  throw new Error('A non-loopback interface is required to exercise the remote-device WebSocket gate.');
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${wsPort}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ws-server health. ${serverOutput.slice(-2_000)}`);
}

beforeAll(async () => {
  wsPort = await freePort();
  const publicKey = Buffer.from(deviceIdentity.publicKey).toString('base64');
  const seedScript = [
    "const loaded = await import('./src/lib/mobile/device-registry.ts');",
    "const enrollDevice = loaded.enrollDevice ?? loaded.default?.enrollDevice;",
    `const result = enrollDevice({ identityPublicKey: '${publicKey}', deviceLabel: 'E2EE gate test' });`,
    "console.log(`DEVICE_TOKEN:${result.deviceToken}`);",
  ].join('\n');
  const seedOutput = execFileSync(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    '--input-type=module',
    '--eval',
    seedScript,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, CORTEX_IDE_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  deviceToken = seedOutput.match(/DEVICE_TOKEN:([a-f0-9]+)/)?.[1] ?? '';
  expect(deviceToken).not.toBe('');

  wsProcess = execFile(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_API_PORT: String(await freePort()),
      O8_WS_PORT: String(wsPort),
      NEXT_ORIGIN: `http://127.0.0.1:${await freePort()}`,
    },
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitForHealth();
}, 40_000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  if (wsProcess && wsProcess.exitCode === null) {
    wsProcess.kill('SIGTERM');
    await Promise.race([once(wsProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('remote enrolled-device WebSocket authentication', () => {
  it('rejects plaintext application commands after device-key proof', async () => {
    const socket = new WebSocket(
      `ws://${nonLoopbackAddress()}:${wsPort}/ws?token=${encodeURIComponent(deviceToken)}`,
    );
    sockets.add(socket);
    const hello = new Promise<{
      serverEphPub: string;
      serverNonce: string;
    }>((resolve) => {
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.channel === 'system' && frame.event === 'e2ee-hello') {
          resolve(frame.data as { serverEphPub: string; serverNonce: string });
        }
      });
    });
    const encryptedReady = new Promise<unknown>((resolve) => {
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as unknown;
        if (isEncryptedFrame(frame)) resolve(frame);
      });
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await once(socket, 'open');
    const serverHello = await hello;
    const clientEph = nacl.box.keyPair();
    const clientEphPub = b64encode(clientEph.publicKey);
    const clientNonce = b64encode(nacl.randomBytes(24));
    socket.send(JSON.stringify({
      type: 'e2ee-init',
      clientEphPub,
      clientNonce,
      clientSig: signDetached(
        initTranscript(clientEphPub, clientNonce, serverHello.serverEphPub, serverHello.serverNonce),
        deviceIdentity.secretKey,
      ),
    }));
    const sessionKey = deriveSessionKey(
      clientEph.secretKey,
      b64decode(serverHello.serverEphPub),
      serverHello.serverEphPub,
      clientEphPub,
    );
    const readyFrame = await encryptedReady;
    expect(JSON.parse(decryptFrame(readyFrame as Parameters<typeof decryptFrame>[0], sessionKey) ?? '{}'))
      .toMatchObject({ channel: 'system', event: 'e2ee-ready' });

    socket.send(JSON.stringify({ type: 'agent-kill', agentId: 'must-not-run' }));
    expect(await closed).toEqual({ code: 4415, reason: 'encrypted frames required' });
    sockets.delete(socket);
    expect((await fetch(`http://127.0.0.1:${wsPort}/health`)).ok).toBe(true);
  });

  it('rejects plaintext application commands before device-key proof', async () => {
    const frames: Array<{ channel?: string; event?: string }> = [];
    const socket = new WebSocket(
      `ws://${nonLoopbackAddress()}:${wsPort}/ws?token=${encodeURIComponent(deviceToken)}`,
    );
    sockets.add(socket);
    socket.on('message', (raw) => frames.push(JSON.parse(String(raw)) as { channel?: string; event?: string }));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'agent-kill', agentId: 'must-not-run' }));

    expect(await closed).toEqual({ code: 4415, reason: 'e2ee handshake required' });
    sockets.delete(socket);
    expect(frames.every((frame) => (
      frame.channel === 'system'
      && (frame.event === 'connected' || frame.event === 'e2ee-hello')
    ))).toBe(true);
    expect((await fetch(`http://127.0.0.1:${wsPort}/health`)).ok).toBe(true);
  });

  it('withholds application state and closes when device-key proof stays silent', async () => {
    const frames: Array<{ channel?: string; event?: string }> = [];
    const socket = new WebSocket(
      `ws://${nonLoopbackAddress()}:${wsPort}/ws?token=${encodeURIComponent(deviceToken)}`,
    );
    sockets.add(socket);
    socket.on('message', (raw) => frames.push(JSON.parse(String(raw)) as { channel?: string; event?: string }));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await once(socket, 'open');
    const result = await closed;
    sockets.delete(socket);

    expect(result).toEqual({ code: 4411, reason: 'handshake_timeout' });
    expect(frames.some((frame) => frame.channel === 'system' && frame.event === 'e2ee-hello')).toBe(true);
    expect(frames.every((frame) => (
      frame.channel === 'system'
      && (frame.event === 'connected' || frame.event === 'e2ee-hello')
    ))).toBe(true);
  }, 10_000);
});
