import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildOrchestratorSendPayload } from '@/components/desktop/thoughts/use-orchestrator-stream/send-payload';
import { MODEL_IDS } from '@/lib/models';

const root = mkdtempSync(join(process.env.CORTEX_IDE_DATA_DIR!, 'composer-recovery-'));
const repoPath = join(root, 'repo');
const sessions = join(root, 'sessions');
const binary = join(root, 'fixture-runtime.mjs');
const auth = randomUUID();
const firstMessage = 'Remember: the sample identifier is widget-731 and its accent is copper. Reply briefly.';
const followup = 'What identifier and accent did we choose earlier?';
type History = { repoPath: string; messages: Array<{ role: string; content: string; model?: string }>; orchestratorSessionIds: Record<string, string> };
type WireEvent = { event?: string; data?: { threadId?: string; status?: string; error?: string } };
let api: Server;
let worker: ChildProcess;
let socket: WebSocket;
let serverOutput = '';
const events: WireEvent[] = [];

async function until(check: () => boolean, description: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${description}. ${serverOutput.slice(-2000)}`);
}
function historyPath(threadId: string) { return join(root, 'chat-history', `${threadId}.json`); }
function history(threadId: string): History { return JSON.parse(readFileSync(historyPath(threadId), 'utf8')); }
function calls(): Array<{ resume: boolean; threadId: string; message: string; model: string }> {
  const path = join(sessions, 'calls.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
async function send(threadId: string, message: string, model: string) {
  const start = events.length;
  socket.send(buildOrchestratorSendPayload({
    repoPath, threadId, clientMessageId: randomUUID(), wireMessage: message, displayMessage: message,
    backend: 'codex', model, permissionMode: 'plan', orchestrationMode: 'fleet', pinBackend: true,
  }));
  await until(() => events.slice(start).some(event => event.data?.threadId === threadId
    && event.event === 'status' && event.data.status === 'ready'), 'composer turn completion');
  return events.slice(start);
}
beforeAll(async () => {
  mkdirSync(repoPath); mkdirSync(sessions);
  execFileSync('git', ['init', '-q', repoPath]);
  copyFileSync(resolve('tests/fixtures/missing-session-runtime.mjs'), binary);
  chmodSync(binary, 0o755);
  writeFileSync(join(root, 'ws-token'), auth, { mode: 0o600 });
  writeFileSync(join(root, 'repos.json'), JSON.stringify({ version: 1, repos: [
    { id: 'recovery-repo', name: 'recovery', localPath: repoPath, addedAt: new Date().toISOString() },
  ] }));
  writeFileSync(join(root, 'operator-defaults.json'), JSON.stringify({
    orchestratorBackend: 'codex', orchestratorModel: MODEL_IDS.raw.openAiGpt55, codexAppThreads: false,
  }));
  api = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url === '/api/setup/identity' ? { configured: false } : { ready: true }));
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const apiPort = (api.address() as { port: number }).port;
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const wsPort = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  worker = execFile(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, O8_DATA_DIR: root, CORTEX_IDE_DATA_DIR: root, CORTEX_IDE_DB_PATH: join(root, 'state.db'),
      O8_WS_PORT: String(wsPort), O8_API_PORT: String(apiPort), NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
      O8_CODEX_BIN: binary, O8_CLAUDE_CODE_BIN: binary,
      O8_CRASH_SURVIVABLE_ORCHESTRATOR: '0', O8_SUBSCRIPTION_PROFILE: 'both',
      CORTEX_IDE_OWNED_CODEX_ROOT: join(root, 'owned-runtime') },
  });
  worker.stdout?.on('data', chunk => { serverOutput += String(chunk); });
  worker.stderr?.on('data', chunk => { serverOutput += String(chunk); });
  await until(() => serverOutput.includes('WebSocket server listening'), 'server launch', 60_000);
  socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(auth)}`);
  socket.on('message', chunk => { events.push(JSON.parse(String(chunk))); });
  await once(socket, 'open');
}, 90_000);
afterAll(async () => {
  socket?.terminate();
  if (worker?.exitCode === null) {
    worker.kill('SIGTERM');
    await Promise.race([once(worker, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
  }
  if (api?.listening) { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); }
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => rmSync(join(sessions, 'control.json'), { force: true }));

describe('composer recovery from a missing persisted runtime session', () => {
  it.each(['same-model', 'changed-model', 'healthy-control'] as const)('carries the visible facts through %s', async (scenario) => {
    const threadId = `thoughts-recovery-${scenario}`;
    const originalModel = MODEL_IDS.raw.openAiGpt55;
    const selectedModel = scenario === 'changed-model' ? MODEL_IDS.raw.openAiGpt56Sol : originalModel;
    expect((await send(threadId, firstMessage, originalModel)).filter(event => event.event === 'error')).toEqual([]);
    const saved = history(threadId);
    expect(saved.messages.filter(message => message.role === 'assistant').at(-1)?.content).toBe('widget-731 / copper');
    const savedSession = saved.orchestratorSessionIds.codex;
    expect(existsSync(join(sessions, savedSession + '.json'))).toBe(true);
    if (scenario !== 'healthy-control') rmSync(join(sessions, savedSession + '.json'));
    const start = calls().length;
    const result = await send(threadId, followup, selectedModel);
    const received = calls().slice(start);
    expect(result.filter(event => event.event === 'error')).toEqual([]);
    expect(received).toHaveLength(scenario === 'healthy-control' ? 1 : 2);
    expect(received.every(call => call.model === selectedModel)).toBe(true);
    expect(received[0]).toMatchObject({ resume: true, threadId: savedSession });
    if (scenario !== 'healthy-control') {
      expect.soft(received[1].message).toContain('widget-731');
      expect.soft(received[1].message).toContain('copper');
      expect.soft(received[1].resume).toBe(false);
    }
    const continued = history(threadId);
    expect.soft(continued.messages.filter(message => message.role === 'assistant').at(-1)?.content).toBe('widget-731 / copper');
    expect(continued.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([firstMessage, followup]);
    expect(continued.messages.filter(message => message.role === 'assistant').at(-1)?.model).toBe(selectedModel);
  }, 60_000);

  it.each(['unavailable', 'oversized', 'media'] as const)('holds visibly when the earlier canonical conversation is %s', async reason => {
    const threadId = `thoughts-recovery-${reason}`;
    await send(threadId, firstMessage, MODEL_IDS.raw.openAiGpt55);
    const saved = history(threadId);
    rmSync(join(sessions, saved.orchestratorSessionIds.codex + '.json'));
    if (reason === 'unavailable') saved.messages = [];
    if (reason === 'oversized') saved.messages[0].content += 'x'.repeat(256_001);
    if (reason === 'media') Object.assign(saved.messages[0], { media: [{ type: 'image', name: 'earlier-image.png' }] });
    writeFileSync(historyPath(threadId), JSON.stringify(saved));
    const start = calls().length;
    const result = await send(threadId, followup, MODEL_IDS.raw.openAiGpt55);
    expect(calls().slice(start)).toHaveLength(1);
    expect(result).toContainEqual(expect.objectContaining({ event: 'error', data: expect.objectContaining({
      error: expect.stringContaining('start a new chat to deliberately continue without its earlier context'),
    }) }));
    expect(history(threadId).orchestratorSessionIds.codex).toBe(saved.orchestratorSessionIds.codex);
  }, 60_000);

  it.each(['streamed-output', 'second-failure', 'cancelled'] as const)('preserves the %s retry safeguard', async scenario => {
    const threadId = `thoughts-recovery-${scenario}`;
    await send(threadId, firstMessage, MODEL_IDS.raw.openAiGpt55);
    rmSync(join(sessions, history(threadId).orchestratorSessionIds.codex + '.json'));
    writeFileSync(join(sessions, 'control.json'), JSON.stringify({
      streamFirst: scenario === 'streamed-output', refuseFresh: scenario === 'second-failure',
      waitForInterrupt: scenario === 'cancelled',
    }));
    const start = calls().length;
    const pending = send(threadId, followup, MODEL_IDS.raw.openAiGpt55);
    if (scenario === 'cancelled') {
      await until(() => calls().length > start, 'resumed runtime launch');
      socket.send(JSON.stringify({ type: 'orchestrator-interrupt', repoPath, threadId, backend: 'codex' }));
    }
    const result = await pending;
    expect(calls().slice(start)).toHaveLength(scenario === 'second-failure' ? 2 : 1);
    if (scenario !== 'cancelled') expect(result.some(event => event.event === 'error')).toBe(true);
    if (scenario === 'streamed-output') {
      expect(history(threadId).messages.filter(message => message.role === 'assistant').at(-1)?.content).toContain('Partial answer');
    }
    rmSync(join(sessions, 'control.json'));
    await send(threadId, followup, MODEL_IDS.raw.openAiGpt55);
    expect(history(threadId).messages.filter(message => message.role === 'assistant').at(-1)?.content).toBe('widget-731 / copper');
  }, 60_000);

  it('keeps recovery required if cancellation happens before the replacement session starts', async () => {
    const threadId = 'thoughts-recovery-cancelled-replacement';
    await send(threadId, firstMessage, MODEL_IDS.raw.openAiGpt55);
    const savedSession = history(threadId).orchestratorSessionIds.codex;
    rmSync(join(sessions, savedSession + '.json'));
    writeFileSync(join(sessions, 'control.json'), JSON.stringify({ waitOnFresh: true }));
    const start = calls().length;
    const pending = send(threadId, followup, MODEL_IDS.raw.openAiGpt55);
    await until(() => calls().length === start + 2, 'replacement runtime launch');
    socket.send(JSON.stringify({ type: 'orchestrator-interrupt', repoPath, threadId, backend: 'codex' }));
    await pending;
    expect.soft(history(threadId).orchestratorSessionIds.codex).toBe(savedSession);
    rmSync(join(sessions, 'control.json'));
    await send(threadId, followup, MODEL_IDS.raw.openAiGpt55);
    expect(history(threadId).messages.filter(message => message.role === 'assistant').at(-1)?.content).toBe('widget-731 / copper');
  }, 60_000);
});
