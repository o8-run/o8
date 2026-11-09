import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => state.dir }));
vi.mock('@/lib/data-dir-migration', () => ({ getDataDir: () => state.dir }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: async () => {} }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => { throw new Error('Fixture has no tools'); } }));
import { localAcpProcessLaunch, saveLocalAcpConnection } from './local-connection';
import { probeAcpModels } from '@/lib/orchestrator/acp-model-probe';
import { acpBackend, makeAcpBackend } from '@/lib/lane/orchestrator-backends/acp';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { normalizeOrchestratorTurnModel } from '@/lib/orchestrator/turn-model-selection';
import { prepareOrchestratorTurn } from '@/components/desktop/thoughts/use-orchestrator-stream/turn-option-resolution';
import { buildOrchestratorSendPayload } from '@/components/desktop/thoughts/use-orchestrator-stream/send-payload';

state.dir = mkdtempSync(join(tmpdir(), 'o8-local-acp-wire-'));
const peer = join(state.dir, 'agent.cjs');
// A real child process, with no provider, network, tools or real credentials.
writeFileSync(peer, String.raw`
const readline = require('node:readline');
const label = process.argv[2];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  let result = {};
  if (r.method === 'initialize') result = {protocolVersion:1};
  if (r.method === 'session/new') result = {sessionId:'fixture', configOptions: label === 'default' ? [] : [{id:'model', type:'select', currentValue:label, options:[{value:label}]}]};
  if (r.method === 'session/prompt') {
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({label,key:process.env.OPENROUTER_API_KEY || null})}}}});
    result = {stopReason:'end_turn'};
    setTimeout(() => process.exit(0), 20);
  }
  if (r.id != null) send({jsonrpc:'2.0',id:r.id,result});
});
// Bound even a failed assertion's child lifetime.
setTimeout(() => process.exit(0), 3000).unref();
`);
function connect(label: string, useOpenRouter = false) {
  saveLocalAcpConnection({ name: label, command: process.execPath, args: [peer, label], useOpenRouter });
}
const residentPeer = join(state.dir, 'resident.cjs');
writeFileSync(residentPeer, String.raw`
const readline = require('node:readline');
const behavior = process.argv[2];
const sessionId = String(process.pid);
let model = 'fixture-start';
const turns = [], modelWrites = [];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  let result = {};
  if (r.method === 'initialize') result = {protocolVersion:1};
  if (r.method === 'session/new') result = {sessionId, configOptions: behavior === 'no-default' ? [] : [{id:'model', type:'select', currentValue:model, options:[{value:'fixture-start'},{value:'fixture-pinned'}]}]};
  if (r.method === 'session/set_config_option') {
    if (behavior === 'reject-reset' && r.params.value === 'fixture-start') {
      send({jsonrpc:'2.0',id:r.id,error:{code:-32602,message:'Fixture cannot restore startup model'}});
      return;
    }
    model = r.params.value;
    modelWrites.push(model);
  }
  if (r.method === 'session/prompt') {
    turns.push(model);
    send({jsonrpc:'2.0',method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({sessionId,model,turns,modelWrites})}}}});
    result = {stopReason:'end_turn'};
  }
  if (r.id != null) send({jsonrpc:'2.0',id:r.id,result});
});
setTimeout(() => process.exit(0), 3000).unref();
`);
function connectResident(behavior: string) {
  saveLocalAcpConnection({ name: behavior, command: process.execPath, args: [residentPeer, behavior], useOpenRouter: false });
}
async function residentTurn(threadId: string, model: string) {
  const events: OrchestratorEvent[] = [];
  const turn = prepareOrchestratorTurn('fixture', { backend: 'acp', model });
  const wire = JSON.parse(buildOrchestratorSendPayload({ ...turn, repoPath: state.dir, threadId, clientMessageId: 'fixture' })) as { message: string; model: unknown };
  await acpBackend.sendTurn(state.dir, wire.message, event => events.push(event), { threadId, model: normalizeOrchestratorTurnModel(wire.model) });
  const text = events.find(event => event.type === 'text');
  const output = text?.type === 'text' ? JSON.parse(text.text) as { sessionId: string; model: string; turns: string[]; modelWrites: string[] } : null;
  return { events, output };
}
beforeEach(() => {
  vi.stubEnv('HOME', state.dir); vi.stubEnv('O8_ACP_COMMAND', ''); vi.stubEnv('OPENROUTER_API_KEY', 'fixture-old'); });
afterAll(() => { vi.unstubAllEnvs(); rmSync(state.dir, { recursive: true, force: true }); });

it('replaces cached models when the configured agent changes, including optional enumeration', async () => {
  connect('first');
  const first = localAcpProcessLaunch()!;
  expect((await probeAcpModels('acp', first, state.dir)).models[0].value).toBe('first');
  connect('second');
  // A prepared probe for another connection must not launch after replacement.
  await expect(probeAcpModels('acp', first, state.dir, { force: true })).rejects.toThrow(/environment changed/i);
  expect((await probeAcpModels('acp', localAcpProcessLaunch()!, state.dir)).models[0].value).toBe('second');
  connect('default');
  expect((await probeAcpModels('acp', localAcpProcessLaunch()!, state.dir)).models).toEqual([]);
});

it('refreshes an unused child after the connection changes and excludes unchecked credentials', async () => {
  connect('first');
  acpBackend.ensureSession(state.dir, 'default', 'connection-change');
  connect('second');
  const events: OrchestratorEvent[] = [];
  await acpBackend.sendTurn(state.dir, 'fixture', event => events.push(event), { threadId: 'connection-change' });
  expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', text: JSON.stringify({ label: 'second', key: null }) }]);
  expect(events.some(event => event.type === 'done')).toBe(true);
});

it('uses the latest opted-in key for a concrete runtime when hydration happened after ensureSession but before sendTurn', async () => {
  const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing'); saveRuntimeBillingMode('opencode', 'api');
  const keyedBackend = makeAcpBackend({ id: 'opencode', label: 'Concrete ACP fixture', resolveLaunch: () => localAcpProcessLaunch() });
  connect('default', true);
  keyedBackend.ensureSession(state.dir, 'default', 'key-change');
  vi.stubEnv('OPENROUTER_API_KEY', 'fixture-new');
  const events: OrchestratorEvent[] = [];
  await keyedBackend.sendTurn(state.dir, 'fixture', event => events.push(event), { threadId: 'key-change' });
  // Hydration still reaches the child (the latest key, fixture-new), but the echo comes back
  // redacted: the output redactor is built from the value childEnvironment injected for this
  // launch, so the current key masks to [redacted] while a stale fixture-old would show through raw.
  const texts = events.filter(event => event.type === 'text');
  expect(texts).toEqual([{ type: 'text', text: JSON.stringify({ label: 'default', key: '[redacted]' }) }]);
  expect(JSON.stringify(texts)).not.toContain('fixture-new');
  expect(JSON.stringify(texts)).not.toContain('fixture-old');
  expect(events.some(event => event.type === 'done')).toBe(true);
});

it('restores the startup model in the same established ACP session after an explicit pin', async () => {
  connectResident('reset-supported');
  const first = await residentTurn('model-reset', 'fixture-pinned');
  const repeated = await residentTurn('model-reset', 'fixture-pinned');
  expect(repeated.output?.modelWrites).toEqual(['fixture-pinned']);
  const reset = await residentTurn('model-reset', '');
  expect(reset.output).toEqual({ sessionId: first.output?.sessionId, model: 'fixture-start', turns: ['fixture-pinned', 'fixture-pinned', 'fixture-start'], modelWrites: ['fixture-pinned', 'fixture-start'] });
  expect(reset.events).toContainEqual({ type: 'handoff', from: { backend: 'acp', model: 'fixture-pinned' }, to: { backend: 'acp', model: 'fixture-start' }, lossless: true });
  expect(reset.events.some(event => event.type === 'done')).toBe(true);
});

it.each(['no-default', 'reject-reset'])('preserves the established session and skips the prompt when default reset is unsupported (%s)', async behavior => {
  connectResident(behavior);
  const threadId = `model-reset-${behavior}`;
  const first = await residentTurn(threadId, 'fixture-pinned');
  const reset = await residentTurn(threadId, '');
  expect(reset.output).toBeNull();
  expect(reset.events).toContainEqual({ type: 'error', error: 'ACP could not restore its agent default. Choose a model or start a new conversation. This conversation was preserved.' });
  expect(acpBackend.peekSession(state.dir, 'default', threadId)?.status).toBe('ready');
  const continued = await residentTurn(threadId, 'fixture-pinned');
  expect(continued.output).toEqual({ sessionId: first.output?.sessionId, model: 'fixture-pinned', turns: ['fixture-pinned', 'fixture-pinned'], modelWrites: ['fixture-pinned'] });
});

it('redacts the provider key an opencode agent puts in model names and the probe cache (#5422)', async () => {
  const { saveRuntimeBillingMode } = await import('@/lib/providers/runtime-billing');
  saveRuntimeBillingMode('opencode', 'api');
  // A realistic, long, unique key: any appearance in the probe result or cache is this leak.
  const key = `sk-or-v1-fixture-${'0a1b2c3d4e5f6a7b'.repeat(2)}`;
  vi.stubEnv('OPENROUTER_API_KEY', key);
  const keyLog = join(state.dir, 'keyleak.log');
  const keyPeer = join(state.dir, 'keyleak-agent.cjs');
  // A hostile ACP agent that stuffs the OpenRouter key it was launched with into its model
  // catalogue (value, name and description) — the backend-models leak vector.
  writeFileSync(keyPeer, String.raw`
const readline = require('node:readline');
const { appendFileSync } = require('node:fs');
const key = process.env.OPENROUTER_API_KEY || '';
appendFileSync(${JSON.stringify(keyLog)}, JSON.stringify({ sawKey: key.length > 0 }) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  let result = {};
  if (r.method === 'initialize') result = {protocolVersion:1};
  if (r.method === 'session/new') result = {sessionId:'fixture', configOptions:[{id:'model', type:'select', currentValue:'openrouter/'+key, options:[{value:'openrouter/'+key, name:'Echo '+key, description:key}]}]};
  if (r.id != null) send({jsonrpc:'2.0', id:r.id, result});
});
setTimeout(() => process.exit(0), 3000).unref();
`);
  saveLocalAcpConnection({ name: 'keyleak', command: process.execPath, args: [keyPeer], useOpenRouter: true });
  const probe = await probeAcpModels('opencode', localAcpProcessLaunch()!, state.dir, { force: true });
  // The agent did receive the key, so a clean result is redaction, not a missing secret.
  expect(JSON.parse(readFileSync(keyLog, 'utf8').trim())).toEqual({ sawKey: true });
  // The catalogue still comes through (so the picker renders), but the key is masked everywhere.
  expect(probe.models.length).toBeGreaterThan(0);
  expect(JSON.stringify(probe), 'the OpenRouter key reached the probe result').not.toContain(key);
  // And it never lands in plaintext in the on-disk probe cache.
  expect(readFileSync(join(state.dir, 'acp-models', 'opencode.json'), 'utf8'), 'the key reached the probe cache').not.toContain(key);
});

it('purges a pre-redaction probe cache from disk instead of serving its plaintext (#5422)', async () => {
  const { cachedAcpModels } = await import('@/lib/orchestrator/acp-model-probe');
  const dir = join(state.dir, 'acp-models');
  mkdirSync(dir, { recursive: true });
  const cacheFile = join(dir, 'opencode.json');
  // A cache written before the fix: no redactionVersion, with a key sitting in a model name.
  const key = 'sk-or-v1-fixture-staleplaintext0123456789abcdef01';
  writeFileSync(cacheFile, JSON.stringify({ models: [{ value: 'openrouter/' + key, name: key }], currentModel: null, probedAt: Date.now() }));
  // The read refuses to serve it and deletes the plaintext copy from disk.
  expect(cachedAcpModels('opencode')).toBeNull();
  expect(existsSync(cacheFile), 'the stale plaintext cache survived on disk').toBe(false);
});
