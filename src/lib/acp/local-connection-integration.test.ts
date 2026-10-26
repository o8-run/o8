import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', text: JSON.stringify({ label: 'default', key: 'fixture-new' }) }]);
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
