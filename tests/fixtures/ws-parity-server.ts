import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const fixtureInbox = {
  generatedAt: '2026-01-01T00:00:00.000Z', mode: 'live', sourceLabel: 'o8',
  sessions: [], fleetSessions: [], approvals: [], reviewUnits: [], items: [], summary: {},
};

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** Same real WS process / fixture Next HTTP boundary as the negotiation integration test. */
export async function startParityReference(options: {
  logLimit?: number; o8d?: boolean; binary?: string; stallFixture?: boolean; nativeHttp?: boolean; entry?: string; preload?: string;
} = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-ws-parity-')));
  const token = 'ws-parity-fixture-credential';
  writeFileSync(join(directory, 'ws-token'), token, { mode: 0o600 });
  // Startup performs Git maintenance; point it at an owned empty repository.
  await promisify(execFile)('git', ['init', '--quiet', directory]);
  let historyVersion = 0;
  const api = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    let result: unknown;
    if (url.pathname === '/api/panel/status') {
      result = {};
    } else if (url.pathname === '/fixture/history') {
      historyVersion = body.version;
      result = {};
    } else if (url.pathname === '/api/mobile/inbox') {
      result = fixtureInbox;
    } else if (url.pathname === '/api/mobile/sync') {
      result = body.inbox ? { inbox: fixtureInbox, inboxEtag: 'fixture' } : {
        history: { sessionKey: body.history?.sessionKey, entries: [{
          id: `history-${historyVersion}`, role: 'assistant', text: `history ${historyVersion}`,
        }], replace: true },
      };
    } else if (url.pathname === '/api/command-center/snapshot') {
      result = { fleet: { agents: [], meta: { mode: 'live' } }, review: null,
        reviewError: null, browserInventory: { browsers: [], generatedAt: fixtureInbox.generatedAt },
        attachedBrowser: null, browserError: null };
    } else if (url.pathname === '/api/setup/identity') {
      result = { configured: false };
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const address = api.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture API port');
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const port = await freePort();
  const child = execFile(process.execPath, [
    ...(options.preload ? ['--require', options.preload] : []),
    ...(options.stallFixture ? ['--import=./tests/fixtures/ws-stall-preload.mjs'] : []),
    ...(options.nativeHttp ? ['--require=./scripts/next/brain-runtime.cjs'] : []),
    ...(options.entry ? [options.entry] : ['--import=./scripts/register-server-only-stub.mjs',
      '--import=tsx', 'src/ws-server.ts'])], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test',
      HOME: directory, USERPROFILE: directory,
      O8_DATA_DIR: undefined, CORTEX_IDE_DATA_DIR: directory,
      CORTEX_IDE_DB_PATH: join(directory, 'cortex-ide.db'),
      CORTEX_IDE_REVIEW_REPO_ROOT: directory, WS_TOKEN: token,
      O8_API_PORT: String(address.port), O8_WS_PORT: String(port),
      CORTEX_REALTIME_INTERNAL_ORIGIN: `http://127.0.0.1:${port}`,
      O8_WS_O8D: (options.o8d ?? process.env.O8_WS_PARITY_O8D === '1') ? '1' : '0',
      O8_NEXT_O8D: options.nativeHttp ? '1' : '0',
      O8D_BINARY: options.binary ?? process.env.O8D_TEST_BINARY,
      O8_REALTIME_LOG_LIMIT: String(options.logLimit ?? 4), NEXT_ORIGIN: apiUrl },
  });
  const stop = async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      const exited = once(child, 'exit');
      const timer = setTimeout(() => child?.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    }
    if (api.listening) await new Promise<void>((resolve) => api.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  };
  // Consume output without exposing incidental background-service diagnostics.
  child.stdout?.resume();
  child.stderr?.resume();
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('reference WS process exited');
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) {
          return { url: `ws://127.0.0.1:${port}/ws`, apiUrl, token, pid: child.pid!, directory, stop,
            stopNext: async () => { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); } };
        }
      } catch { /* Wait for the real entry point. */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('reference WS health timed out');
  } catch (error) {
    await stop();
    throw error;
  }
}
