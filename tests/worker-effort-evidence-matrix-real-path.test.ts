import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { OwnedLaunchRequest } from '@/lib/runtimes/shared/owned-session';

const effects = vi.hoisted(() => ({ preflight: vi.fn(async () => {}), lane: vi.fn(), project: vi.fn(async () => ({ runtimeProjectId: null })),
  prepare: vi.fn(async () => { throw new Error('unexpected-worktree-preparation'); }) }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: effects.preflight }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: async () => ({ ready: true }) }));
vi.mock('@/lib/lane/commands', () => ({ dispatch: effects.lane }));
vi.mock('@/lib/projects/context', () => ({ getProjectContext: effects.project }));
vi.mock('@/lib/runtime/project-launch-brief', async original => ({
  ...await original<typeof import('@/lib/runtime/project-launch-brief')>(), buildLaunchPromptWithProjectBrief: effects.prepare,
}));
vi.mock('@/lib/usage-log', () => ({ monitorUsageDispatch: vi.fn(), usageSnapshotFromTelemetry: vi.fn() }));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-worker-effort-matrix-')));
const repo = join(root, 'repo'), accountA = join(root, '.codex'), accountB = join(root, 'account-b');
const sessions = join(root, 'sessions'), capture = join(root, 'calls.jsonl'), binary = join(root, 'codex.cjs');
let sessionRoot = sessions;
for (const dir of [repo, accountA, accountB]) mkdirSync(dir);
vi.stubEnv('HOME', root);
vi.stubEnv('CODEX_HOME', accountA);
vi.stubEnv('O8_DATA_DIR', join(root, 'data'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', join(root, 'data'));
vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', sessions);
vi.stubEnv('O8_CODEX_BIN', binary);
vi.stubEnv('O8_WORKER_SANDBOX', 'off');
vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '0');
vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
const nativeModel = 'gpt-6.1-sol', namedModel = 'gpt-5.6-terra';
const { workerModelCatalog } = await import('@/lib/orchestrator/worker-catalog');
const { getCodexSpeedCatalogue } = await import('@/lib/codex/service-tier-catalogue');
const { codexOwnedAdapter } = await import('@/lib/codex/owned');
const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session');
const identities = await import('@/lib/runtime/identity-catalog');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
let identityA: Awaited<ReturnType<typeof identities.registerRuntimeIdentity>>;
let identityB: typeof identityA;

function discovery(home: string, native: string[] | null, named: string[] | null) {
  writeFileSync(join(home, 'models.json'), JSON.stringify([nativeModel, namedModel].map((model, index) => ({
    model, isDefault: index === 0,
    ...((index === 0 ? native : named) === null ? {} : {
      supportedReasoningEfforts: (index === 0 ? native! : named!).map(reasoningEffort => ({ reasoningEffort })),
    }),
  }))));
}
function calls(kind?: string): Array<{ kind: string; home: string; args: string[]; model: string; effort?: string }> {
  const rows = existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return kind ? rows.filter(row => row.kind === kind) : rows;
}
function metadataFile(surfaceId: string) { return join(sessionRoot, surfaceId.replace('codex-owned:', ''), 'session.json'); }
function sessionFiles() { return existsSync(sessionRoot) ? readdirSync(sessionRoot) : []; }
function store() {
  return createOwnedSessionStore(codexOwnedAdapter, { workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }) });
}
async function finished(surfaceId: string, runningStore: ReturnType<typeof store>) {
  await vi.waitFor(async () => {
    await runningStore.getRuntimeTail(surfaceId);
    const saved = JSON.parse(readFileSync(metadataFile(surfaceId), 'utf8'));
    expect(saved.activeRun).toBeUndefined();
    expect(saved.recentRuns.at(-1)?.outcome).toBe('finished');
  }, { timeout: 10_000 });
}
beforeAll(async () => {
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'test: fixture'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', repo], { cwd: repo });
  writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),home=process.env.CODEX_HOME;
if(args.includes('--version')){console.log('0.159.2');process.exit(0);}
const record=row=>fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({...row,args,home})+'\\n');
if(args[0]==='app-server'){
 record({kind:'discovery'});
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(!m.id)return;
  const config={model:${JSON.stringify(namedModel)}};
  const result=m.method==='model/list'?{data:JSON.parse(fs.readFileSync(path.join(home,'models.json'),'utf8'))}:m.method==='config/read'?{config}:{};
  console.log(JSON.stringify({id:m.id,result}));
 }).on('close',()=>process.exit(0));
}else{
 const model=args.includes('--model')?args[args.indexOf('--model')+1]:${JSON.stringify(nativeModel)};
 const effort=args.find(arg=>arg.startsWith('model_reasoning_effort='))?.split('=')[1];
 record({kind:'work',model,effort});
 console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
 setTimeout(()=>{},50);
}
`, { mode: 0o700 });
  identityA = await identities.registerRuntimeIdentity({ runtime: 'codex', label: 'Fixture A', configHomeRef: accountA });
  identityB = await identities.registerRuntimeIdentity({ runtime: 'codex', label: 'Fixture B', configHomeRef: accountB });
  await updateOperatorDefaults({ defaultDispatchRuntime: 'codex', defaultDispatchModel: '', subscriptionProfile: 'both',
    codexWorkerEffort: 'adaptive', productTelemetryEnabled: false, storageReserveFloorGb: 0.001, storageReserveRatio: 0.0001 });
});
beforeEach(async () => {
  sessionRoot = join(sessions, crypto.randomUUID());
  vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', sessionRoot);
  discovery(accountA, ['low'], ['high']);
  discovery(accountB, ['high'], ['low']);
  await identities.selectRuntimeIdentity('codex', identityB.id);
  effects.preflight.mockClear(); effects.lane.mockClear(); effects.project.mockClear(); effects.prepare.mockClear();
});

it.each(['named', 'native'] as const)('refuses an unsupported %s managed runtime launch before workspace preparation', async model => {
  const { launchRuntimeSurface } = await import('@/lib/runtime/actions');
  discovery(accountB, ['low'], ['low']);
  const before = calls('work').length, beforeFiles = sessionFiles();
  await expect(launchRuntimeSurface({ runtime: 'codex', cwd: repo, prompt: 'fixture',
    model: model === 'named' ? namedModel : undefined, effort: 'high', isolate: true,
  })).rejects.toMatchObject({ name: 'EffortPinRejectionError', code: 'effort_unsupported_model' });
  expect(effects.prepare).not.toHaveBeenCalled();
  expect(calls('work')).toHaveLength(before); expect(sessionFiles()).toEqual(beforeFiles);
  expect(existsSync(join(repo, '.cortex-worktrees'))).toBe(false);
});
afterAll(async () => {
  (await import('@/lib/db')).closeDb();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

// Full Cartesian matrix, written before the fix: 2 models x 2 account modes x
// 3 discovery states x 2 entry points x 2 effort choices = 48 real-path cases.
const matrix = (['named', 'native'] as const).flatMap(model =>
  (['pinned', 'selected'] as const).flatMap(account =>
    (['fresh', 'stale', 'missing'] as const).flatMap(evidence =>
      (['launch', 'resume'] as const).flatMap(operation =>
        (['supported', 'unsupported'] as const).map(choice => ({ model, account, evidence, operation, choice }))))));
describe('worker evidence matrix (48 cases)', () => {
  it.each(matrix)('$model/$account/$evidence/$operation/$choice', async ({ model, account, evidence, operation, choice }) => {
    const actualHome = account === 'pinned' ? accountA : accountB;
    const supported = (model === 'native') === (account === 'pinned') ? 'low' : 'high';
    const unsupported = supported === 'low' ? 'high' : 'low';
    const effort: 'low' | 'high' = choice === 'supported' ? supported : unsupported;
    const packetId = account === 'pinned' ? crypto.randomUUID() : undefined;
    if (packetId) await identities.getOrPinPacketRuntimeIdentity({ runtime: 'codex', packetId, fallback: identityB, preferred: identityA });
    const request: OwnedLaunchRequest = { cwd: repo, prompt: 'fixture', model: model === 'named' ? namedModel : undefined, effort, packetId };
    let surfaceId: string | undefined;
    if (operation === 'resume') {
      discovery(actualHome, ['low', 'high'], ['low', 'high']);
      const initialStore = store();
      const initial = await initialStore.launch(request);
      expect(initial.ok, initial.note).toBe(true);
      surfaceId = initial.surfaceId;
      await finished(surfaceId, initialStore);
    }
    if (evidence === 'stale') {
      discovery(actualHome, [effort], [effort]);
      await getCodexSpeedCatalogue(actualHome, true);
    }
    discovery(actualHome, evidence === 'missing' ? null : [account === 'pinned' ? 'low' : 'high'],
      evidence === 'missing' ? null : [account === 'pinned' ? 'high' : 'low']);
    const saved = surfaceId ? readFileSync(metadataFile(surfaceId), 'utf8') : null;
    const beforeFiles = sessionFiles(), beforeWork = calls('work').length;
    const runningStore = store();
    const pending = operation === 'launch'
      ? runningStore.launch(request).then(result => { surfaceId = result.surfaceId; return result; })
      : runningStore.resume(surfaceId!, 'continue');
    // Drain even an erroneously admitted red run before checking refusal.
    const outcome = await pending.then(async result => {
      if (result.ok) await finished(surfaceId!, runningStore);
      return result;
    }, error => error);
    if (choice === 'supported' && evidence !== 'missing') {
      expect(outcome).toMatchObject({ ok: true });
      expect(calls('work')).toHaveLength(beforeWork + 1);
      expect(calls('work').at(-1)).toMatchObject({ home: actualHome, model: model === 'named' ? namedModel : nativeModel, effort });
      expect(calls('work').at(-1)!.args).toContain('--ignore-user-config');
      const savedSession = JSON.parse(readFileSync(metadataFile(surfaceId!), 'utf8'));
      expect(savedSession).toMatchObject({ effort, identity: { configHomeRef: actualHome } });
      expect(savedSession.recentRuns).toHaveLength(operation === 'launch' ? 1 : 2);
    } else {
      expect(outcome).toMatchObject({ name: 'EffortPinRejectionError', code: 'effort_unsupported_model',
        message: expect.stringContaining(`effort "${effort}"`) });
      expect(calls('work')).toHaveLength(beforeWork);
      expect(sessionFiles()).toEqual(beforeFiles);
      if (saved) expect(readFileSync(metadataFile(surfaceId!), 'utf8')).toBe(saved);
    }
  });
});

it('refreshes advertised choices when discovery removes ultra without changing account or auth/config mtimes', async () => {
  await identities.selectRuntimeIdentity('codex', identityA.id);
  discovery(accountA, ['low', 'ultra'], ['high']);
  expect((await workerModelCatalog('codex', repo)).models[0].efforts).toEqual(['adaptive', 'low', 'ultra']);
  discovery(accountA, ['low'], ['high']);
  expect((await workerModelCatalog('codex', repo)).models[0].efforts).toEqual(['adaptive', 'low']);
});
it('refreshes advertised choices after the selected account changes', async () => {
  await identities.selectRuntimeIdentity('codex', identityA.id);
  discovery(accountA, ['low', 'ultra'], ['high']);
  await workerModelCatalog('codex', repo);
  expect((await identities.selectRuntimeIdentity('codex', identityB.id)).configHomeRef).toBe(accountB);
  expect((await workerModelCatalog('codex', repo)).models[0].efforts).toEqual(['adaptive', 'high']);
});
it.each([{ choices: null }, { choices: [] }])('offers no concrete effort after discovery becomes $choices', async ({ choices }) => {
  await identities.selectRuntimeIdentity('codex', identityA.id);
  await workerModelCatalog('codex', repo);
  discovery(accountA, choices, choices);
  expect((await workerModelCatalog('codex', repo)).models).toEqual([
    { id: nativeModel, efforts: ['adaptive'] }, { id: namedModel, efforts: ['adaptive'] },
  ]);
});
it('offers the discovered native default instead of the ignored configured model', async () => {
  expect((await workerModelCatalog('codex', repo)).defaultModel).toBe(nativeModel);
  expect(calls('discovery').at(-1)).toMatchObject({ home: accountB });
});
it('removes a model and its effort choices when it disappears from discovery', async () => {
  await identities.selectRuntimeIdentity('codex', identityA.id);
  await workerModelCatalog('codex', repo);
  writeFileSync(join(accountA, 'models.json'), JSON.stringify([]));
  expect((await workerModelCatalog('codex', repo)).models).toEqual([]);
});
it('rechecks a changed native default before cold resume without a named model', async () => {
  discovery(accountB, ['low'], ['low']);
  const initialStore = store();
  const launched = await initialStore.launch({ cwd: repo, prompt: 'fixture', effort: 'low' });
  await finished(launched.surfaceId, initialStore);
  discovery(accountB, ['low'], ['high']);
  const rows = JSON.parse(readFileSync(join(accountB, 'models.json'), 'utf8'));
  rows[0].isDefault = false; rows[1].isDefault = true;
  writeFileSync(join(accountB, 'models.json'), JSON.stringify(rows));
  const file = metadataFile(launched.surfaceId), saved = readFileSync(file, 'utf8'), before = calls('work').length;
  const coldStore = store();
  const outcome = await coldStore.resume(launched.surfaceId, 'continue').then(async result => {
    if (result.ok) await finished(launched.surfaceId, coldStore);
    return result;
  }, error => error);
  expect(outcome).toMatchObject({ name: 'EffortPinRejectionError', code: 'effort_unsupported_model' });
  expect(calls('work')).toHaveLength(before);
  expect(readFileSync(file, 'utf8')).toBe(saved);
});
it.each(['named', 'native'] as const)('invalidates %s model evidence before a cold resume', async model => {
  discovery(accountB, ['low'], ['low']);
  const initialStore = store();
  const launched = await initialStore.launch({ cwd: repo, prompt: 'fixture', model: namedModel, effort: 'low' });
  await finished(launched.surfaceId, initialStore);
  const file = metadataFile(launched.surfaceId), metadata = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...metadata, model: model === 'named' ? nativeModel : undefined }));
  discovery(accountB, ['high'], ['low']);
  const saved = readFileSync(file, 'utf8'), before = calls('work').length;
  const coldStore = store();
  const outcome = await coldStore.resume(launched.surfaceId, 'continue').then(async result => {
    if (result.ok) await finished(launched.surfaceId, coldStore);
    return result;
  }, error => error);
  expect(outcome).toMatchObject({ name: 'EffortPinRejectionError', code: 'effort_unsupported_model' });
  expect(calls('work')).toHaveLength(before);
  expect(readFileSync(file, 'utf8')).toBe(saved);
});

// Packet preflight must use the same identity as owned launch, before project,
// storage, worktree or lane work. A sentinel bounds accepted cases at storage.
// Packet routing names its app default explicitly; the 48 cases above also
// exercise the native default with no model argument at the worker process.
const packetMatrix = (['named', 'default'] as const).flatMap(model =>
  (['pinned', 'selected'] as const).flatMap(account =>
    (['fresh', 'stale', 'missing'] as const).map(evidence => ({ model, account, evidence }))));
describe('packet dispatch identity matrix (12 cases)', () => {
  it.each(packetMatrix)('$model/$account/$evidence', async ({ model, account, evidence }) => {
    const { resolveWorkerRouting } = await import('@/lib/agents/routing');
    const { launchPacketWithStorageAdmission } = await import('@/lib/orchestrator/dispatch-packet-launch');
    const packetId = crypto.randomUUID(), actualHome = account === 'pinned' ? accountA : accountB;
    const effort = account === 'pinned' ? 'low' : 'ultra';
    if (account === 'pinned') await identities.getOrPinPacketRuntimeIdentity({ runtime: 'codex', packetId, fallback: identityB, preferred: identityA });
    // Different accounts advertise disjoint efforts for BOTH named/default models.
    discovery(accountA, ['low'], ['low']); discovery(accountB, ['ultra'], ['ultra']);
    if (evidence === 'stale') {
      await getCodexSpeedCatalogue(actualHome, true);
      discovery(actualHome, ['high'], ['high']);
    }
    if (evidence === 'missing') discovery(actualHome, null, null);
    const routing = resolveWorkerRouting({ requestedRuntime: 'codex', requestedModel: model === 'named' ? namedModel : null, requestedEffort: effort });
    const packet: OrchestratorPacket = { id: packetId, title: 'Fixture', summary: 'Fixture', runtime: 'codex',
      status: 'queued', queueState: 'queued', releaseState: 'pending', workspaceTargetPath: repo,
      referenceLabel: 'EFFORT', branchTarget: 'test/effort', dependencyLabels: [], dependencyPacketIds: [], workerRouting: routing };
    const reserveForLaunch = vi.fn(async () => { throw new Error('admitted-to-storage'); });
    const outcome = await launchPacketWithStorageAdmission({ packet, allPackets: [packet], workerRouting: routing,
      storageAdmission: { prepareCreationBase: async () => ({ baseBranch: 'main', baseCommit: 'fixture' }), reserveForLaunch } as unknown as
        Parameters<typeof launchPacketWithStorageAdmission>[0]['storageAdmission'],
    }).catch(error => error);
    if (evidence === 'fresh') {
      expect(outcome).toMatchObject({ message: 'admitted-to-storage' });
      expect(reserveForLaunch).toHaveBeenCalledOnce();
    } else {
      expect(outcome).toMatchObject({ name: 'EffortPinRejectionError', code: 'effort_unsupported_model' });
      expect(reserveForLaunch).not.toHaveBeenCalled();
      expect(effects.project).not.toHaveBeenCalled(); expect(effects.preflight).not.toHaveBeenCalled();
    }
    expect(effects.lane).not.toHaveBeenCalled();
  });
});
