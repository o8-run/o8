import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';

vi.mock('node:os', async original => {
  const os = await original<typeof import('node:os')>();
  const homedir = () => process.env.O8_TEST_LEAD_PIN_HOME!;
  return { ...os, default: { ...os, homedir }, homedir };
});
// Replace the provider-facing bridge executable; keep lead entry and serialized spec real.
vi.mock('@/lib/codex/app-bridge-launch', () => ({ codexAppBridgeLaunch: () => ({
  command: process.execPath, args: [process.env.O8_TEST_LEAD_PIN_BRIDGE!],
}) }));
const root = mkdtempSync(join(getDataDir(), 'lead-pins-'));
const home = join(root, 'profile');
const repo = join(root, 'repo');
const record = join(root, 'request.json');
const version = join(root, 'version.txt');
const binary = join(root, 'codex');
const resident = join(root, 'claude');
const bridge = join(root, 'bridge.cjs');
mkdirSync(join(home, '.codex'), { recursive: true });
execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/fixture.git'], { cwd: repo });
vi.stubEnv('O8_TEST_LEAD_PIN_HOME', home);
vi.stubEnv('O8_TEST_LEAD_PIN_BRIDGE', bridge);
vi.stubEnv('CODEX_HOME', join(home, '.codex'));
vi.stubEnv('O8_CODEX_BIN', binary);
vi.stubEnv('O8_CLAUDE_CODE_BIN', resident);
vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', '0');
const completion = `console.log(JSON.stringify({type:'thread.started',thread_id:'pin-fixture'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));`;
writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')) console.log(fs.readFileSync(${JSON.stringify(version)},'utf8'));
else { fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2)})); ${completion} }
`, { mode: 0o755 });
writeFileSync(resident, `#!${process.execPath}
if(process.argv.includes('--version')) { console.log('2.1.0'); process.exit(0); }
require('node:readline').createInterface({input:process.stdin}).on('line',()=>{
require('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2)}));
console.log(JSON.stringify({type:'result',session_id:'pin-resident',is_error:false})); });
`, { mode: 0o755 });
writeFileSync(bridge, `const fs=require('node:fs');
const spec=JSON.parse(fs.readFileSync(process.argv.at(-1),'utf8'));
fs.writeFileSync(${JSON.stringify(record)},JSON.stringify(spec)); ${completion}
`);
const codex = await import('@/lib/lane/codex-orchestrator-session');
const claude = await import('@/lib/lane/orchestrator-session');
const { invalidateCliCache } = await import('@/lib/runtimes/shared/cli-resolver');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { validateLeadRouting } = await import('@/lib/orchestrator/lead-contract');
beforeEach(async () => {
  rmSync(record, { force: true }); rmSync(join(home, '.codex', 'models_cache.json'), { force: true }); writeFileSync(version, 'codex-cli 0.161.0');
  invalidateCliCache('codex'); invalidateCliCache('claude-code');
  await updateOperatorDefaults({ codexAppThreads: false });
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function send(runtime: 'codex' | 'claude', model: string, effort?: ThinkingEffort, resume = false) {
  const events: OrchestratorEvent[] = [];
  const thread = randomUUID();
  if (runtime === 'codex') {
    const session = codex.ensureCodexOrchestratorSession(repo, thread);
    session.threadId = resume ? 'saved-pin-thread' : null;
    await codex.sendToCodexOrchestrator(session, 'fixture prompt', event => events.push(event), { model, thinkingEffort: effort });
    expect(session.status).not.toBe('busy');
  } else {
    const session = claude.ensureOrchestratorSession(repo, thread);
    try { await claude.sendToOrchestrator(session, 'fixture prompt', event => events.push(event), { model, thinkingEffort: effort }); }
    catch (error) { events.push({ type: 'error', error: error instanceof Error ? error.message : String(error) }); }
    finally { claude.reloadOrchestratorSession(repo, thread); }
  }
  return events;
}

it.each(['max', 'ultra'] as const)('refuses model-incompatible explicit %s before lead dispatch', async effort => {
  const events = await send('codex', 'gpt-5.5', effort);
  expect(existsSync(record)).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining(effort) }));
  expect(events.some(event => event.type === 'turn_receipt')).toBe(false);
});
it.each(['codex-cli 0.136.0', 'unknown'])('refuses an explicit high-end pin with installed version %s', async installed => {
  writeFileSync(version, installed);
  const events = await send('codex', 'gpt-6-astra', 'ultra');
  expect(existsSync(record)).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('ultra') }));
});
it.each([false, true])('preserves a supported explicit pin and receipt (resume=%s)', async resume => {
  const events = await send('codex', 'gpt-6-astra', 'ultra', resume);
  const request = JSON.parse(readFileSync(record, 'utf8'));
  expect(request.args).toContain('model_reasoning_effort=ultra');
  expect(request.args.includes('resume')).toBe(resume);
  expect(events).toContainEqual({ type: 'turn_receipt', leadModel: 'gpt-6-astra', effort: 'ultra' });
});
it('carries the exact pin in the app bridge spec and receipt', async () => {
  await updateOperatorDefaults({ codexAppThreads: true });
  const events = await send('codex', 'gpt-6-astra', 'max');
  expect(JSON.parse(readFileSync(record, 'utf8'))).toMatchObject({ model: 'gpt-6-astra', effort: 'max' });
  expect(events).toContainEqual({ type: 'turn_receipt', leadModel: 'gpt-6-astra', effort: 'max' });
});
it.each([
  [false, false, undefined], [false, false, 'adaptive'], [false, true, undefined], [false, true, 'adaptive'],
  [true, false, undefined], [true, false, 'adaptive'], [true, true, undefined], [true, true, 'adaptive'],
] as const)('keeps the runtime default (app=%s, resume=%s, effort=%s)', async (app, resume, effort) => {
  await updateOperatorDefaults({ codexAppThreads: app });
  const events = await send('codex', 'gpt-5.5', effort, resume);
  const request = JSON.parse(readFileSync(record, 'utf8'));
  if (app) {
    expect(request).not.toHaveProperty('effort');
    expect(request.threadId).toBe(resume ? 'saved-pin-thread' : null);
  } else {
    expect(request.args.some((arg: string) => arg.startsWith('model_reasoning_effort='))).toBe(false);
    expect(request.args.includes('resume')).toBe(resume);
  }
  expect(events).toContainEqual({ type: 'turn_receipt', leadModel: 'gpt-5.5', effort: 'adaptive', effortSource: 'runtime-default' });
});
it('refuses a resident lead pin that would map ultra to max', async () => {
  const events = await send('claude', 'claude-opus-4-8', 'ultra');
  expect(existsSync(record)).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('ultra') }));
});
it.each([undefined, 'adaptive', 'max'] as const)('resident lead default or supported pin agrees with receipt (%s)', async effort => {
  const events = await send('claude', 'claude-opus-4-8', effort);
  const args = JSON.parse(readFileSync(record, 'utf8')).args;
  if (!effort || effort === 'adaptive') expect(args).not.toContain('--effort');
  else expect(args[args.indexOf('--effort') + 1]).toBe(effort);
  expect(events).toContainEqual({ type: 'turn_receipt', leadModel: 'claude-opus-4-8', effort: effort ?? 'adaptive',
    ...(!effort || effort === 'adaptive' ? { effortSource: 'runtime-default' } : {}) });
});

it.each([undefined, 'adaptive'] as const)('records runtime-default provenance for a resident lead selection of %s', async effort => {
  const events = await send('claude', 'claude-opus-4-8', effort);
  expect(JSON.parse(readFileSync(record, 'utf8')).args).not.toContain('--effort');
  expect(events).toContainEqual({ type: 'turn_receipt', leadModel: 'claude-opus-4-8', effort: 'adaptive', effortSource: 'runtime-default' });
});


it('keeps a saved worker default separate from omitted lead effort', async () => {
  await updateOperatorDefaults({ codexWorkerEffort: 'max' });
  const events = await send('codex', 'gpt-5.5');
  expect(JSON.parse(readFileSync(record, 'utf8')).args.some((arg: string) => arg.startsWith('model_reasoning_effort='))).toBe(false);
  expect(events).toContainEqual({ type: 'turn_receipt', leadModel: 'gpt-5.5', effort: 'adaptive', effortSource: 'runtime-default' });
});
it('rejects an incompatible installed version before app bridge dispatch', async () => {
  await updateOperatorDefaults({ codexAppThreads: true }); writeFileSync(version, 'codex-cli 0.136.0');
  const events = await send('codex', 'gpt-6-astra', 'max');
  expect(existsSync(record)).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('max') }));
});


it('refuses an explicit pin when the saved model catalog would replace the requested model', async () => {
  writeFileSync(join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }] }));
  const events = await send('codex', 'gpt-6-astra', 'max');
  expect(existsSync(record)).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('gpt-5.6-sol') }));
});
it.each(['gpt-4o', 'ollama:fixture'])('refuses concrete effort on a model without a verified effort transport (%s)', async model => {
  const events = await send('codex', model, 'high');
  expect(existsSync(record)).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining('high') }));
});


it.each(['none', 'minimal'] as const)('refuses unmapped %s on a resident lead before provider work', async effort => {
  const events = await send('claude', 'claude-opus-4-8', effort);
  expect(existsSync(record)).toBe(false);
  expect(events.some(event => event.type === 'turn_receipt')).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringContaining(effort) }));
});

it.each(['none', 'minimal'].flatMap(effort => [false, true].flatMap(app =>
  [false, true].map(advertised => ({ effort: effort as ThinkingEffort, app, advertised })),
)))('uses only the lead account cache for $effort (app=$app, advertised=$advertised)', async ({ effort, app, advertised }) => {
  const unrelatedHome = join(root, 'unrelated');
  mkdirSync(unrelatedHome, { recursive: true });
  const cache = (efforts: string[]) => JSON.stringify({ models: [{
    slug: 'gpt-6.1-sol', supported_reasoning_levels: efforts.map(effort => ({ effort })),
  }] });
  writeFileSync(join(home, '.codex', 'models_cache.json'), cache(advertised ? [effort] : ['low']));
  writeFileSync(join(unrelatedHome, 'models_cache.json'), cache(advertised ? ['low'] : [effort]));
  vi.stubEnv('CODEX_HOME', unrelatedHome);
  try {
    await updateOperatorDefaults({ codexAppThreads: app });
    const routing = () => validateLeadRouting({ backend: 'codex', model: 'gpt-6.1-sol', effort });
    if (advertised) expect(routing().effort).toBe(effort);
    else expect(routing).toThrow(/does not advertise.*effort/i);
    const events = await send('codex', 'gpt-6.1-sol', effort);
    if (advertised) {
      const request = JSON.parse(readFileSync(record, 'utf8'));
      if (app) expect(request.effort).toBe(effort);
      else expect(request.args).toContain(`model_reasoning_effort=${effort}`);
      expect(events).toContainEqual({ type: 'turn_receipt', leadModel: 'gpt-6.1-sol', effort });
    } else {
      expect(existsSync(record)).toBe(false);
      expect(events.some(event => event.type === 'turn_receipt')).toBe(false);
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringMatching(/does not advertise.*effort/i) }));
    }
  } finally { vi.stubEnv('CODEX_HOME', join(home, '.codex')); }
});
