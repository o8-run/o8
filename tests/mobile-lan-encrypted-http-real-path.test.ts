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
  encryptFrame,
  deriveSessionKey,
  initTranscript,
  isEncryptedFrame,
  signDetached,
} from '@/lib/mobile/e2ee-crypto';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-mobile-lan-http-'));
const apiRequests: Array<{ path: string; authorization?: string; clientAddr?: string }> = [];
let apiServer: import('node:http').Server;
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
  // The local API the replay reaches: it records what arrives.
  apiServer = createServer((req, res) => {
    apiRequests.push({ path: req.url ?? '', authorization: req.headers.authorization, clientAddr: req.headers['x-o8-client-addr'] as string | undefined });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const apiAddress = apiServer.address();
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('missing api port');
  const apiPort = apiAddress.port;
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
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      // The remote-device gate is exercised over a network address.
      O8_LAN_ACCESS: '1',
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
  await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});


async function encryptedSocket() {
  const socket = new WebSocket(`ws://${nonLoopbackAddress()}:${wsPort}/ws?token=${encodeURIComponent(deviceToken)}`);
  sockets.add(socket);
  const frames: unknown[] = [];
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  await once(socket, 'open');
  const deadline = Date.now() + 10_000;
  let hello: { serverEphPub: string; serverNonce: string } | undefined;
  while (!hello && Date.now() < deadline) {
    hello = (frames.find((f) => (f as { event?: string }).event === 'e2ee-hello') as { data?: typeof hello } | undefined)?.data;
    if (!hello) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!hello) throw new Error('no e2ee-hello');
  const clientEph = nacl.box.keyPair();
  const clientEphPub = b64encode(clientEph.publicKey);
  const clientNonce = b64encode(nacl.randomBytes(24));
  socket.send(JSON.stringify({
    type: 'e2ee-init', clientEphPub, clientNonce,
    clientSig: signDetached(initTranscript(clientEphPub, clientNonce, hello.serverEphPub, hello.serverNonce), deviceIdentity.secretKey),
  }));
  const sessionKey = deriveSessionKey(clientEph.secretKey, b64decode(hello.serverEphPub), hello.serverEphPub, clientEphPub);
  const decrypted = () => frames.filter(isEncryptedFrame).map((f) => JSON.parse(decryptFrame(f as Parameters<typeof decryptFrame>[0], sessionKey) ?? '{}') as Record<string, unknown>);
  const next = async (match: (frame: Record<string, unknown>) => boolean) => {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const found = decrypted().find(match);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('frame did not arrive');
  };
  const sendEncrypted = (obj: unknown) => socket.send(JSON.stringify(encryptFrame(JSON.stringify(obj), sessionKey)));
  return { socket, next, sendEncrypted };
}

describe('HTTP over a phone\'s encrypted socket on the network', () => {
  it('advertises it, replays a request with the socket device\'s own bearer, and refuses another bearer', async () => {
    const { next, sendEncrypted } = await encryptedSocket();
    expect(await next((f) => f.event === 'e2ee-ready')).toMatchObject({ data: { http: 1 } });

    sendEncrypted({ t: 'http-req', rid: 'r1', method: 'GET', path: '/api/mobile/inbox', headers: { authorization: `Bearer ${deviceToken}` } });
    const response = await next((f) => f.t === 'http-res' && f.rid === 'r1');
    expect(response).toMatchObject({ status: 200 });
    expect(JSON.parse(Buffer.from(String(response.bodyB64), 'base64').toString())).toEqual({ ok: true, path: '/api/mobile/inbox' });
    // It reached the local API as a remote device request, never as loopback.
    expect(apiRequests).toEqual([{ path: '/api/mobile/inbox', authorization: `Bearer ${deviceToken}`, clientAddr: 'o8-relay-forward' }]);

    sendEncrypted({ t: 'http-req', rid: 'r2', method: 'GET', path: '/api/panel/settings', headers: { authorization: 'Bearer someone-elses-token' } });
    expect(await next((f) => f.t === 'http-res' && f.rid === 'r2')).toMatchObject({ status: 403, error: 'device_mismatch' });
    expect(apiRequests).toHaveLength(1);
  }, 30_000);
});
