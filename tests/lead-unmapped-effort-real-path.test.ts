import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MANUAL_THINKING_EFFORTS } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { OrchestratorBackend } from '@/lib/lane/orchestrator-backends/types';

const queuedBackend = vi.hoisted(() => ({ current: null as OrchestratorBackend | null }));
vi.mock('@/lib/lane/orchestrator-backends/registry', () => ({ getOrchestratorBackend: () => queuedBackend.current! }));

const processStarts = vi.hoisted(() => [] as import('node:child_process').ChildProcess[]);
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    if (Array.isArray(args[1]) && args[1].some(arg => arg.endsWith('/peer.cjs'))) processStarts.push(child);
    return child;
  } };
});
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: async () => {} }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-lead-effort-transport-')));
const repo = join(root, 'repo'), capture = join(root, 'acp.jsonl'), peer = join(root, 'peer.cjs');
mkdirSync(repo);
vi.stubEnv('O8_DATA_DIR', join(root, 'data')); vi.stubEnv('CORTEX_IDE_DATA_DIR', join(root, 'data'));
const { makeAcpBackend } = await import('@/lib/lane/orchestrator-backends/acp');
const { createPiOrchestratorBackend } = await import('@/lib/lane/orchestrator-backends/pi');
const { createO8Backend } = await import('@/lib/lane/orchestrator-backends/o8');
const piBackends: ReturnType<typeof createPiOrchestratorBackend>[] = [];
const requests: Record<string, unknown>[] = [];
let sequence = 0;
let inferenceHold: Promise<void> | undefined;
writeFileSync(peer, `
const fs=require('node:fs'),file=process.argv[2];
const send=frame=>console.log(JSON.stringify(frame));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.id)return;fs.appendFileSync(file,JSON.stringify(m)+'\\n');
 let result={};
 if(m.method==='initialize')result={protocolVersion:1};
 if(m.method==='session/new')result={sessionId:'fixture-session',configOptions:[{id:'model',category:'model',type:'select',currentValue:'fixture/model/low',options:[{value:'fixture/model/low'},{value:'fixture/model/high'}]}]};
 if(m.method==='session/prompt'){
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Fixture answer'}}}});
  result={stopReason:'end_turn'};setTimeout(()=>process.exit(0),30);
 }
 send({jsonrpc:'2.0',id:m.id,result});
}).on('close',()=>process.exit(0));
`);
function calls() {
  return existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
const relay: typeof fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body)); requests.push(body);
  await inferenceHold;
  const chunk = (extra: unknown) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: body.model, ...extra as object })}\n\n`;
  return new Response(chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Fixture answer' }, finish_reason: null }] })
    + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
};
function acp() {
  return makeAcpBackend({ id: 'acp', label: 'Fixture agent', resolveLaunch: () => ({ command: process.execPath, args: [peer, capture] }) });
}
function pi() {
  const backend = createPiOrchestratorBackend({ stateRoot: () => join(root, `sdk-${++sequence}`),
    openServers: async () => ({ servers: [], close: async () => {} }), managedInference: {
      resolveRoute: async () => ({ via: 'proxy', url: 'https://example.invalid/inference', headers: {} }), fetch: relay,
    } });
  piBackends.push(backend); return backend;
}
function textOnly() { return createO8Backend({ blocker: () => 'Fixture text-only mode' }); }
beforeEach(() => {
  inferenceHold = undefined;
  requests.length = 0; rmSync(capture, { force: true });
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response('data: {"type":"content","text":"Fixture answer"}\n\ndata: [DONE]\n\n');
  }));
});
afterEach(async () => {
  await Promise.all(piBackends.splice(0).map(backend => backend.closeAll()));
  await Promise.all(processStarts.splice(0).map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', () => resolve()); child.kill();
  })));
  vi.unstubAllGlobals();
});
afterAll(async () => { (await import('@/lib/db')).closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it.each(['acp', 'sdk', 'built-in'] as const)('refuses every independent concrete pin before %s submits a turn', async kind => {
  for (const thinkingEffort of MANUAL_THINKING_EFFORTS) {
    const backend = kind === 'acp' ? acp() : kind === 'sdk' ? pi() : textOnly();
    const events: OrchestratorEvent[] = [];
    await backend.sendTurn(repo, 'Fixture task', event => events.push(event), { thinkingEffort, threadId: `refuse-${kind}-${thinkingEffort}` });
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'effort_unsupported_runtime',
      error: expect.stringMatching(/independent.*effort/i) }));
    expect(events.some(event => event.type === 'turn_receipt')).toBe(false);
  }
  expect(calls()).toEqual([]); expect(requests).toEqual([]);
});
it.each([undefined, 'adaptive'] as const)('keeps %s at the ACP default and reports no observed concrete reasoning', async thinkingEffort => {
  const events: OrchestratorEvent[] = [];
  await acp().sendTurn(repo, 'Fixture task', event => events.push(event), { thinkingEffort, threadId: `default-acp-${thinkingEffort}` });
  expect(events).toContainEqual(expect.objectContaining({ type: 'turn_receipt', effort: 'adaptive', effortSource: 'runtime-default' }));
  expect(calls().filter(call => call.method === 'session/prompt')).toHaveLength(1);
});
it('preserves a model-encoded ACP variant unchanged without claiming an independent effort', async () => {
  const events: OrchestratorEvent[] = [];
  await acp().sendTurn(repo, 'Fixture task', event => events.push(event), { model: 'fixture/model/high', threadId: 'encoded-model' });
  expect(calls().find(call => call.method === 'session/set_config_option').params.value).toBe('fixture/model/high');
  expect(events).toContainEqual(expect.objectContaining({ type: 'turn_receipt', leadModel: 'fixture/model/high', effort: 'adaptive', effortSource: 'runtime-default' }));
});
it.each([undefined, 'adaptive'] as const)('keeps %s at the SDK default and captures the actual request without reasoning fields', async thinkingEffort => {
  const events: OrchestratorEvent[] = [];
  await pi().sendTurn(repo, 'Fixture task', event => events.push(event), { thinkingEffort, threadId: `default-sdk-${thinkingEffort}` });
  expect(events.filter(event => event.type === 'error')).toEqual([]); expect(requests).toHaveLength(1);
  expect(requests[0]).not.toHaveProperty('reasoning_effort'); expect(requests[0]).not.toHaveProperty('reasoning');
  expect(events).toContainEqual(expect.objectContaining({ type: 'turn_receipt', effort: 'adaptive', effortSource: 'runtime-default' }));
});
it.each(['pi', 'o8'] as const)('holds a queued high steer on an active %s lead before admission with a visible reason', async kind => {
  const sdk = pi();
  const backend = kind === 'pi' ? sdk : createO8Backend({ pi: sdk, blocker: () => null });
  queuedBackend.current = backend;
  const { writePersistedLlmChat, readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');
  const queue = await import('@/lib/orchestrator/composer-queue');
  const { createComposerQueueHeartbeat } = await import('@/lib/ws-server/composer-queue-heartbeat');
  const threadId = `thoughts-queued-effort-${kind}`;
  writePersistedLlmChat(threadId, { repoPath: repo, messages: [] });
  let release!: () => void;
  inferenceHold = new Promise<void>(resolve => { release = resolve; });
  const turn = backend.sendTurn(repo, 'Start at the runtime default', () => {}, { threadId });
  try {
    await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 30_000 });
    const id = `queued-high-${kind}`;
    queue.enqueueComposerSend({ repoPath: repo, threadId, id, intent: 'steer-now', payload: {
      text: 'Do this with high effort', wireMessage: 'Do this with high effort', images: [],
      routing: { backend: kind, model: kind, effort: 'high', permissionMode: 'full', mode: 'single', pickedMode: 'solo', collide: false },
    } });
    createComposerQueueHeartbeat({ isBusy: () => true, readTranscript: async () => [],
      registerAbort: () => () => {}, publish: () => {} })();
    await vi.waitFor(() => expect(queue.readComposerSend(id)?.status).not.toBe('dispatching'), { timeout: 10_000 });
    expect(queue.readComposerSend(id)).toMatchObject({ status: 'held', admittedAt: null,
      reason: expect.stringMatching(/cannot apply.*independent thinking effort "high".*no verified mapping/i) });
    expect(readPersistedLlmChat(threadId)?.history.messages).toEqual([]);
    expect(requests).toHaveLength(1);
  } finally {
    inferenceHold = undefined; release(); await turn;
  }
}, 90_000);
it('labels a managed text-only service tier separately from provider reasoning', async () => {
  const events: OrchestratorEvent[] = [];
  await textOnly().sendTurn(repo, 'Fixture task', event => events.push(event), { threadId: 'managed-default' });
  expect(requests[0].thinkingEffort).toBe('low');
  expect(events).toContainEqual(expect.objectContaining({ type: 'turn_receipt', effort: 'adaptive', effortSource: 'runtime-default', serviceTier: 'low' }));
});

it('continues a persisted service-tier receipt without turning it into a reasoning pin', async () => {
  const { writePersistedLlmChat } = await import('@/lib/llm/chat-history-store');
  const { resolveMobileTurnSelection } = await import('@/lib/ws-server/mobile-turn-selection');
  const { resolveChatTurnOrigin } = await import('@/lib/orchestrator/review-continuation-origin');
  const threadId = 'thoughts-tier-continuation';
  writePersistedLlmChat(threadId, { repoPath: repo, messages: [{
    id: 'tier-origin', role: 'assistant', backend: 'o8', model: 'o8-free', content: 'Fixture answer', timestamp: 1,
    receipt: { leadModel: 'o8-free', effort: 'low', effortSource: 'service-tier', mode: 'solo' },
  }] });
  const options = resolveMobileTurnSelection({ surface: 'mobile' }, repo, threadId, 'o8');
  expect(options).not.toHaveProperty('thinkingEffort');
  const events: OrchestratorEvent[] = [];
  await textOnly().sendTurn(repo, 'Continue', event => events.push(event), options);
  expect(events.some(event => event.type === 'error')).toBe(false);
  expect(requests).toHaveLength(1);
  expect(resolveChatTurnOrigin({ threadId, turnId: 'tier-origin', repoPath: repo }))
    .toMatchObject({ kind: 'bound', origin: { effort: 'adaptive' } });
});

it('keeps protocol session reservation lazy until the turn effort has been validated', async () => {
  const backend = acp(), threadId = 'reserved-refused-pin';
  const info = backend.ensureSession(repo, undefined, threadId);
  expect(backend.ensureSession(repo, undefined, threadId)).toEqual(info);
  const events: OrchestratorEvent[] = [];
  await backend.sendTurn(repo, 'Fixture task', event => events.push(event), { thinkingEffort: 'high', threadId });
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'effort_unsupported_runtime' }));
  expect(processStarts).toHaveLength(0);
  const accepted: OrchestratorEvent[] = [];
  await backend.sendTurn(repo, 'Fixture task', event => accepted.push(event), { threadId });
  expect(processStarts).toHaveLength(1);
  expect(accepted.some(event => event.type === 'text')).toBe(true);
});
it('continues a legacy stored default without turning its tier into an independent pin', async () => {
  const { writePersistedLlmChat } = await import('@/lib/llm/chat-history-store');
  const { resolveMobileTurnSelection } = await import('@/lib/ws-server/mobile-turn-selection');
  const { resolveChatTurnOrigin } = await import('@/lib/orchestrator/review-continuation-origin');
  const threadId = 'thoughts-legacy-default';
  writePersistedLlmChat(threadId, { repoPath: repo, messages: [{ id: 'legacy-origin', role: 'assistant',
    backend: 'o8', model: 'o8-free', content: 'Fixture answer', timestamp: 1,
    receipt: { leadModel: 'o8-free', effort: 'low', mode: 'solo' },
  }] });
  const options = resolveMobileTurnSelection({ surface: 'mobile' }, repo, threadId, 'o8');
  expect(options).not.toHaveProperty('thinkingEffort');
  const events: OrchestratorEvent[] = [];
  await textOnly().sendTurn(repo, 'Continue', event => events.push(event), options);
  expect(events.some(event => event.type === 'error')).toBe(false);
  expect(requests).toHaveLength(1);
  expect(resolveChatTurnOrigin({ threadId, turnId: 'legacy-origin', repoPath: repo }))
    .toMatchObject({ kind: 'bound', origin: { effort: 'adaptive' } });
});
it('records a managed service tier in its own field while reasoning remains at runtime default', async () => {
  const events: OrchestratorEvent[] = [];
  await textOnly().sendTurn(repo, 'Fixture task', event => events.push(event), { threadId: 'separate-tier' });
  expect(requests[0].thinkingEffort).toBe('low');
  expect(events).toContainEqual(expect.objectContaining({ type: 'turn_receipt', effort: 'adaptive',
    effortSource: 'runtime-default', serviceTier: 'low' }));
});
