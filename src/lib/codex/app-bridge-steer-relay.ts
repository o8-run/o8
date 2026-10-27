import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { isPidAlive } from '@/lib/lane/orchestrator-crash-survival';
import { composerQueueRepoKey, readComposerSend } from '@/lib/orchestrator/composer-queue';
import type { OrchestratorBackend } from '@/lib/lane/orchestrator-backends/types';
import { assertCodexLiveSteerEffort } from './app-bridge-steer-effort';

type LiveSteer = NonNullable<OrchestratorBackend['liveSteer']>;
interface Target { repoPath: string; threadId: string }
interface Receipt extends Target { pid: number; address: string; token: string }
const TIMEOUT_MS = 12_000;
// Queue text allows 250k UTF-16 characters, including JSON-escaped controls.
const MAX_BYTES = 2_000_000;

function receiptPath(target: Target): string {
  const key = createHash('sha256').update(JSON.stringify([composerQueueRepoKey(target.repoPath), target.threadId])).digest('hex');
  return join(getDataDir(), 'codex-live-steer', `${key}.json`);
}
function readReceipt(target: Target): Receipt | null {
  try {
    const value = JSON.parse(readFileSync(receiptPath(target), 'utf8')) as Receipt;
    return value.repoPath === composerQueueRepoKey(target.repoPath) && value.threadId === target.threadId
      && typeof value.token === 'string' && typeof value.address === 'string' && Number.isSafeInteger(value.pid)
      && value.pid > 0 && isPidAlive(value.pid) && (process.platform === 'win32' || existsSync(value.address)) ? value : null;
  } catch { return null; }
}

/** Next and WS may own different sessions. Relay only to the owning turn. */
export function createCodexSteerRelay(target: Target, steer: LiveSteer, running: () => boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'o8-cs-'));
  chmodSync(directory, 0o700);
  const token = randomUUID();
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\o8-cs-${token}` : join(directory, 's');
  const file = receiptPath(target);
  const receipt: Receipt = { ...target, repoPath: composerQueueRepoKey(target.repoPath), pid: process.pid, address, token };
  const sockets = new Set<Socket>();
  let listening = false;
  let closed = false;
  const withdraw = () => {
    try { if (JSON.parse(readFileSync(file, 'utf8')).token === token) rmSync(file, { force: true }); } catch { /* already withdrawn */ }
  };
  const publish = () => {
    if (!listening || closed || !running()) { withdraw(); return; }
    mkdirSync(join(getDataDir(), 'codex-live-steer'), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${token}.tmp`;
    writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
    renameSync(temporary, file);
  };
  const server = createServer(socket => {
    sockets.add(socket);
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    const onData = (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BYTES) { socket.destroy(); return; }
      if (!buffer.includes('\n')) return;
      socket.removeListener('data', onData);
      void (async () => {
        try {
          const message = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as { token: string; message: string; options: Parameters<LiveSteer>[2] };
          if (message.token !== token || typeof message.message !== 'string' || !message.options || !running()) {
            socket.end(`${JSON.stringify({ accepted: false })}\n`); return;
          }
          const { checkComposerQueueBinding } = await import('@/lib/ws-server/composer-queue-heartbeat');
          const result = await steer(target.repoPath, message.message, { ...message.options, beforeAdmit: () => {
            const item = readComposerSend(message.options.clientUserMessageId ?? '');
            if (!item || item.admittedAt === null || item.intent !== 'steer-now' || item.threadId !== target.threadId
              || item.repoPath !== receipt.repoPath || item.payload.wireMessage !== message.message
              || item.payload.routing.mode !== (message.options.orchestrationMode ?? 'fleet') || item.payload.images.length
              || item.payload.routing.model !== message.options.model || item.payload.routing.permissionMode !== message.options.permissionMode) {
              throw new Error('Codex steer does not match its admitted queue item.');
            }
            checkComposerQueueBinding(item);
          } });
          socket.end(`${JSON.stringify(result)}\n`);
        } catch { socket.end(`${JSON.stringify({ unconfirmed: true })}\n`); }
      })();
    };
    socket.on('data', onData);
  });
  server.on('error', () => { listening = false; withdraw(); });
  server.listen(address, () => {
    if (process.platform !== 'win32') chmodSync(address, 0o600);
    listening = true; publish();
  });
  server.unref();
  return { publish, close: () => {
    if (closed) return;
    closed = true; withdraw();
    for (const socket of sockets) socket.destroy();
    server.close(() => rmSync(directory, { recursive: true, force: true }));
  } };
}

/** A private receipt grants discovery; the native turn fence remains authoritative. */
export function getRemoteCodexAppBridgeSteer(target: Target): LiveSteer | undefined {
  const receipt = readReceipt(target);
  if (!receipt) return undefined;
  return async (_repoPath, message, options) => {
    assertCodexLiveSteerEffort(options.thinkingEffort);
    if (options.attachments?.length) return { accepted: false };
    return new Promise<{ accepted: boolean }>((resolve, reject) => {
      const socket = createConnection(receipt.address);
      let buffer = '';
      let settled = false;
      const finish = (result?: { accepted: boolean }, error?: unknown) => {
        if (settled) return;
        settled = true; socket.destroy();
        if (result) resolve(result);
        else reject(error instanceof Error ? error : new Error('Codex steer relay acknowledgement was not confirmed.'));
      };
      socket.setTimeout(TIMEOUT_MS, () => finish());
      socket.on('error', () => finish());
      socket.on('close', () => { if (!settled) finish(); });
      socket.setEncoding('utf8');
      socket.on('connect', () => {
        try {
          const { beforeAdmit, ...routing } = options;
          const line = `${JSON.stringify({ token: receipt.token, message, options: routing })}\n`;
          beforeAdmit();
          socket.write(line);
        } catch (error) { finish(undefined, error); }
      });
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_BYTES) { finish(); return; }
        if (!buffer.includes('\n')) return;
        try {
          const result = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
          finish(typeof result.accepted === 'boolean' ? { accepted: result.accepted } : undefined);
        } catch { finish(); }
      });
    });
  };
}
