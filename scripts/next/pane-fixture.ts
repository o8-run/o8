/** Six disposable persisted workers, plus the existing history wire protocol. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { WebSocketServer } from 'ws';
import type { RuntimeSession } from '../../src/lib/runtimes/types';

export async function installPaneRuntime(dataDir: string, repo: string, terminals = false) {
  // Replace discovery only, retaining production inventory projection and the
  // owned runtime's actual persisted transcript reader. No provider is started.
  const { getAllRuntimes, getRuntime } = await import('../../src/lib/runtimes');
  for (const runtime of getAllRuntimes()) {
    Object.defineProperty(runtime, 'discoverSessions', { value: async () => [], configurable: true });
  }
  const sessionDir = join(dataDir, 'owned-pi', 'grid-runtime');
  const runsDir = join(sessionDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const stdoutPath = join(runsDir, 'run.stdout.jsonl');
  const stderrPath = join(runsDir, 'run.stderr.log');
  const timestamp = new Date().toISOString();
  writeFileSync(stdoutPath, JSON.stringify({ type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Persisted grid runtime answer' } }) + '\n' + JSON.stringify({ type: 'agent_end' }) + '\n');
  writeFileSync(stderrPath, '');
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ surfaceId: 'pi-owned:grid-runtime',
    sessionDir, cwd: repo, repoPath: repo, title: 'Grid runtime worker', createdAt: timestamp, updatedAt: timestamp,
    latestPrompt: 'Grid runtime prompt', latestSummary: 'done', recentRuns: [{ id: 'run-grid-runtime', mode: 'launch',
      prompt: 'Grid runtime prompt', startedAt: timestamp, finishedAt: timestamp, stdoutPath, stderrPath, outcome: 'finished' }] }));
  const worker = { sessionKey: 'pi-owned:grid-runtime', runtimeId: 'pi', displayName: 'Grid runtime worker',
    cwd: repo, status: 'running', ownership: 'owned', lastActivityAt: new Date(),
    sessionCapabilities: { canSendInput: false, canInterrupt: false, canReviewDiffs: false } } satisfies RuntimeSession;
  const pi = getRuntime('pi');
  if (!pi) throw new Error('Fixture runtime is not registered');
  Object.defineProperty(pi, 'discoverSessions', { value: async () => terminals ? Array.from({ length: 6 }, (_, index) => {
    const key = `grid-terminal-${index}`;
    const dir = join(dataDir, 'owned-pi', key);
    mkdirSync(dir, { recursive: true });
    const stdout = join(dir, 'stdout.jsonl');
    writeFileSync(stdout, JSON.stringify({ type: 'message_update', assistantMessageEvent: {
      type: 'text_delta', delta: `Persisted pi-owned:${key} answer`,
    } }) + '\n' + JSON.stringify({ type: 'agent_end' }) + '\n');
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ surfaceId: `pi-owned:${key}`,
      sessionDir: dir, cwd: repo, repoPath: repo, title: `Terminal worker ${index}`,
      createdAt: timestamp, updatedAt: timestamp, recentRuns: [{ id: key, mode: 'launch',
        prompt: 'Fixture prompt', startedAt: timestamp, finishedAt: timestamp,
        stdoutPath: stdout, stderrPath, outcome: 'finished' }] }));
    return { ...worker, sessionKey: `pi-owned:${key}`, displayName: `Terminal worker ${index}`,
      tmuxSession: `cortex-next-grid-${index}` };
  }) : [worker], configurable: true });
}

export function seedPaneGrid(dataDir: string, repo: string) {
  return Array.from({ length: 6 }, (_, index) => {
    const id = `thoughts-grid-${index}`;
    const messages = Array.from({ length: 100 }, (_, row) => ({
      id: `${id}-${row}`, role: row % 2 ? 'assistant' : 'user',
      content: `${id} item ${row}: preserve \`stable_id\`.\n\nFixture worker transcript.`,
      timestamp: 1790899200000 + row * 1000,
    }));
    const seed = { id, title: `Worker ${index + 1}: ${'界'.repeat(50)}`, messages };
    writeFileSync(join(dataDir, 'chat-history', `${id}.json`), JSON.stringify({ ...seed,
      repoPath: repo, backend: 'pi', model: 'pi', orchestratorVisible: true,
      savedAt: '2026-10-02T00:00:00.000Z' }));
    return seed;
  });
}

export function attachPaneGridSocket(server: Server, token: string, requests: string[]) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(`WS ${url.pathname}`);
    if (url.pathname !== '/ws' || url.searchParams.get('token') !== token) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.send(JSON.stringify({ channel: 'system', event: 'connected', data: { bootId: 'pane-fixture' } }));
      let timer: ReturnType<typeof setInterval> | undefined;
      let startTimer: ReturnType<typeof setTimeout> | undefined;
      ws.on('message', bytes => {
        const message = JSON.parse(String(bytes)) as { type: string; subscriptions?: Array<{ stream: string }> };
        requests.push(`WS ${message.type}`);
        if (message.type === 'ping') return;
        const stream = message.subscriptions?.[0]?.stream;
        if (timer || startTimer || message.type !== 'realtime-subscribe' || message.subscriptions?.length !== 1
          || !stream || !/^session:(llm-chat:thoughts-grid-[0-5]|pi-owned:grid-runtime)$/.test(stream)) { ws.close(1008); return; }
        const key = stream.slice('session:'.length);
        const id = key.slice('llm-chat:'.length);
        let seq = 0;
        const send = () => {
          seq += 1;
          ws.send(JSON.stringify({ channel: 'realtime', event: 'batch', data: { bootId: 'pane-fixture', events: [{
            stream, seq, capturedSeq: seq, type: 'history.snapshot', data: { sessionKey: key, replace: false,
              entries: [{ id: `${id}-99`, role: 'assistant', type: 'message', timestamp: 1790899299000,
                text: `${id} streaming ${seq}\n\n${'chunk '.repeat(seq % 40 + 1)}` }] },
          }] } }));
        };
        // Initial checkpoint, then a quiet window for the six-pane idle RSS
        // sample. Streaming resumes at 20 Hz on the same live connections.
        send(); startTimer = setTimeout(() => { timer = setInterval(send, 50); }, 2000);
      });
      const stop = () => { clearTimeout(startTimer); clearInterval(timer); };
      ws.on('close', stop);
      ws.on('error', stop);
    });
  });
  return () => { for (const ws of wss.clients) ws.terminate(); wss.close(); };
}
