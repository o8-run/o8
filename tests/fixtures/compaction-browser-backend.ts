import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { vi } from 'vitest';
import type { CompactionOperation } from '@/lib/orchestrator/compaction-status';
import type { RealtimeMutationRecord } from '@/lib/realtime/types';

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  return address.port;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** Compaction/history use production routes and WS; the summarizer is gated. */
export async function startCompactionBrowserBackend(html: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-compaction-browser-')));
  const repoPath = join(directory, 'repo'); mkdirSync(repoPath);
  await promisify(execFile)('git', ['init', '--quiet', repoPath]);
  const control = join(directory, 'control.json');
  const binary = join(directory, 'summarizer.mjs');
  writeFileSync(binary, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('codex-cli 0.161.0'); process.exit(0); }
const run = JSON.parse(readFileSync(${JSON.stringify(control)}, 'utf8'));
writeFileSync(run.entered, 'started');
while (!existsSync(run.release)) await new Promise(done => setTimeout(done, 10));
if (run.fail) { console.error('Fixture compaction failed'); process.exit(1); }
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Decisions made\\n- Preserve the sample history.\\nFiles touched\\n- None.\\nOpen questions\\n- None.\\nCurrent mission state\\n- Continue.'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:40}}));
`); chmodSync(binary, 0o700);
  writeFileSync(join(directory, 'repos.json'), JSON.stringify([{ id: 'fixture', name: 'Sample', path: repoPath }]));
  writeFileSync(join(directory, 'operator-defaults.json'), JSON.stringify({ inAppOrchestratorEnabled: true,
    judgmentProvider: 'off', autoTitleInferenceEnabled: false, productTelemetryEnabled: false }));
  vi.stubEnv('O8_DATA_DIR', directory); vi.stubEnv('CORTEX_IDE_DATA_DIR', directory);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(directory, 'data.db')); vi.stubEnv('O8_CODEX_BIN', binary);
  vi.stubEnv('WS_TOKEN', '');
  const probe = createServer(); const wsPort = await listen(probe);
  await new Promise<void>(done => probe.close(() => done()));
  const wsOrigin = `http://127.0.0.1:${wsPort}`;
  vi.stubEnv('CORTEX_REALTIME_INTERNAL_ORIGIN', wsOrigin);
  type CompactRoute = typeof import('@/app/api/orchestrator/compact/route');
  type HistoryRoute = typeof import('@/app/api/v2/chat-history/route');
  let compact: CompactRoute; let history: HistoryRoute; let token = ''; let serial = 0;
  const unavailable = new Set<string>();
  const held = new Map<string, { captured: ReturnType<typeof deferred<CompactionOperation | null>>;
    released: ReturnType<typeof deferred<void>> }>();
  const holds: Array<ReturnType<typeof deferred<void>>> = [];
  const attempts = new Map<string, { release: () => void;
    result: ReturnType<typeof deferred<{ status: number; body: Record<string, unknown> }>> }>();
  const jobs = new Set<Promise<unknown>>();
  const send = async (response: Response, output: ServerResponse) => {
    const body = Buffer.from(await response.arrayBuffer());
    if (output.destroyed) return;
    output.writeHead(response.status, Object.fromEntries(response.headers)); output.end(body);
  };
  const api = createServer((request, output) => {
    const job = handle(request, output).catch(() => {
      if (!output.destroyed) output.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Fixture request failed' }));
    });
    jobs.add(job); void job.finally(() => jobs.delete(job));
  });
  const apiPort = await listen(api);
  const origin = `http://127.0.0.1:${apiPort}`;
  async function handle(request: IncomingMessage, output: ServerResponse) {
    const url = new URL(request.url ?? '/', origin);
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const next = new NextRequest(url, { method: request.method,
      headers: { host: `127.0.0.1:${apiPort}`, 'Content-Type': 'application/json' },
      ...(body ? { body } : {}) });
    if (url.pathname === '/api/orchestrator/compact') {
      if (!compact) return send(Response.json({ error: 'Starting' }, { status: 503 }), output);
      if (request.method === 'POST') {
        const thread = JSON.parse(body).threadId as string;
        const response = await compact.POST(next);
        const result = { status: response.status, body: await response.clone().json() as Record<string, unknown> };
        attempts.get(thread)?.result.resolve(result);
        return send(response, output);
      }
      const thread = url.searchParams.get('threadId') ?? '';
      const delay = held.get(thread); held.delete(thread);
      const disconnect = unavailable.has(thread);
      const response = await compact.GET(next);
      if (delay) {
        delay.captured.resolve((await response.clone().json()).operation);
        await delay.released.promise;
      }
      if (disconnect) { output.destroy(); return; }
      return send(response, output);
    }
    if (url.pathname === '/api/v2/chat-history') {
      if (!history) return send(Response.json({ messages: [] }), output);
      return send(await history.GET(next), output);
    }
    if (url.pathname === '/api/command-center/snapshot') return send(Response.json({
      fleet: { agents: [], meta: { mode: 'live' } }, review: null, reviewError: null,
      browserInventory: { browsers: [] }, attachedBrowser: null, browserError: null,
    }), output);
    if (url.pathname === '/api/mobile/inbox') return send(Response.json({ sessions: [], items: [], summary: {} }), output);
    if (url.pathname.startsWith('/api/')) return send(Response.json({}), output);
    const bootstrap = `<meta name="ws-token" content="${token}"><script>window.__O8_WS_PORT__=${wsPort}</script>`;
    output.writeHead(200, { 'Content-Type': 'text/html' }); output.end(html.replace('<head>', `<head>${bootstrap}`));
  }
  const child = execFile(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', O8_DATA_DIR: directory,
      CORTEX_IDE_DATA_DIR: directory, CORTEX_IDE_DB_PATH: join(directory, 'data.db'),
      CORTEX_IDE_REVIEW_REPO_ROOT: repoPath, O8_API_PORT: String(apiPort), O8_WS_PORT: String(wsPort),
      O8_WS_O8D: '0', NEXT_ORIGIN: origin },
  });
  child.stdout?.resume(); child.stderr?.resume();
  const stopChild = async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    await exited; clearTimeout(timer);
  };
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('Production WebSocket fixture did not start');
      try { if ((await fetch(`${wsOrigin}/health`)).ok) break; } catch { /* Startup. */ }
      await new Promise(done => setTimeout(done, 25));
    }
    token = readFileSync(join(directory, 'ws-token'), 'utf8').trim();
    compact = await import('@/app/api/orchestrator/compact/route');
    history = await import('@/app/api/v2/chat-history/route');
    const store = await import('@/lib/llm/chat-history-store');
    const { closeDb } = await import('@/lib/db');
    const { publishRealtimeMutation } = await import('@/lib/realtime/publisher');
    return {
      origin, repoPath,
      seed() {
        const threadId = `thoughts-browser-${++serial}`;
        const messages = Array.from({ length: 12 }, (_, index) => ({ id: `${threadId}-${index}`,
          role: index % 2 ? 'assistant' : 'user', content: `Sample turn ${index}.`, timestamp: Date.now() - 12_000 + index * 100 }));
        store.persistCanonicalChatHistoryRecord(threadId, { repoPath, backend: 'codex', messages });
        return { threadId, ids: messages.map(message => message.id) };
      },
      prepare(threadId: string, fail = false) {
        const id = ++serial; const entered = join(directory, `entered-${id}`); const release = join(directory, `release-${id}`);
        writeFileSync(control, JSON.stringify({ entered, release, fail }));
        const result = deferred<{ status: number; body: Record<string, unknown> }>();
        const attempt = { release: () => writeFileSync(release, 'continue'), result };
        attempts.set(threadId, attempt);
        return { entered: () => existsSync(entered), release: attempt.release, result: result.promise };
      },
      history: (threadId: string) => store.readPersistedLlmChat(threadId)!.history,
      setUnavailable(threadId: string, value: boolean) { if (value) unavailable.add(threadId); else unavailable.delete(threadId); },
      holdNextReadback(threadId: string) {
        const captured = deferred<CompactionOperation | null>(); const released = deferred<void>();
        held.set(threadId, { captured, released }); holds.push(released);
        return { captured: captured.promise, release: () => released.resolve() };
      },
      republish: (mutation: RealtimeMutationRecord) => publishRealtimeMutation({ mutation }),
      async stop() {
        for (const release of holds) release.resolve();
        for (const attempt of attempts.values()) attempt.release();
        await Promise.allSettled([...jobs]);
        await stopChild(); api.closeAllConnections();
        await new Promise<void>(done => api.close(() => done()));
        closeDb(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stopChild(); api.closeAllConnections(); await new Promise<void>(done => api.close(() => done()));
    vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); throw error;
  }
}
