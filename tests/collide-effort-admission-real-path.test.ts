import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { MoaParticipant } from '@/lib/lane/orchestrator-backends/moa';

vi.mock('node:os', async original => {
  const os = await original<typeof import('node:os')>();
  const homedir = () => process.env.O8_COLLIDE_EFFORT_TEST_HOME!;
  return { ...os, default: { ...os, homedir }, homedir };
});
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: async () => {} }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: async () => {} }));
vi.mock('@/lib/mcp/tool-spine/build', () => ({ buildToolRegistry: () => ({ entries: [] }) }));
vi.mock('@/lib/lane/single-orchestrator-policy', () => ({ prepareSingleOrchestratorLaunch: async (input: Record<string, unknown>) => ({ ...input, diagnostics: [], cleanup: () => {} }) }));

const root = mkdtempSync(join(getDataDir(), 'collide-effort-'));
const home = join(root, 'profile');
const repo = join(root, 'repo');
const capture = join(root, 'launches.jsonl');
const version = join(root, 'version');
mkdirSync(join(home, '.codex'), { recursive: true });
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/fixture.git'], { cwd: repo });
vi.stubEnv('O8_COLLIDE_EFFORT_TEST_HOME', home);
vi.stubEnv('CODEX_HOME', join(home, '.codex'));
vi.stubEnv('O8_CLAUDE_CODE_BIN', join(root, 'resident.cjs'));
vi.stubEnv('O8_CODEX_BIN', join(root, 'batch.cjs'));
vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', '0');
writeFileSync(join(root, 'resident.cjs'), `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('--version')){console.log('2.1.0');process.exit(0);}
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({kind:'resident',args})+String.fromCharCode(10));
require('node:readline').createInterface({input:process.stdin}).on('line',()=>{
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Fixture response.'}]}}));
 console.log(JSON.stringify({type:'result',session_id:'fixture-'+process.pid,is_error:false}));
});
`, { mode: 0o755 });
writeFileSync(join(root, 'batch.cjs'), `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('--version')){console.log(fs.readFileSync(${JSON.stringify(version)},'utf8'));process.exit(0);}
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({kind:'batch',args})+String.fromCharCode(10));
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-'+process.pid}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Fixture proposal.'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`, { mode: 0o755 });
const { collideBackend } = await import('@/lib/lane/orchestrator-backends/moa');
const { reloadOrchestratorSession } = await import('@/lib/lane/orchestrator-session');
const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const defaults: MoaParticipant[] = [
  { backend: 'claude', model: 'claude-opus-4-8', thinkingEffort: 'max' },
  { backend: 'codex', model: 'gpt-6-astra', thinkingEffort: 'high' },
];
let threadId: string;
function launches(): Array<{ kind: string; args: string[] }> {
  return existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
async function send(thinkingEffort?: ThinkingEffort, single = false) {
  const events: OrchestratorEvent[] = [];
  try {
    await collideBackend.sendTurn(repo, 'Fixture task', event => events.push(event), {
      threadId, thinkingEffort, permissionMode: 'full', ...(single ? { orchestrationMode: 'single' as const } : {}),
    });
  } catch (error) { events.push({ type: 'error', error: error instanceof Error ? error.message : String(error) }); }
  return events;
}
beforeEach(async () => {
  threadId = `thoughts-collide-${randomUUID().slice(0, 8)}`;
  rmSync(capture, { force: true }); rmSync(join(home, '.codex', 'models_cache.json'), { force: true });
  writeFileSync(version, 'codex-cli 0.161.0');
  invalidateCliCache('codex'); invalidateCliCache('claude-code');
  vi.stubEnv('O8_COLLIDE_PROPOSERS', JSON.stringify(defaults));
  vi.stubEnv('O8_COLLIDE_AGGREGATOR', '');
  await updateOperatorDefaults({ codexAppThreads: false, collideAggregator: 'claude' });
});
afterEach(() => {
  for (const id of [threadId, ...[0, 1].map(index => `${threadId}::collide-propose::${index}-claude`)]) reloadOrchestratorSession(repo, id);
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it.each([0, 1])('refuses an incompatible proposer pin at position %s before any participant starts', async position => {
  const participants = [...defaults];
  participants.splice(position, 1, { backend: 'claude', model: 'claude-opus-4-8', thinkingEffort: 'ultra' });
  vi.stubEnv('O8_COLLIDE_PROPOSERS', JSON.stringify(participants));
  const events = await send();
  expect(launches()).toEqual([]);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringMatching(/cannot honor effort.*ultra/i) }));
  expect(events.some(event => event.type === 'collide_phase' || event.type === 'turn_receipt')).toBe(false);
});

it('refuses an incompatible aggregator pin before proposer work', async () => {
  const events = await send('ultra');
  expect(launches()).toEqual([]);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringMatching(/cannot honor effort.*ultra/i) }));
});

it.each((['claude', 'codex'] as const).flatMap(backend => ([undefined, 'adaptive'] as const).map(effort => [backend, effort] as const)))('leaves %s aggregator effort %s at the runtime default in normal and Solo turns', async (backend, effort) => {
  await updateOperatorDefaults({ collideAggregator: backend });
  for (const single of [false, true]) {
    const events = await send(effort, single);
    const call = launches().filter(value => value.kind === (backend === 'claude' ? 'resident' : 'batch')).at(-1)!;
    expect(call.args).not.toContain('--effort');
    expect(call.args.some(arg => arg.startsWith('model_reasoning_effort='))).toBe(false);
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn_receipt', effort: 'adaptive', effortSource: 'runtime-default' }));
  }
});

it('refuses an installed CLI that cannot deliver a proposer pin before any participant starts', async () => {
  writeFileSync(version, 'codex-cli 0.136.0');
  vi.stubEnv('O8_COLLIDE_PROPOSERS', JSON.stringify([defaults[0], { ...defaults[1], thinkingEffort: 'ultra' }]));
  const events = await send();
  expect(launches()).toEqual([]);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringMatching(/cannot honor effort.*ultra/i) }));
});

it('refuses a persisted model substitution before any participant starts', async () => {
  writeFileSync(join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }] }));
  const events = await send();
  expect(launches()).toEqual([]);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringMatching(/cannot honor effort.*high/i) }));
});

it.each((['claude', 'codex'] as const).flatMap(backend => (['high', 'max'] as const).map(effort => [backend, effort] as const)))('delivers a supported explicit %s aggregator pin %s and both proposer pins exactly', async (backend, effort) => {
  await updateOperatorDefaults({ collideAggregator: backend });
  const events = await send(effort);
  const residents = launches().filter(value => value.kind === 'resident');
  const batches = launches().filter(value => value.kind === 'batch');
  expect(launches()).toHaveLength(3);
  expect(residents[0].args[residents[0].args.indexOf('--effort') + 1]).toBe('max');
  expect(batches[0].args).toContain('model_reasoning_effort=high');
  const args = backend === 'claude' ? residents.at(-1)!.args : batches.at(-1)!.args;
  if (backend === 'claude') expect(args[args.indexOf('--effort') + 1]).toBe(effort);
  else expect(args).toContain(`model_reasoning_effort=${effort}`);
  expect(events).toContainEqual(expect.objectContaining({ type: 'turn_receipt', effort }));
});

it('skips unused proposer pins for a Solo turn', async () => {
  vi.stubEnv('O8_COLLIDE_PROPOSERS', JSON.stringify([{ ...defaults[0], thinkingEffort: 'ultra' }]));
  const events = await send('adaptive', true);
  expect(events.filter(event => event.type === 'error')).toEqual([]);
  expect(launches()).toHaveLength(1);
});

it('refuses a configured aggregator pin before proposer work', async () => {
  vi.stubEnv('O8_COLLIDE_AGGREGATOR', JSON.stringify({ ...defaults[0], thinkingEffort: 'ultra' }));
  const events = await send();
  expect(launches()).toEqual([]);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringMatching(/cannot honor effort.*ultra/i) }));
});

it('delivers an explicitly configured aggregator effort when the turn omits effort', async () => {
  vi.stubEnv('O8_COLLIDE_AGGREGATOR', JSON.stringify(defaults[0]));
  const events = await send();
  const args = launches().filter(value => value.kind === 'resident').at(-1)!.args;
  expect(args[args.indexOf('--effort') + 1]).toBe('max');
  expect(events).toContainEqual(expect.objectContaining({ type: 'turn_receipt', effort: 'max' }));
});

it('resets an explicitly configured aggregator effort with adaptive', async () => {
  vi.stubEnv('O8_COLLIDE_AGGREGATOR', JSON.stringify(defaults[0]));
  const events = await send('adaptive');
  expect(launches().filter(value => value.kind === 'resident').at(-1)!.args).not.toContain('--effort');
  expect(events).toContainEqual(expect.objectContaining({ type: 'turn_receipt', effort: 'adaptive', effortSource: 'runtime-default' }));
});
