import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

// Keep both launchers, the finite process and persisted session state real.
vi.mock('node:os', async original => {
  const os = await original<typeof import('node:os')>();
  const homedir = () => process.env.O8_TEST_DISCOVERY_HOME!;
  return { ...os, default: { ...os, homedir }, homedir };
});
vi.mock('@/lib/cortex/qa/llm/haiku-adapter', () => ({ prewarmHaiku: async () => {} }));
vi.mock('@/lib/cortex/qa/llm/sonnet-adapter', () => ({ prewarmSonnetCli: async () => {} }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: async () => ({ ready: true }) }));
vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
const root = mkdtempSync(join(getDataDir(), 'effort-discovery-'));
const home = join(root, 'home');
const configHome = join(home, '.codex');
const ownedRoot = join(root, 'owned');
const binary = join(root, 'codex');
mkdirSync(configHome, { recursive: true });
vi.stubEnv('O8_TEST_DISCOVERY_HOME', home);
vi.stubEnv('CODEX_HOME', configHome);
vi.stubEnv('O8_CODEX_BIN', binary);
vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', ownedRoot);
vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '0');
vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', '0');
vi.stubEnv('O8_WORKER_SANDBOX', 'off');
writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.159.2'); process.exit(0); }
fs.appendFileSync(require('node:path').join(process.cwd(), 'calls.jsonl'), JSON.stringify({ args: process.argv.slice(2), configHome: process.env.CODEX_HOME }) + '\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'discovery-fixture' }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
setTimeout(() => {}, 100);
`);
chmodSync(binary, 0o700);
const { codexBackend } = await import('@/lib/lane/orchestrator-backends/codex');
const { codexOwnedAdapter, launchOwnedCodexSession } = await import('@/lib/codex/owned');
const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session');
const { registerRuntimeIdentity, selectRuntimeIdentity } = await import('@/lib/runtime/identity-catalog');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
function cache(config: string, model: string, efforts: string[]) {
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, 'models_cache.json'), JSON.stringify({ models: [{
    slug: model, supported_reasoning_levels: efforts.map(effort => ({ effort })),
  }] }));
}
function repo(name: string) {
  const cwd = join(root, name);
  execFileSync('git', ['init', '-q', cwd]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/fixture.git'], { cwd });
  return cwd;
}
function saved(surfaceId: string): OwnedSessionRecord {
  return JSON.parse(readFileSync(join(ownedRoot, surfaceId.slice('codex-owned:'.length), 'session.json'), 'utf8'));
}
function calls(cwd: string): Array<{ args: string[]; configHome: string }> {
  const file = join(cwd, 'calls.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}
function records() { return existsSync(ownedRoot) ? readdirSync(ownedRoot) : []; }
async function finished(surfaceId: string) {
  await vi.waitFor(() => {
    const session = saved(surfaceId);
    expect(session.activeRun).toBeUndefined();
    expect(session.recentRuns[0].outcome).toBe('finished');
  }, { timeout: 10_000 });
}
beforeEach(async () => {
  rmSync(join(getDataDir(), 'runtime-identities.json'), { force: true });
  cache(configHome, 'gpt-6.1-sol', ['none', 'minimal']);
  await updateOperatorDefaults({ codexAppThreads: false });
});
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it.each(['gpt-6.1-sol', 'gpt-5.6-sol'].flatMap(model =>
  (['none', 'minimal'] as const).map(effort => ({ model, effort })),
))('preserves advertised $model/$effort in both seats and their receipts', async ({ model, effort }) => {
  cache(configHome, model, [effort]);
  const cwd = repo(`advertised-${model}-${effort}`);
  const events: OrchestratorEvent[] = [];
  await codexBackend.sendTurn(cwd, 'fixture', event => events.push(event), { model, thinkingEffort: effort });
  const launched = await launchOwnedCodexSession({ cwd, prompt: 'fixture', model, effort });
  await finished(launched.surfaceId);
  expect(calls(cwd)).toHaveLength(2);
  expect(calls(cwd).every(call => call.args.includes(`model_reasoning_effort=${effort}`))).toBe(true);
  expect(saved(launched.surfaceId).effort).toBe(effort);
  expect(events).toContainEqual(expect.objectContaining({ type: 'turn_receipt', leadModel: model, effort }));
});

it.each(['missing', 'malformed', 'other-model', 'unadvertised'].flatMap(evidence =>
  (['none', 'minimal'] as const).map(effort => ({ evidence, effort })),
))('refuses $effort with $evidence evidence before either seat starts work', async ({ evidence, effort }) => {
  const file = join(configHome, 'models_cache.json');
  if (evidence === 'missing') rmSync(file);
  else if (evidence === 'malformed') writeFileSync(file, '{');
  else cache(configHome, evidence === 'other-model' ? 'gpt-5.6-sol' : 'gpt-6.1-sol', ['low']);
  const cwd = repo(`refused-${evidence}-${effort}`);
  const before = records();
  const events: OrchestratorEvent[] = [];
  await codexBackend.sendTurn(cwd, 'fixture', event => events.push(event), { model: 'gpt-6.1-sol', thinkingEffort: effort });
  expect(events.some(event => event.type === 'turn_receipt')).toBe(false);
  expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringMatching(/does not advertise.*effort|no.*discovery evidence/i) }));
  await expect(launchOwnedCodexSession({ cwd, prompt: 'fixture', model: 'gpt-6.1-sol', effort }))
    .rejects.toMatchObject({ name: 'EffortPinRejectionError' });
  expect(calls(cwd)).toEqual([]);
  expect(records()).toEqual(before);
});

it.each((['none', 'minimal'] as const).flatMap(effort =>
  [false, true].map(advertised => ({ effort, advertised })),
))('uses the owned identity cache for $effort (advertised=$advertised), including cold resume', async ({ effort, advertised }) => {
  const identityHome = join(root, `identity-${effort}-${advertised}`);
  cache(identityHome, 'gpt-6.1-sol', advertised ? [effort] : ['low']);
  cache(configHome, 'gpt-6.1-sol', advertised ? ['low'] : [effort]);
  const identity = await registerRuntimeIdentity({ runtime: 'codex', label: 'Fixture', configHomeRef: identityHome });
  await selectRuntimeIdentity('codex', identity.id);
  const cwd = repo(`identity-${effort}-${advertised}-repo`);
  const before = records();
  const launch = createOwnedSessionStore(codexOwnedAdapter).launch({ cwd, prompt: 'fixture', model: 'gpt-6.1-sol', effort });
  if (!advertised) {
    // Drain an unexpected finite launch in the red run before inspecting artifacts.
    const unexpected = await launch.catch(() => null);
    if (unexpected) await finished(unexpected.surfaceId);
    await expect(launch).rejects.toMatchObject({ name: 'EffortPinRejectionError' });
    expect(calls(cwd)).toEqual([]);
    expect(records()).toEqual(before);
    return;
  }
  const launched = await launch;
  await finished(launched.surfaceId);
  expect(saved(launched.surfaceId).identity?.configHomeRef).toBe(identityHome);
  expect(calls(cwd)).toMatchObject([{ configHome: identityHome }]);
  expect((await createOwnedSessionStore(codexOwnedAdapter).resume(launched.surfaceId, 'continue')).ok).toBe(true);
  await finished(launched.surfaceId);
  expect(calls(cwd)).toHaveLength(2);
  expect(calls(cwd).every(call => call.configHome === identityHome && call.args.includes(`model_reasoning_effort=${effort}`))).toBe(true);
  const snapshot = readFileSync(join(saved(launched.surfaceId).sessionDir, 'session.json'), 'utf8');
  cache(identityHome, 'gpt-6.1-sol', ['low']);
  cache(configHome, 'gpt-6.1-sol', [effort]);
  await expect(createOwnedSessionStore(codexOwnedAdapter).resume(launched.surfaceId, 'refuse'))
    .rejects.toMatchObject({ name: 'EffortPinRejectionError' });
  expect(readFileSync(join(saved(launched.surfaceId).sessionDir, 'session.json'), 'utf8')).toBe(snapshot);
  expect(calls(cwd)).toHaveLength(2);
});
