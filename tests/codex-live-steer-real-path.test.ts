import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { ComposerQueuePayload } from '@/lib/orchestrator/composer-queue-types';

vi.mock('node:os', async original => {
  const os = await original<typeof import('node:os')>();
  return { ...os, default: { ...os, homedir: () => process.env.O8_STEER_TEST_HOME! },
    homedir: () => process.env.O8_STEER_TEST_HOME! };
});
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: async () => {} }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: async () => {} }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: async () => ({ ready: true }) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
// Solo's platform sandbox has its own tests. Keep its exec process real here.
vi.mock('@/lib/lane/single-orchestrator-policy', () => ({ prepareSingleOrchestratorLaunch: async (input: Record<string, unknown>) => ({ ...input, diagnostics: [], cleanup: () => {} }) }));
vi.mock('@/components/desktop/thoughts/InputButtons', () => ({ InputButtons: () => null }));
vi.mock('@/components/desktop/thoughts/chat-panel/SlashCommandPicker', () => ({ SlashCommandPicker: () => null }));
vi.mock('@/components/desktop/thoughts/chat-panel/ComposerStatusBar', () => ({ ComposerStatusBar: () => null }));

const root = realpathSync(mkdtempSync(join(getDataDir(), 'codex-live-steer-')));
const home = join(root, 'home');
mkdirSync(join(home, '.codex'), { recursive: true });
vi.stubEnv('O8_STEER_TEST_HOME', home);
vi.stubEnv('O8_CODEX_BIN', join(root, 'codex'));
vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', '0');
writeFileSync(join(root, 'codex'), `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
const record = entry => appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify({ cwd: process.cwd(), ...entry }) + '\\n');
const send = message => console.log(JSON.stringify(message));
if (process.argv[2] !== 'app-server') {
  record({ method: 'exec' });
  send({ type: 'thread.started', thread_id: 'exec-thread' });
  setInterval(() => {}, 1000);
} else {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1);
      record(message);
      const reply = result => send({ id: message.id, result });
      if (message.method === 'initialize') reply({});
      if (message.method === 'thread/start') reply({ thread: { id: 'native-thread' } });
      if (message.method === 'turn/start') reply({ turn: { id: 'running-turn', status: 'inProgress' } });
      if (message.method === 'turn/steer') {
        const outcome = readFileSync(join(process.cwd(), 'outcome'), 'utf8');
        if (outcome === 'refused' || outcome === 'mismatched') {
          send({ id: message.id, error: { code: -32600, message: outcome === 'mismatched' ? 'expectedTurnId does not match the active turn' : 'turn cannot accept input' } });
        } else if (outcome === 'unconfirmed') reply({});
        else if (outcome === 'disconnected') process.exit(0);
        else if (outcome === 'silent') continue;
        else if (outcome === 'wrong-ack') reply({ turnId: 'another-turn' });
        else reply({ turnId: message.params.expectedTurnId });
      }
      if (message.method === 'turn/interrupt') {
        reply({});
        send({ method: 'turn/completed', params: { threadId: 'native-thread', turn: { id: 'running-turn', status: 'interrupted' } } });
      }
    }
  });
}
`);
chmodSync(join(root, 'codex'), 0o700);

const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { getOrchestratorBackend } = await import('@/lib/lane/orchestrator-backends/registry');
const { getCodexOrchestratorSession } = await import('@/lib/lane/codex-orchestrator-session');
const { getSqlite, closeDb } = await import('@/lib/db');
const { ensureV71ComposerQueueSchema } = await import('@/lib/db/v71-composer-queue-migration');
ensureV71ComposerQueueSchema(getSqlite());
const queue = await import('@/lib/orchestrator/composer-queue');
const { GET, POST, PATCH } = await import('@/app/api/orchestrator/composer-queue/route');
const { createComposerQueueHeartbeat } = await import('@/lib/ws-server/composer-queue-heartbeat');

interface Call { cwd: string; method: string; params?: Record<string, unknown> }
const calls = (): Call[] => existsSync(join(root, 'calls.jsonl'))
  ? readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
let sequence = 0;
async function running(outcome = 'accepted', options: { bridge?: boolean; model?: string; orchestrationMode?: 'single'; crashSurvival?: boolean; alias?: boolean } = {}) {
  const id = ++sequence;
  const actualCwd = join(root, `repo-${id}`); mkdirSync(actualCwd); execFileSync('git', ['init', '-q', actualCwd]);
  const cwd = options.alias ? join(root, `alias-${id}`) : actualCwd;
  if (options.alias) symlinkSync(actualCwd, cwd, 'dir');
  writeFileSync(join(cwd, 'outcome'), outcome);
  const target = { repoPath: cwd, threadId: `thoughts-steer-${id}` };
  mkdirSync(join(getDataDir(), 'chat-history'), { recursive: true });
  writeFileSync(join(getDataDir(), 'chat-history', `${target.threadId}.json`), JSON.stringify({
    repoPath: cwd, backend: 'codex', messages: [{ id: 'working', role: 'assistant', content: 'Working', timestamp: 1 }],
  }));
  await updateOperatorDefaults({ codexAppThreads: options.bridge !== false });
  vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', options.crashSurvival ? '1' : '0');
  const controller = new AbortController();
  const turn = getOrchestratorBackend('codex').sendTurn(cwd, 'Start working', () => {}, {
    threadId: target.threadId, model: options.model ?? 'gpt-5.5', signal: controller.signal, orchestrationMode: options.orchestrationMode,
  });
  const close = async () => {
    const proc = getCodexOrchestratorSession(cwd, target.threadId)?.proc;
    const closed = proc && proc.exitCode === null && proc.signalCode === null ? new Promise<void>(resolve => proc.once('close', () => resolve())) : Promise.resolve();
    controller.abort(); await turn; await closed;
  };
  try {
    await vi.waitFor(() => expect(calls().some(call => call.cwd === actualCwd && ['turn/start', 'exec'].includes(call.method))).toBe(true), { timeout: 20_000 });
  } catch (error) { await close(); throw error; }
  // Wait for the parent to consume the bridge's turn.started acknowledgement.
  await new Promise(resolve => setTimeout(resolve, 100));
  const payload: ComposerQueuePayload = { text: 'Use the smaller change', wireMessage: 'Use the smaller change', images: [],
    routing: { backend: 'codex', model: options.model ?? 'gpt-5.5', effort: 'low', permissionMode: 'full', mode: 'fleet', pickedMode: 'multitask', collide: false } };
  const request = (method: string, body?: unknown) => new NextRequest('http://localhost/api/orchestrator/composer-queue', {
    method, headers: { host: 'localhost', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { target, payload, turn, request, controller,
    steers: () => calls().filter(call => call.cwd === actualCwd && call.method === 'turn/steer'),
    capability: async (threadId = target.threadId) => {
      const response = await GET(new NextRequest(`http://localhost/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(cwd)}&threadId=${threadId}&backend=codex`, { headers: { host: 'localhost' } }));
      expect(response.status).toBe(200); return response.json();
    },
    close,
  };
}

afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('Codex native live steer through the composer and bridge', () => {
  it.each(['accepted', 'refused', 'mismatched', 'unconfirmed', 'wrong-ack', 'disconnected', 'silent', 'crash-survival'])('records native admission and persists %s without replay', async outcome => {
    const accepted = outcome === 'accepted' || outcome === 'crash-survival';
    const fixture = await running(accepted ? 'accepted' : outcome, { crashSurvival: outcome === 'crash-survival' });
    const heartbeat = createComposerQueueHeartbeat({ isBusy: () => true, readTranscript: async () => [], publish: () => {}, registerAbort: () => () => {} });
    const id = `codex-queue-${sequence}`;
    try {
      const posted = await POST(fixture.request('POST', { ...fixture.target, id, intent: 'send-next', payload: fixture.payload }));
      expect(posted.status).toBe(200);
      expect((await PATCH(fixture.request('PATCH', { ...fixture.target, id }))).status).toBe(200);
      expect((await fixture.capability()).steerableIds).toContain(id);
      heartbeat();
      const status = accepted ? 'applied' : ['refused', 'mismatched'].includes(outcome) ? 'queued' : 'held';
      await vi.waitFor(() => expect(queue.readComposerSend(id)?.status).toBe(status), { timeout: 15_000 });
      expect(fixture.steers()).toHaveLength(1);
      expect(fixture.steers()[0].params).toEqual({ threadId: 'native-thread', expectedTurnId: 'running-turn',
        input: [{ type: 'text', text: fixture.payload.wireMessage, text_elements: [] }], clientUserMessageId: id });
      const item = queue.readComposerSend(id)!;
      expect(item.payload).toEqual(fixture.payload);
      expect(item.intent).toBe(['refused', 'mismatched'].includes(outcome) ? 'send-next' : 'steer-now');
      expect(item.admittedAt === null).toBe(['refused', 'mismatched'].includes(outcome));
      const { readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');
      const delivered = readPersistedLlmChat(fixture.target.threadId)!.history.messages?.some(message => message.id === `composer-steer-${id}`);
      expect(Boolean(delivered)).toBe(accepted);
      heartbeat(); await new Promise(resolve => setTimeout(resolve, 100)); expect(fixture.steers()).toHaveLength(1);
      closeDb(); ensureV71ComposerQueueSchema(getSqlite());
      expect(queue.readComposerSend(id)?.status).toBe(status);
    } finally { await fixture.close(); }
  }, 60_000);

  it('advertises only the running bridge thread and withdraws the capability after Stop', async () => {
    const fixture = await running();
    try {
      expect((await fixture.capability()).canSteer).toBe(true);
      expect((await fixture.capability('thoughts-another')).canSteer).toBe(false);
      const { publishRealtimeMutation } = await import('@/lib/realtime/publisher');
      expect(publishRealtimeMutation).toHaveBeenCalledWith(expect.objectContaining({ mutation: expect.objectContaining({
        action: 'composer-queue', surfaceId: fixture.target.threadId,
      }) }));
      expect(getCodexOrchestratorSession(fixture.target.repoPath, fixture.target.threadId)?.status).toBe('busy');
    } finally { await fixture.close(); }
    expect((await fixture.capability()).canSteer).toBe(false);
  }, 60_000);

  it.each([{ bridge: false }, { model: 'ollama:fixture' }, { orchestrationMode: 'single' as const }])('keeps exec, local models and Solo Queue-only: %j', async options => {
    const fixture = await running('accepted', options);
    try { expect((await fixture.capability()).canSteer).toBe(false); expect(fixture.steers()).toEqual([]); }
    finally { await fixture.close(); }
  }, 60_000);

  it('runs beforeAdmit at the last handoff and fences cancellation and changed routing', async () => {
    const fixture = await running();
    try {
      const capability = await fixture.capability(); expect(capability.canSteer).toBe(true);
      const backend = getOrchestratorBackend('codex', fixture.target);
      const options = { threadId: fixture.target.threadId, model: fixture.payload.routing.model, permissionMode: 'full' as const,
        clientUserMessageId: 'guard-steer', beforeAdmit: vi.fn(() => { expect(fixture.steers()).toEqual([]); throw new Error('Stopped before handoff'); }) };
      await expect(backend.liveSteer!(fixture.target.repoPath, 'Smaller', options)).rejects.toThrow('Stopped before handoff');
      expect(options.beforeAdmit).toHaveBeenCalledOnce();
      options.beforeAdmit.mockClear();
      for (const changed of [{ model: 'different' }, { permissionMode: 'plan' as const }, { toolProfile: 'propose' as const }]) {
        expect(await backend.liveSteer!(fixture.target.repoPath, 'Smaller', { ...options, ...changed })).toEqual({ accepted: false });
      }
      expect(options.beforeAdmit).not.toHaveBeenCalled(); expect(fixture.steers()).toEqual([]);
      const admitted = { ...options, beforeAdmit: vi.fn() };
      expect(await backend.liveSteer!(fixture.target.repoPath, 'Smaller', admitted)).toEqual({ accepted: true });
      await expect(backend.liveSteer!(fixture.target.repoPath, 'Smaller', admitted)).rejects.toThrow('unique queued message');
      expect(admitted.beforeAdmit).toHaveBeenCalledOnce(); expect(fixture.steers()).toHaveLength(1);
    } finally { await fixture.close(); }
  }, 60_000);

  it.each(['images', 'solo', 'fusion'])('defers a %s steer with the complete saved payload', async kind => {
    const fixture = await running();
    const heartbeat = createComposerQueueHeartbeat({ isBusy: () => true, readTranscript: async () => [], publish: () => {}, registerAbort: () => () => {} });
    const id = `codex-image-${sequence}`;
    try {
      const payload = { ...fixture.payload,
        images: kind === 'images' ? [{ name: 'proof.png', dataUri: 'data:image/png;base64,YQ==' }] : [],
        routing: { ...fixture.payload.routing, mode: kind === 'solo' ? 'single' as const : kind === 'fusion' ? 'fusion' as const : 'fleet' as const } };
      expect((await POST(fixture.request('POST', { ...fixture.target, id, intent: 'steer-now', payload }))).status).toBe(200);
      heartbeat();
      await vi.waitFor(() => expect(queue.readComposerSend(id)?.intent).toBe('send-next'));
      expect(queue.readComposerSend(id)).toMatchObject({ status: 'queued', admittedAt: null, payload });
      expect(fixture.steers()).toEqual([]);
    } finally { await fixture.close(); }
  }, 60_000);

  it('discovers and steers a bridge launched through a repository symlink', async () => {
    const fixture = await running('accepted', { alias: true });
    const heartbeat = createComposerQueueHeartbeat({ isBusy: () => true, readTranscript: async () => [], publish: () => {}, registerAbort: () => () => {} });
    const id = `codex-symlink-${sequence}`;
    try {
      expect((await fixture.capability()).canSteer).toBe(true);
      expect((await POST(fixture.request('POST', { ...fixture.target, id, intent: 'steer-now', payload: fixture.payload }))).status).toBe(200);
      heartbeat();
      await vi.waitFor(() => expect(queue.readComposerSend(id)?.status).toBe('applied'), { timeout: 15_000 });
      expect(fixture.steers()).toHaveLength(1);
    } finally { await fixture.close(); }
  }, 60_000);

  it('defaults the Codex lead composer to Steer from the real bridge capability response', async () => {
    const fixture = await running();
    try {
      const { ComposerArea } = await import('@/components/desktop/thoughts/chat-panel/ComposerArea');
      const { canSteer } = await fixture.capability();
      const noop = () => {};
      const html = renderToStaticMarkup(createElement(ComposerArea, {
        input: 'Smaller change', onInputChange: noop, isOrchestratorMode: true, activeBackend: 'codex',
        displayWaiting: true, chatMessages: [], activeTargetLabel: 'Codex', targetAgentExists: true,
        thoughtsBodyBackground: 'transparent', enhancing: false, preEnhanceInput: null, onEnhance: noop, onUndoEnhance: noop,
        onSubmit: noop, onSteer: noop, canSteerLive: canSteer, onSlashCommand: noop, modelLabel: 'Codex',
        effort: 'low', onEffortChange: noop, adaptiveEnabled: false, displayMessagesCount: 2, hasAssistantActivity: true,
      }));
      expect(html).toContain('placeholder="Steer the agent…"');
    } finally { await fixture.close(); }
  }, 60_000);

  it.each(['stop', 'permissions'])('rechecks durable admission at the relay owner after %s crosses the socket handoff', async change => {
    const fixture = await running();
    const id = `codex-relay-fence-${sequence}`;
    try {
      expect((await POST(fixture.request('POST', { ...fixture.target, id, intent: 'steer-now', payload: fixture.payload }))).status).toBe(200);
      expect(queue.claimComposerSteer(id)).not.toBeNull();
      const { getRemoteCodexAppBridgeSteer } = await import('@/lib/codex/app-bridge-steer-relay');
      const steer = getRemoteCodexAppBridgeSteer(fixture.target)!;
      await expect(steer(fixture.target.repoPath, fixture.payload.wireMessage, {
        threadId: fixture.target.threadId, model: fixture.payload.routing.model, permissionMode: 'full', clientUserMessageId: id,
        beforeAdmit: () => {
          expect(queue.admitComposerSend(id)).toBe(true);
          if (change === 'stop') queue.holdComposerSends(fixture.target);
          else writeFileSync(join(getDataDir(), 'chat-history', `${fixture.target.threadId}.json`), JSON.stringify({
            repoPath: fixture.target.repoPath, backend: 'codex', messages: [{ id: 'restricted', role: 'assistant', content: 'Plan only',
              timestamp: Date.now() + 1, receipt: { permissionMode: 'plan' } }],
          }));
        },
      })).rejects.toThrow('not confirmed');
      expect(fixture.steers()).toEqual([]);
    } finally { await fixture.close(); }
  }, 60_000);

  it('advertises and steers the bridge from another server process', async () => {
    const fixture = await running();
    const id = `codex-cross-process-${sequence}`;
    try {
      fixture.payload.wireMessage = `Use this constraint: ${'\u0000界'.repeat(100_000)}`;
      expect((await POST(fixture.request('POST', { ...fixture.target, id, intent: 'steer-now', payload: fixture.payload }))).status).toBe(200);
      const script = join(root, 'remote-server.mts');
      writeFileSync(script, `
        import { NextRequest } from ${JSON.stringify(join(process.cwd(), 'node_modules/next/server.js'))};
        import route from ${JSON.stringify(join(process.cwd(), 'src/app/api/orchestrator/composer-queue/route.ts'))};
        import queue from ${JSON.stringify(join(process.cwd(), 'src/lib/orchestrator/composer-queue.ts'))};
        import heartbeat from ${JSON.stringify(join(process.cwd(), 'src/lib/ws-server/composer-queue-heartbeat.ts'))};
        const { GET } = route;
        const { claimComposerSteer } = queue;
        const { runQueuedComposerSteer } = heartbeat;
        const response = await GET(new NextRequest(${JSON.stringify(`http://localhost/api/orchestrator/composer-queue?repoPath=${encodeURIComponent(fixture.target.repoPath)}&threadId=${fixture.target.threadId}&backend=codex`)}, { headers: { host: 'localhost' } }));
        const capability = await response.json();
        await runQueuedComposerSteer(claimComposerSteer(${JSON.stringify(id)})!);
        console.log('CAPABILITY ' + JSON.stringify(capability));
      `);
      const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--import', join(process.cwd(), 'scripts/register-server-only-stub.mjs'), script],
      { cwd: process.cwd(), env: { ...process.env, CODEX_HOME: join(home, '.codex') }, timeout: 30_000 });
      const capability = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('CAPABILITY '))!.slice('CAPABILITY '.length));
      expect(capability.canSteer).toBe(true);
      expect(queue.readComposerSend(id)?.status).toBe('applied');
      expect(fixture.steers()).toHaveLength(1);
      const input = fixture.steers()[0].params?.input as Array<{ text: string }>;
      expect(input[0].text === fixture.payload.wireMessage).toBe(true);
    } finally { await fixture.close(); }
  }, 60_000);
});
