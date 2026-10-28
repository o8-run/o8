import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { getDataDir } from '@/lib/data-dir-migration';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { RuntimeLaunchRequest } from '@/lib/runtime/actions';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

// Keep both launchers, the finite process and persisted session state real.
// The OS wrapper is outside this admission test; the read-only pin stays real.
vi.mock('@/lib/runtimes/shared/owned-session/sandbox', async original => ({
  ...await original<typeof import('@/lib/runtimes/shared/owned-session/sandbox')>(),
  prepareWorkerSandbox: async ({ binary, args }: { binary: string; args: string[] }) => ({ binary, args }),
}));
// Account admission is independent of managed-worktree ownership.
vi.mock('@/lib/workspace/materialization-guard', () => ({
  inspectOwnedWorkspaceMaterialization: async () => ({ status: 'available', source: 'no-snapshot' }),
}));
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
vi.stubEnv('PATH', `${root}${delimiter}${process.env.PATH}`);
vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', ownedRoot);
vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '0');
vi.stubEnv('O8_CRASH_SURVIVABLE_ORCHESTRATOR', '0');
vi.stubEnv('O8_WORKER_SANDBOX', 'off');
writeFileSync(binary, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.159.2'); process.exit(0); }
if (process.argv.includes('app-server')) {
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const { id, method } = JSON.parse(line);
    if (!id) return;
    const switchFile = require('node:path').join(process.env.CODEX_HOME, 'switch-identity.json');
    if (method === 'model/list' && fs.existsSync(switchFile)) {
      const { file, identityId } = JSON.parse(fs.readFileSync(switchFile, 'utf8'));
      const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
      catalog.selectedByRuntime.codex = identityId;
      fs.writeFileSync(file, JSON.stringify(catalog));
    }
    const models = JSON.parse(fs.readFileSync(require('node:path').join(process.env.CODEX_HOME, 'models_cache.json'), 'utf8')).models;
    console.log(JSON.stringify({ id, result: method === 'model/list' ? { data: models.map(model => ({ model: model.slug, supportedReasoningEfforts: [...['low', 'medium', 'high', 'max', 'xhigh', 'ultra'], ...(model.supported_reasoning_levels || []).map(level => level.effort).filter(effort => effort === 'none' || effort === 'minimal')].map(reasoningEffort => ({ reasoningEffort })) })) }
      : method === 'config/read' ? { config: {} } : {} }));
  });
} else {
const outputIndex = process.argv.indexOf('--output-last-message');
if (outputIndex >= 0) {
  fs.writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ args: process.argv.slice(2), configHome: process.env.CODEX_HOME }));
  process.exit(0);
}
fs.appendFileSync(require('node:path').join(process.cwd(), 'calls.jsonl'), JSON.stringify({ args: process.argv.slice(2), configHome: process.env.CODEX_HOME }) + '\\n');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'discovery-fixture' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ configHome: process.env.CODEX_HOME }) } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
setTimeout(() => {}, 100);
}
`);
chmodSync(binary, 0o700);
const { codexBackend } = await import('@/lib/lane/orchestrator-backends/codex');
const { makeMoaBackend } = await import('@/lib/lane/orchestrator-backends/moa');
const { codexOwnedAdapter, launchOwnedCodexSession } = await import('@/lib/codex/owned');
const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session');
const { registerRuntimeIdentity, selectRuntimeIdentity, getOrPinPacketRuntimeIdentity } = await import('@/lib/runtime/identity-catalog');
const { codexRuntime } = await import('@/lib/runtimes/codex');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { assertSingleAttemptLaunch } = await import('@/lib/runtime/single-attempt-launch');
const { resolveEffortPin } = await import('@/lib/orchestrator/effort-pin');
const { workerModelCatalog } = await import('@/lib/orchestrator/worker-catalog');
const { callCodex } = await import('@/lib/cortex/qa/llm/codex-adapter');
const { POST } = await import('@/app/api/runtime/launch/route');
const { POST: cliPOST } = await import('@/app/api/v2/proxy/cli/route');
const { startCodex } = await import('../scripts/worker/run-codex');
const { closeDb } = await import('@/lib/db');
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
    expect(session.recentRuns[0].childExit?.classification).toBe('clean-exit');
  }, { timeout: 10_000 });
}
beforeEach(async () => {
  rmSync(join(getDataDir(), 'runtime-identities.json'), { force: true });
  cache(configHome, 'gpt-6.1-sol', ['none', 'minimal']);
  await updateOperatorDefaults({ codexAppThreads: false });
});
afterAll(() => { closeDb(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

const savedPacketCases = ['launch-route', 'single-attempt', 'runtime-adapter'].flatMap(entry =>
  (['none', 'minimal'] as const).map(effort => ({ entry, effort, conflictingBinding: false })),
);
// The saved session records who executed this packet. A newer catalog binding
// must not move its admission or execution to another account.
savedPacketCases.push({ entry: 'launch-route', effort: 'minimal', conflictingBinding: true });
it.each(savedPacketCases)('saved packet A wins at $entry for $effort (conflictingBinding=$conflictingBinding)', async ({ entry, effort, conflictingBinding }) => {
  const packetId = `saved-${entry}-${effort}-${conflictingBinding}`;
  const aHome = join(root, `${packetId}-A`);
  const bHome = join(root, `${packetId}-B`);
  cache(aHome, 'gpt-6.1-sol', ['none', 'minimal']);
  cache(bHome, 'gpt-6.1-sol', ['low']);
  cache(configHome, 'gpt-6.1-sol', ['low']);
  const a = await registerRuntimeIdentity({ runtime: 'codex', label: 'A', configHomeRef: aHome });
  const b = await registerRuntimeIdentity({ runtime: 'codex', label: 'B', configHomeRef: bHome });
  await selectRuntimeIdentity('codex', a.id);
  const cwd = repo(packetId);
  const request: RuntimeLaunchRequest = { runtime: 'codex', packetId, cwd, prompt: 'retry saved packet',
    model: 'gpt-6.1-sol', effort, executionPolicy: 'single-attempt', workMode: 'read-only',
    clientMutationId: packetId, skipSetup: true, isolate: false };
  const seed = await launchOwnedCodexSession(request as Parameters<typeof launchOwnedCodexSession>[0]);
  expect(seed.ok, seed.note).toBe(true);
  await finished(seed.surfaceId);
  expect(saved(seed.surfaceId).identity).toMatchObject({ id: a.id, configHomeRef: aHome });
  const catalogFile = join(getDataDir(), 'runtime-identities.json');
  const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
  catalog.packetBindings = conflictingBinding ? { [`codex\0${packetId}`]: b } : {};
  writeFileSync(catalogFile, JSON.stringify(catalog));
  await selectRuntimeIdentity('codex', b.id);

  let failure: unknown;
  let status: number | undefined;
  let surfaceId: string | undefined;
  try {
    if (entry === 'launch-route') {
      const response = await POST(new NextRequest('http://localhost/api/runtime/launch', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      }));
      status = response.status;
      const result = await response.json();
      if (result.ok) surfaceId = result.surfaceId;
      else failure = result;
    } else if (entry === 'single-attempt') {
      assertSingleAttemptLaunch(request, 'read-only');
      const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
      const result = await launchRuntimeSurface(request);
      expect(result.ok, result.note).toBe(true);
      surfaceId = result.surfaceId;
    } else {
      const result = await codexRuntime.launch({ ...request, cwd });
      expect(result.ok, result.note).toBe(true);
      surfaceId = result.sessionKey;
    }
    if (surfaceId) {
      await finished(surfaceId);
      expect(saved(surfaceId)).toMatchObject({ identity: { id: a.id, configHomeRef: aHome },
        effort, executionPolicy: { mode: 'single-attempt', effort } });
    }
  } catch (error) { failure = error; }

  // On the old head all six unbound owned controls succeed even though early
  // admission refuses. Run the control after the entry point so it cannot pin A.
  const control = await launchOwnedCodexSession(request as Parameters<typeof launchOwnedCodexSession>[0]);
  expect(control.ok, control.note).toBe(true);
  await finished(control.surfaceId);
  expect(saved(control.surfaceId).identity).toMatchObject({ id: a.id, configHomeRef: aHome });
  expect(calls(cwd)).toHaveLength(surfaceId ? 3 : 2);
  expect(calls(cwd).every(call => call.configHome === aHome
    && call.args.includes(`model_reasoning_effort=${effort}`))).toBe(true);
  if (entry === 'launch-route') expect(status, JSON.stringify(failure)).toBe(200);
  expect(failure).toBeUndefined();
  expect(surfaceId).toBeTruthy();
});

it.each(['none', 'minimal'] as const)('explicit server identity beats saved packet and catalog identities for %s', async effort => {
  const packetId = `explicit-saved-${effort}`;
  const aHome = join(root, `${packetId}-A`);
  const bHome = join(root, `${packetId}-B`);
  cache(aHome, 'gpt-6.1-sol', ['low']);
  cache(bHome, 'gpt-6.1-sol', ['none', 'minimal']);
  const a = await registerRuntimeIdentity({ runtime: 'codex', label: 'A', configHomeRef: aHome });
  const b = await registerRuntimeIdentity({ runtime: 'codex', label: 'B', configHomeRef: bHome });
  await selectRuntimeIdentity('codex', a.id);
  const cwd = repo(packetId);
  const seed = await launchOwnedCodexSession({ packetId, cwd, prompt: 'seed A', model: 'gpt-6.1-sol',
    effort: 'low', executionPolicy: 'single-attempt', workMode: 'read-only' });
  expect(seed.ok, seed.note).toBe(true);
  await finished(seed.surfaceId);
  const result = await codexRuntime.launch({ packetId, cwd, prompt: 'explicit server B', model: 'gpt-6.1-sol',
    effort, runtimeIdentity: b, executionPolicy: 'single-attempt', workMode: 'read-only' });
  expect(result.ok, result.note).toBe(true);
  await finished(result.sessionKey!);
  expect(saved(seed.surfaceId).identity?.id).toBe(a.id);
  expect(saved(result.sessionKey!).identity).toMatchObject({ id: b.id, configHomeRef: bHome });
  expect(calls(cwd)).toEqual([
    { configHome: aHome, args: expect.arrayContaining(['model_reasoning_effort=low']) },
    { configHome: bHome, args: expect.arrayContaining([`model_reasoning_effort=${effort}`]) },
  ]);
});

it.each(['launch-route', 'single-attempt', 'runtime-adapter'].flatMap(entry =>
  (['none', 'minimal'] as const).map(effort => ({ entry, effort })),
))('$entry uses pinned A after selection changes to B for $effort', async ({ entry, effort }) => {
  const packetId = `pinned-${entry}-${effort}`;
  const identityHome = join(root, `${packetId}-A`);
  const selectedHome = join(root, `${packetId}-B`);
  cache(identityHome, 'gpt-6.1-sol', [effort]);
  cache(selectedHome, 'gpt-6.1-sol', ['low']);
  cache(configHome, 'gpt-6.1-sol', ['low']);
  const pinned = await registerRuntimeIdentity({ runtime: 'codex', label: 'A', configHomeRef: identityHome });
  await selectRuntimeIdentity('codex', pinned.id);
  await getOrPinPacketRuntimeIdentity({ runtime: 'codex', packetId, fallback: pinned });
  const selected = await registerRuntimeIdentity({ runtime: 'codex', label: 'B', configHomeRef: selectedHome });
  await selectRuntimeIdentity('codex', selected.id);
  const cwd = repo(packetId);
  const request: RuntimeLaunchRequest = { runtime: 'codex', packetId, cwd, prompt: 'fixture',
    model: 'gpt-6.1-sol', effort, executionPolicy: 'single-attempt', workMode: 'read-only',
    clientMutationId: packetId, skipSetup: true, isolate: false };
  // Control: the final owned boundary already executes as A with B selected.
  const control = await launchOwnedCodexSession(request as Parameters<typeof launchOwnedCodexSession>[0]);
  expect(control.ok, control.note).toBe(true);
  await finished(control.surfaceId);
  expect(saved(control.surfaceId).identity).toMatchObject({ id: pinned.id, configHomeRef: identityHome });
  let surfaceId: string;
  if (entry === 'launch-route') {
    const response = await POST(new NextRequest('http://localhost/api/runtime/launch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.ok, result.note).toBe(true);
    surfaceId = result.surfaceId;
  } else if (entry === 'single-attempt') {
    expect(() => assertSingleAttemptLaunch(request, 'read-only')).not.toThrow();
    surfaceId = (await launchOwnedCodexSession(request as Parameters<typeof launchOwnedCodexSession>[0])).surfaceId;
  } else {
    const result = await codexRuntime.launch({ ...request, cwd });
    expect(result.ok, result.note).toBe(true);
    surfaceId = result.sessionKey!;
  }
  await finished(surfaceId);
  expect(saved(surfaceId)).toMatchObject({ effort, identity: { id: pinned.id, configHomeRef: identityHome },
    executionPolicy: { mode: 'single-attempt', effort } });
  expect(calls(cwd)).toHaveLength(2);
  expect(calls(cwd).every(call => call.configHome === identityHome
    && call.args.includes(`model_reasoning_effort=${effort}`))).toBe(true);
});

it.each((['none', 'minimal'] as const).flatMap(effort =>
  [false, true].map(advertised => ({ effort, advertised })),
))('QA validates and spawns with the selected home for $effort (advertised=$advertised)', async ({ effort, advertised }) => {
  const identityHome = join(root, `qa-identity-${effort}-${advertised}`);
  cache(identityHome, 'gpt-6.1-sol', advertised ? [effort] : ['low']);
  cache(configHome, 'gpt-6.1-sol', advertised ? ['low'] : [effort]);
  const identity = await registerRuntimeIdentity({ runtime: 'codex', label: 'Fixture', configHomeRef: identityHome });
  await selectRuntimeIdentity('codex', identity.id);
  const answer = callCodex('fixture', { binary, model: 'gpt-6.1-sol', reasoningEffort: effort });
  if (!advertised) {
    await expect(answer).rejects.toMatchObject({ name: 'EffortPinRejectionError' });
    return;
  }
  expect(JSON.parse(await answer)).toMatchObject({
    configHome: identityHome,
    args: expect.arrayContaining([`model_reasoning_effort=${effort}`]),
  });
});

it.each(['none', 'minimal'] as const)('launch POST uses selected worker discovery for %s before binding a receipt', async effort => {
  const identityHome = join(root, `route-identity-${effort}`);
  cache(identityHome, 'gpt-6.1-sol', [effort]);
  cache(configHome, 'gpt-6.1-sol', ['low']);
  const identity = await registerRuntimeIdentity({ runtime: 'codex', label: 'Fixture', configHomeRef: identityHome });
  await selectRuntimeIdentity('codex', identity.id);
  const cwd = repo(`route-identity-${effort}-repo`);
  const before = records();
  const body = { runtime: 'codex', model: 'gpt-6.1-sol', effort, prompt: 'fixture', cwd,
    clientMutationId: `route-identity-${effort}`, skipSetup: true, isolate: false };
  const invoke = () => POST(new NextRequest('http://localhost/api/runtime/launch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  const response = await invoke();
  expect(response.status).toBe(200);
  const launched = await response.json();
  expect(launched.ok).toBe(true);
  await finished(launched.surfaceId);
  expect(saved(launched.surfaceId)).toMatchObject({ effort, identity: { id: identity.id, configHomeRef: identityHome } });
  expect(calls(cwd)).toMatchObject([{ configHome: identityHome, args: expect.arrayContaining([`model_reasoning_effort=${effort}`]) }]);
  closeDb();
  expect((await invoke()).headers.get('x-o8-idempotency-replayed')).toBe('1');
  expect(calls(cwd)).toHaveLength(1);

  body.clientMutationId += '-correction';
  cache(identityHome, 'gpt-6.1-sol', ['low']);
  cache(configHome, 'gpt-6.1-sol', [effort]);
  const refused = await invoke();
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ code: 'effort_unsupported_model' });
  expect(calls(cwd)).toHaveLength(1);
  expect(records()).toHaveLength(before.length + 1);
  cache(identityHome, 'gpt-6.1-sol', [effort]);
  closeDb();
  const corrected = await invoke();
  expect(corrected.status).toBe(200);
  await finished((await corrected.json()).surfaceId);
  expect(calls(cwd)).toHaveLength(2);
});

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

// One admission matrix covers every public launch boundary with contradictory
// persisted caches. Changing only the ambient cache must never change admission.
it.each(['launch-route', 'single-attempt', 'effort-pin', 'worker-dispatch', 'lead-dispatch'].flatMap(entry =>
  (['none', 'minimal'] as const).flatMap(effort => [false, true].map(advertised => ({ entry, effort, advertised }))),
))('$entry uses its identity cache for $effort (advertised=$advertised)', async ({ entry, effort, advertised }) => {
  // The lead uses this source account too, before preparing its isolated home.
  const identityHome = entry === 'lead-dispatch' ? configHome : join(root, `selected-${entry}-${effort}-${advertised}`);
  const ambientHome = join(root, 'ambient');
  const identity = await registerRuntimeIdentity({ runtime: 'codex', label: 'Fixture', configHomeRef: identityHome });
  await selectRuntimeIdentity('codex', identity.id);
  cache(identityHome, 'gpt-6.1-sol', advertised ? [effort] : ['low']);
  vi.stubEnv('CODEX_HOME', ambientHome);
  try {
    for (const ambientAdvertised of [!advertised, advertised]) {
      cache(ambientHome, 'gpt-6.1-sol', ambientAdvertised ? [effort] : ['low']);
      const cwd = repo(`boundary-${entry}-${effort}-${advertised}-${ambientAdvertised}`);
      const before = records();
      const request: RuntimeLaunchRequest = { runtime: 'codex', model: 'gpt-6.1-sol', effort,
        prompt: 'fixture', cwd, executionPolicy: 'single-attempt', workMode: 'read-only',
        clientMutationId: `boundary-${entry}-${effort}-${advertised}-${ambientAdvertised}`, skipSetup: true, isolate: false };
      if (entry === 'effort-pin') {
        expect(resolveEffortPin({ runtime: 'codex', model: request.model!, requestedEffort: effort }).ok).toBe(advertised);
      } else if (entry === 'single-attempt') {
        const validate = () => assertSingleAttemptLaunch(request, 'read-only');
        if (advertised) expect(validate).not.toThrow();
        else expect(validate).toThrow();
      } else if (entry === 'launch-route') {
        const response = await POST(new NextRequest('http://localhost/api/runtime/launch', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
        }));
        expect(response.status).toBe(advertised ? 200 : 400);
        if (advertised) {
          const launched = await response.json();
          await finished(launched.surfaceId);
          expect(saved(launched.surfaceId)).toMatchObject({ effort, identity: { id: identity.id },
            executionPolicy: { mode: 'single-attempt', effort } });
        }
      } else if (entry === 'worker-dispatch') {
        // A different source account must not determine the worker's model list.
        cache(configHome, 'other-model', ['low']);
        const catalog = await workerModelCatalog('codex', cwd);
        expect(catalog.models).toEqual([{ id: request.model, efforts: advertised
          ? ['adaptive', effort, 'low', 'medium', 'high', 'max', 'xhigh', 'ultra']
          : ['adaptive', 'low', 'medium', 'high', 'max', 'xhigh', 'ultra'] }]);
        const launched = await launchOwnedCodexSession({ cwd, prompt: 'fixture', model: request.model!, effort }).catch(error => {
          expect(advertised).toBe(false);
          expect(error).toMatchObject({ name: 'EffortPinRejectionError' });
          return null;
        });
        expect(Boolean(launched)).toBe(advertised);
        if (launched) {
          await finished(launched.surfaceId);
          expect(saved(launched.surfaceId)).toMatchObject({ effort, identity: { id: identity.id } });
        }
      } else {
        const events: OrchestratorEvent[] = [];
        await codexBackend.sendTurn(cwd, 'fixture', event => events.push(event), { model: request.model!, thinkingEffort: effort });
        expect(events.some(event => event.type === 'turn_receipt')).toBe(advertised);
        if (advertised) expect(events).toContainEqual({ type: 'turn_receipt', leadModel: request.model, effort });
        else expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringMatching(/does not advertise.*effort/i) }));
      }
      const runsProcess = advertised && ['launch-route', 'worker-dispatch', 'lead-dispatch'].includes(entry);
      expect(calls(cwd)).toHaveLength(runsProcess ? 1 : 0);
      if (runsProcess) expect(calls(cwd)[0].args).toContain(`model_reasoning_effort=${effort}`);
      if (runsProcess && entry !== 'lead-dispatch') expect(calls(cwd)[0].configHome).toBe(identityHome);
      if (!advertised) expect(records()).toEqual(before);
    }
  } finally { vi.stubEnv('CODEX_HOME', configHome); }
});

// Each independent process entry point must carry its validated account into spawn.
it.each(['cli-proxy', 'external-worker'].flatMap(entry =>
  (['none', 'minimal'] as const).flatMap(effort => [false, true].map(advertised => ({ entry, effort, advertised }))),
))('$entry validates and spawns one home for $effort (advertised=$advertised)', async ({ entry, effort, advertised }) => {
  const identityHome = join(root, `${entry}-${effort}-${advertised}-home`);
  const cwd = repo(`${entry}-${effort}-${advertised}-repo`);
  cache(identityHome, 'gpt-6.1-sol', advertised ? [effort] : ['low']);
  cache(configHome, 'gpt-6.1-sol', advertised ? ['low'] : [effort]);
  const identity = await registerRuntimeIdentity({ runtime: 'codex', label: 'Fixture', configHomeRef: identityHome });
  await selectRuntimeIdentity('codex', identity.id);
  if (entry === 'cli-proxy') {
    writeFileSync(join(getDataDir(), 'repos.json'), JSON.stringify([{ path: cwd }]));
    const response = await cliPOST(new NextRequest('http://localhost/api/v2/proxy/cli', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'codex', model: 'cli:codex:gpt-6.1-sol', effort,
        repoPath: cwd, messages: [{ role: 'user', content: 'fixture' }] }),
    }));
    // Consume even an unexpected successful stream so red runs leave no child.
    const text = await response.text();
    expect(response.status).toBe(advertised ? 200 : 400);
    if (advertised) expect(text).toContain(identityHome);
    else expect(JSON.parse(text)).toMatchObject({ code: 'effort_unsupported_model' });
  } else {
    const running = startCodex({ cwd, prompt: 'fixture', model: 'gpt-6.1-sol', effort, onChunk: async () => {} });
    const result = await running.then(process => process.result).catch(() => null);
    if (advertised) {
      await expect(running).resolves.toBeDefined();
      expect(result?.exitCode).toBe(0);
    } else await expect(running).rejects.toMatchObject({ name: 'EffortPinRejectionError' });
  }
  expect(calls(cwd)).toEqual(advertised ? [{
    configHome: identityHome, args: expect.arrayContaining([`model_reasoning_effort=${effort}`]),
  }] : []);
});

it.each(['none', 'minimal'] as const)('worker discovery keeps one home across its asynchronous probe for %s', async effort => {
  const identityHome = join(root, `discovery-pinned-${effort}`);
  const nextHome = join(root, `discovery-next-${effort}`);
  cache(identityHome, 'gpt-6.1-sol', [effort]);
  cache(nextHome, 'other-model', ['low']);
  cache(configHome, 'other-model', ['low']);
  const first = await registerRuntimeIdentity({ runtime: 'codex', label: 'First fixture', configHomeRef: identityHome });
  const next = await registerRuntimeIdentity({ runtime: 'codex', label: 'Next fixture', configHomeRef: nextHome });
  await selectRuntimeIdentity('codex', first.id);
  // The real app-server fixture changes the persisted selection during model/list.
  writeFileSync(join(identityHome, 'switch-identity.json'), JSON.stringify({
    file: join(getDataDir(), 'runtime-identities.json'), identityId: next.id,
  }));
  const catalog = await workerModelCatalog('codex', repo(`probe-pinned-${effort}`));
  expect(catalog.models).toEqual([{ id: 'gpt-6.1-sol', efforts: expect.arrayContaining([effort]) }]);
  const selected = JSON.parse(readFileSync(join(getDataDir(), 'runtime-identities.json'), 'utf8'));
  expect(selected.selectedByRuntime.codex).toBe(next.id);
});

it.each((['none', 'minimal'] as const).flatMap(effort =>
  [false, true].map(advertised => ({ effort, advertised })),
))('Collide validates the lead source home for $effort (advertised=$advertised)', async ({ effort, advertised }) => {
  const identityHome = join(root, `collide-worker-${effort}-${advertised}`);
  cache(identityHome, 'gpt-6.1-sol', advertised ? ['low'] : [effort]);
  cache(configHome, 'gpt-6.1-sol', advertised ? [effort] : ['low']);
  const identity = await registerRuntimeIdentity({ runtime: 'codex', label: 'Worker fixture', configHomeRef: identityHome });
  await selectRuntimeIdentity('codex', identity.id);
  writeFileSync(join(configHome, 'auth.json'), JSON.stringify({ fixture: 'lead-source' }));
  const cwd = repo(`collide-home-${effort}-${advertised}`);
  const participant = { backend: 'codex' as const, model: 'gpt-6.1-sol', thinkingEffort: effort };
  const backend = makeMoaBackend({ id: 'collide', label: 'Fixture', proposers: [participant], aggregator: participant });
  const events: OrchestratorEvent[] = [];
  await backend.sendTurn(cwd, 'fixture', event => events.push(event), { threadId: `collide-home-${effort}-${advertised}` });
  expect(events.some(event => event.type === 'collide_phase')).toBe(advertised);
  expect(calls(cwd)).toHaveLength(advertised ? 2 : 0);
  if (advertised) {
    expect(events).toContainEqual(expect.objectContaining({ type: 'turn_receipt', effort }));
    expect(calls(cwd).every(call => call.args.includes(`model_reasoning_effort=${effort}`))).toBe(true);
    // Prepared lead homes derive from the lead source, never the selected worker.
    for (const call of calls(cwd)) {
      expect(JSON.parse(readFileSync(join(call.configHome, 'auth.json'), 'utf8'))).toEqual({ fixture: 'lead-source' });
    }
  } else expect(events).toContainEqual(expect.objectContaining({ type: 'error', error: expect.stringMatching(/does not advertise.*effort/i) }));
});
