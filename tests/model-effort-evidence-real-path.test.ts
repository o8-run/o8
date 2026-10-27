import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const effects = vi.hoisted(() => ({ mission: vi.fn(async () => { throw new Error('Unexpected mission dispatch'); }),
  lane: vi.fn(async () => { throw new Error('Unexpected lane dispatch'); }), preflight: vi.fn(async () => {}) }));
vi.mock('@/lib/panel/auth', () => ({ requirePanelAuth: () => null }));
vi.mock('@/lib/orchestrator/operator-mission-service', async original => ({
  ...await original<typeof import('@/lib/orchestrator/operator-mission-service')>(), createMission: effects.mission,
}));
vi.mock('@/lib/lane/commands', () => ({ dispatch: effects.lane }));
vi.mock('@/lib/runtimes/shared/auth-detect', async original => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(), assertRuntimeDispatchable: effects.preflight,
}));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: async () => ({ ready: true }) }));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-model-effort-evidence-')));
const repo = join(root, 'repo'), account = join(root, 'account'), data = join(root, 'data');
const capture = join(root, 'transport.jsonl'), sessions = join(root, 'sessions');
for (const dir of [repo, account, data]) mkdirSync(dir);
vi.stubEnv('HOME', root); vi.stubEnv('O8_DATA_DIR', data); vi.stubEnv('CORTEX_IDE_DATA_DIR', data);
vi.stubEnv('XDG_CONFIG_HOME', account); vi.stubEnv('XDG_DATA_HOME', join(root, 'native-data'));
vi.stubEnv('O8_OWNED_MUSE_ROOT', sessions); vi.stubEnv('O8_MUSE_BIN', join(root, 'muse'));
vi.stubEnv('O8_WORKER_SANDBOX', 'off'); vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '1');
vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
const { workerModelCatalog } = await import('@/lib/orchestrator/worker-catalog');
const { museOwnedAdapter } = await import('@/lib/muse/owned');
const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session');
const { createMuseBackend } = await import('@/lib/lane/orchestrator-backends/muse');
const mission = await import('@/app/api/orchestrator/create-mission/route');
const delegate = await import('@/app/api/orchestrator/delegate/route');
const backends: ReturnType<typeof createMuseBackend>[] = [];
const stores: ReturnType<typeof createOwnedSessionStore>[] = [];
function rows(variants: unknown = ['low', 'high']) {
  return { providerId: 'meta', profileId: null, source: 'fakeCatalog', models: [
    { providerId: 'meta', modelId: 'muse-fixture', isDefault: true, variants },
    { providerId: 'meta', modelId: 'muse-empty', variants: [] },
    { providerId: 'meta', modelId: 'muse-unknown', variants: 'unknown' },
  ] };
}
function calls() {
  return existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
function files() { return existsSync(sessions) ? readdirSync(sessions) : []; }
function request(route: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/orchestrator/${route}`, { method: 'POST',
    body: JSON.stringify({ repoPath: repo, runtime: 'muse', model: 'muse-fixture', requestedEffort: 'ultra',
      prompt: 'Fixture task', clientMutationId: crypto.randomUUID(), ...body }) });
}
beforeAll(async () => {
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'test: initialize effort fixture'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', repo], { cwd: repo });
  writeFileSync(join(root, 'muse'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
const record=value=>fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(value)+'\\n');
if(args.includes('--version')){console.log('1.4.7');process.exit(0);}
if(args[0]==='exec'){
 record({method:'exec',args,config:process.env.XDG_CONFIG_HOME});
 const emit=(type,payload)=>console.log(JSON.stringify({schema_version:1,stream:{kind:'session',id:'fixture-session'},durability:'durable',payload_type:type,payload}));
 emit('session.run.linked',{run_stream:{id:'fixture-run'}});
 const failed=args.at(-1).includes('retry-fixture');emit(failed?'run.terminal.failed':'run.terminal.completed',{terminal:failed?'failed':'completed',text:'fixture answer'});
 setTimeout(()=>{},150);
}else{
 const send=value=>console.log(JSON.stringify(value));
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line),p=m.params||{};if(!m.id)return;record({method:m.method,params:p,config:process.env.XDG_CONFIG_HOME});
  let result={};
  if(m.method==='initialize') result={schema:{version:1,fingerprint:'fixture'},grantedCapabilities:['sessionMcp'],museHome:path.join(process.env.XDG_DATA_HOME,'muse')};
  if(m.method==='model/list') result=JSON.parse(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME,'models.json'),'utf8'));
  if(m.method==='session/start'||m.method==='session/resume') result={session:{sessionId:'fixture-session',workspaceRoot:process.cwd(),providerId:'meta',modelId:p.modelId||'muse-fixture'}};
  const override=path.join(process.env.XDG_CONFIG_HOME,'resume-model.txt');
  if(m.method==='session/resume'&&fs.existsSync(override))result.session.modelId=fs.readFileSync(override,'utf8');
  if(m.method==='session/setApprovalMode')result={effectiveMode:{mode:'promptUnmatched'}};
  if(m.method==='turn/start')result={turnId:p.commandId,disposition:'started'};
  send({jsonrpc:'2.0',id:m.id,result});
  if(m.method==='turn/start')setTimeout(()=>send({jsonrpc:'2.0',method:'turn/completed',params:{sessionId:'fixture-session',turnId:p.commandId,terminal:'completed'}}),10);
 }).on('close',()=>process.exit(0));
}
`, { mode: 0o700 });
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ workerRuntimes: ['muse'], defaultDispatchRuntime: 'muse', defaultDispatchModel: 'muse-fixture',
    subscriptionProfile: 'both', productTelemetryEnabled: false, storageReserveFloorGb: 0.001, storageReserveRatio: 0.0001 });
  await (await import('@/lib/repos/registry')).addRepo(repo);
});
beforeEach(() => {
  vi.stubEnv('XDG_CONFIG_HOME', account); vi.stubEnv('XDG_DATA_HOME', join(root, 'native-data'));
  writeFileSync(join(account, 'models.json'), JSON.stringify(rows()));
  rmSync(join(account, 'resume-model.txt'), { force: true });
  effects.mission.mockClear(); effects.lane.mockClear(); effects.preflight.mockClear();
});
afterAll(async () => {
  await Promise.all(backends.map(backend => backend.closeAll()));
  (await import('@/lib/db')).closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});
it('projects restricted, empty and unknown model capabilities into the actual worker catalog', async () => {
  const catalog = await workerModelCatalog('muse', repo);
  expect(catalog.models).toEqual([
    { id: 'muse-fixture', efforts: ['adaptive', 'low', 'high'] },
    { id: 'muse-empty', efforts: ['adaptive'] }, { id: 'muse-unknown', efforts: ['adaptive'] },
  ]);
});
it('does not reuse model evidence after an account switch or a catalog change in the same account', async () => {
  await workerModelCatalog('muse', repo);
  const other = join(root, 'other-account'); mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'models.json'), JSON.stringify(rows(['ultra'])));
  vi.stubEnv('XDG_CONFIG_HOME', other);
  expect((await workerModelCatalog('muse', repo)).models[0].efforts).toEqual(['adaptive', 'ultra']);
  writeFileSync(join(other, 'models.json'), JSON.stringify(rows([])));
  expect((await workerModelCatalog('muse', repo)).models[0].efforts).toEqual(['adaptive']);
});
it.each(['muse-fixture', 'muse-empty', 'muse-unknown', 'muse-absent'])('refuses unsupported %s at owned launch before session persistence or exec', async model => {
  const store = createOwnedSessionStore(museOwnedAdapter); stores.push(store);
  const before = files(), launches = calls().filter(call => call.method === 'exec').length;
  await expect(store.launch({ cwd: repo, model, effort: 'ultra', prompt: 'fixture' })).rejects.toMatchObject({ name: 'EffortPinRejectionError' });
  expect(files()).toEqual(before); expect(calls().filter(call => call.method === 'exec')).toHaveLength(launches);
});
it('refuses mission admission before mission, preflight and worktree dispatch', async () => {
  const response = await mission.POST(request('create-mission', { issues: [{ number: 1, title: 'Fixture task', body: 'Fixture', url: 'https://example.invalid/1' }] }));
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: { code: 'effort_unsupported_model' } });
  expect(effects.mission).not.toHaveBeenCalled(); expect(effects.preflight).not.toHaveBeenCalled();
});
it('refuses delegation before packet or lane dispatch', async () => {
  const response = await delegate.POST(request('delegate', {}));
  expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: 'effort_unsupported_model' });
  expect(effects.lane).not.toHaveBeenCalled(); expect(effects.preflight).not.toHaveBeenCalled();
});
it('refuses an unsupported lead effort before session or turn commands and gives a clear error', async () => {
  const backend = createMuseBackend({ stateRoot: () => join(root, 'lead-state') }); backends.push(backend);
  const start = calls().length, events: Array<{ type: string; error?: string }> = [];
  await backend.sendTurn(repo, 'fixture', event => events.push(event), { model: 'muse-fixture', thinkingEffort: 'ultra' });
  expect(calls().slice(start).filter(call => ['session/start', 'session/resume', 'turn/start'].includes(call.method))).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: 'error', error: expect.stringMatching(/effort.*ultra.*model/i) });
});
it('refuses the direct managed launch before creating a worktree', async () => {
  const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
  const before = calls().filter(call => call.method === 'exec').length;
  await expect(launchRuntimeSurface({ runtime: 'muse', cwd: repo, prompt: 'fixture', model: 'muse-empty',
    effort: 'high', isolate: true, branchName: 'test/refused-effort' })).rejects.toMatchObject({ name: 'EffortPinRejectionError' });
  expect(existsSync(join(repo, '.cortex-worktrees'))).toBe(false);
  expect(calls().filter(call => call.method === 'exec')).toHaveLength(before);
});
it('sends an accepted lead pin unchanged and rechecks a different model before another turn', async () => {
  const backend = createMuseBackend({ stateRoot: () => join(root, 'lead-success') }); backends.push(backend);
  const events: Array<{ type: string; effort?: string }> = [];
  await backend.sendTurn(repo, 'fixture', event => events.push(event), { model: 'muse-fixture', thinkingEffort: 'high' });
  expect(events).toContainEqual(expect.objectContaining({ type: 'turn_receipt', effort: 'high' }));
  expect(calls().filter(call => call.method === 'turn/start').at(-1).params.reasoningEffort).toBe('high');
  const before = calls().filter(call => call.method === 'turn/start').length;
  await backend.sendTurn(repo, 'fixture', () => {}, { model: 'muse-empty', thinkingEffort: 'high' });
  expect(calls().filter(call => call.method === 'turn/start')).toHaveLength(before);
});
it.each([undefined, 'adaptive'] as const)('keeps %s effort omitted at the lead transport', async thinkingEffort => {
  const backend = createMuseBackend({ stateRoot: () => join(root, `lead-default-${thinkingEffort}`) }); backends.push(backend);
  await backend.sendTurn(repo, 'fixture', () => {}, { model: 'muse-empty', thinkingEffort });
  expect(calls().filter(call => call.method === 'turn/start').at(-1).params).not.toHaveProperty('reasoningEffort');
});
it('preserves a supported worker pin and checks cold resume against its persisted account', async () => {
  const store = createOwnedSessionStore(museOwnedAdapter); stores.push(store);
  const launched = await store.launch({ cwd: repo, model: 'muse-fixture', effort: 'low', prompt: 'fixture' });
  expect(launched.ok, launched.note).toBe(true);
  await vi.waitFor(async () => expect((await store.getRuntimeTail(launched.surfaceId)).surface.lifecycle?.lastOutcome).toBe('finished'), { timeout: 10_000 });
  expect(calls().filter(call => call.method === 'exec').at(-1).args).toEqual(expect.arrayContaining(['--reasoning-effort', 'low']));
  const other = join(root, 'resume-account'); mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'models.json'), JSON.stringify(rows(['ultra'])));
  vi.stubEnv('XDG_CONFIG_HOME', other);
  const resumed = createOwnedSessionStore(museOwnedAdapter); stores.push(resumed);
  const firstCount = calls().filter(call => call.method === 'exec').length;
  expect((await resumed.resume(launched.surfaceId, 'continue')).ok).toBe(true);
  await vi.waitFor(() => expect(calls().filter(call => call.method === 'exec')).toHaveLength(firstCount + 1), { timeout: 10_000 });
  await vi.waitFor(async () => expect((await resumed.getRuntimeTail(launched.surfaceId)).surface.lifecycle?.lastOutcome).toBe('finished'), { timeout: 10_000 });
  expect(calls().filter(call => call.method === 'exec').at(-1).config).toBe(account);
  writeFileSync(join(account, 'models.json'), JSON.stringify(rows([])));
  const before = calls().filter(call => call.method === 'exec').length;
  const cold = createOwnedSessionStore(museOwnedAdapter); stores.push(cold);
  await expect(cold.resume(launched.surfaceId, 'continue')).rejects.toMatchObject({ name: 'EffortPinRejectionError' });
  expect(calls().filter(call => call.method === 'exec')).toHaveLength(before);
});
it('refuses a cold lead resume whose effective model changed to an unsupported one', async () => {
  const stateRoot = () => join(root, 'changed-lead');
  const first = createMuseBackend({ stateRoot }); backends.push(first);
  await first.sendTurn(repo, 'fixture', () => {}, { model: 'muse-fixture', thinkingEffort: 'high' });
  await first.closeAll();
  writeFileSync(join(account, 'resume-model.txt'), 'muse-empty');
  const second = createMuseBackend({ stateRoot }); backends.push(second);
  const before = calls().filter(call => call.method === 'turn/start').length;
  await second.sendTurn(repo, 'fixture', () => {}, { thinkingEffort: 'high' });
  expect(calls().filter(call => call.method === 'turn/start')).toHaveLength(before);
});
it('checks a reconstructed packet effort before lane or worktree admission', async () => {
  const state = await import('@/lib/orchestrator/control-plane');
  const previous = state.readOrchestratorControlPlaneState();
  const { resolveWorkerRouting } = await import('@/lib/agents/routing');
  const { launchPacketWithStorageAdmission } = await import('@/lib/orchestrator/dispatch-packet-launch');
  const packet = { id: 'effort-evidence-packet', title: 'Fixture task', summary: 'Fixture', runtime: 'muse' as const,
    status: 'queued' as const, queueState: 'queued' as const, releaseState: 'pending' as const, workspaceTargetPath: repo,
    referenceLabel: 'EFFORT', branchTarget: 'test/effort', dependencyLabels: [], dependencyPacketIds: [] };
  state.writeOrchestratorControlPlaneState({ ...previous, packets: [packet] });
  const persisted = state.readOrchestratorControlPlaneState().packets[0];
  try {
    await expect(launchPacketWithStorageAdmission({ packet: persisted, allPackets: [persisted],
      workerRouting: resolveWorkerRouting({ requestedRuntime: 'muse', requestedModel: 'muse-empty', requestedEffort: 'high' }),
      storageAdmission: {} as Parameters<typeof launchPacketWithStorageAdmission>[0]['storageAdmission'],
    })).rejects.toMatchObject({ name: 'EffortPinRejectionError' });
    expect(effects.preflight).not.toHaveBeenCalled();
    expect(existsSync(join(repo, '.cortex-worktrees'))).toBe(false);
  } finally { state.writeOrchestratorControlPlaneState(previous); }
});
it('rechecks current model evidence before an automatic retry against persisted failed state', async () => {
  const store = createOwnedSessionStore({ ...museOwnedAdapter, retryDelayMs: 10 }); stores.push(store);
  const launched = await store.launch({ cwd: repo, model: 'muse-fixture', effort: 'low', prompt: 'retry-fixture' });
  expect(launched.ok, launched.note).toBe(true);
  const file = join(sessions, launched.surfaceId.replace('muse-owned:', ''), 'session.json');
  await vi.waitFor(() => {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.activeRun).toBeUndefined(); expect(saved.recentRuns[0].outcome).toBe('failed');
  }, { timeout: 10_000 });
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), autoRetry: true }));
  writeFileSync(join(account, 'models.json'), JSON.stringify(rows([])));
  const before = calls().filter(call => call.method === 'exec').length;
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await store.getFleetAdditions({ fresh: true });
    await vi.waitFor(() => expect(error.mock.calls).toEqual(expect.arrayContaining([
      [expect.stringContaining('Auto-retry failed'), expect.objectContaining({ name: 'EffortPinRejectionError' })],
    ])), { timeout: 10_000 });
    expect(calls().filter(call => call.method === 'exec')).toHaveLength(before);
    expect(JSON.parse(readFileSync(file, 'utf8')).recentRuns).toHaveLength(1);
  } finally { error.mockRestore(); }
});

it.each(['dispatch', 'launch'] as const)('admits a packet pinned to account A after selecting account B at %s', async operation => {
  const identities = await import('@/lib/runtime/identity-catalog');
  const packetId = crypto.randomUUID();
  const pinned = await identities.registerRuntimeIdentity({ runtime: 'muse', label: 'Fixture A', configHomeRef: account });
  writeFileSync(join(account, 'models.json'), JSON.stringify(rows(['low'])));
  await identities.selectRuntimeIdentity('muse', pinned.id);
  await identities.getOrPinPacketRuntimeIdentity({ runtime: 'muse', packetId, fallback: pinned });
  const other = join(root, `selected-${operation}`); mkdirSync(other);
  writeFileSync(join(other, 'models.json'), JSON.stringify(rows(['ultra'])));
  const selected = await identities.registerRuntimeIdentity({ runtime: 'muse', label: 'Fixture B', configHomeRef: other });
  await identities.selectRuntimeIdentity('muse', selected.id);
  const start = calls().length;
  if (operation === 'dispatch') {
    const { resolveWorkerRouting } = await import('@/lib/agents/routing');
    const { launchPacketWithStorageAdmission } = await import('@/lib/orchestrator/dispatch-packet-launch');
    const workerRouting = resolveWorkerRouting({ requestedRuntime: 'muse', requestedModel: 'muse-fixture', requestedEffort: 'low' });
    const packet = { id: packetId, title: 'Fixture', summary: 'Fixture', runtime: 'muse' as const,
      status: 'queued' as const, queueState: 'queued' as const, releaseState: 'pending' as const, workspaceTargetPath: repo,
      referenceLabel: 'EFFORT', branchTarget: 'test/effort', dependencyLabels: [], dependencyPacketIds: [], workerRouting };
    const reserveForLaunch = vi.fn(async () => { throw new Error('admitted-to-storage'); });
    await expect(launchPacketWithStorageAdmission({ packet, allPackets: [packet], workerRouting,
      storageAdmission: { prepareCreationBase: async () => ({ baseBranch: 'main', baseCommit: 'fixture' }), reserveForLaunch } as unknown as
        Parameters<typeof launchPacketWithStorageAdmission>[0]['storageAdmission'],
    })).rejects.toThrow('admitted-to-storage');
    expect(reserveForLaunch).toHaveBeenCalledOnce();
    expect(effects.lane).not.toHaveBeenCalled();
  } else {
    const store = createOwnedSessionStore(museOwnedAdapter, {
      workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }),
    }); stores.push(store);
    const launched = await store.launch({ cwd: repo, model: 'muse-fixture', effort: 'low', prompt: 'fixture', packetId });
    expect(launched.ok, launched.note).toBe(true);
    await vi.waitFor(async () => expect((await store.getRuntimeTail(launched.surfaceId)).surface.lifecycle?.lastOutcome).toBe('finished'), { timeout: 10_000 });
    expect(calls().filter(call => call.method === 'exec').at(-1)).toMatchObject({ config: account,
      args: expect.arrayContaining(['--reasoning-effort', 'low']) });
    const saved = JSON.parse(readFileSync(join(sessions, launched.surfaceId.replace('muse-owned:', ''), 'session.json'), 'utf8'));
    expect(saved.identity.configHomeRef).toBe(account);
  }
  expect(calls().slice(start).filter(call => call.method === 'model/list').map(call => call.config)).toEqual(expect.arrayContaining([account]));
  expect(calls().slice(start).filter(call => call.method === 'model/list').some(call => call.config === other)).toBe(false);
});
