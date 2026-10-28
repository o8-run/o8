import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: async () => ({ ready: true }) }));
vi.mock('@/lib/usage-log', () => ({ monitorUsageDispatch: vi.fn(), usageSnapshotFromTelemetry: vi.fn() }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-discovered-worker-effort-')));
const repo = join(root, 'repo');
const sessions = join(root, 'sessions');
const capture = join(root, 'launch.jsonl');
const binary = join(root, 'fixture.cjs');
const account = join(root, '.codex');
const modelFile = join(account, 'models.json');
mkdirSync(account);
const codexSessions = join(root, 'codex-sessions');
const geminiSessions = join(root, 'gemini-sessions');
mkdirSync(repo);
vi.stubEnv('HOME', root);
vi.stubEnv('O8_DATA_DIR', join(root, 'data'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', join(root, 'data'));
vi.stubEnv('O8_OWNED_OPENCODE_ROOT', sessions);
vi.stubEnv('O8_OPENCODE_BIN', binary);
vi.stubEnv('O8_CODEX_BIN', binary);
vi.stubEnv('O8_GEMINI_BIN', binary);
vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', codexSessions);
vi.stubEnv('O8_OWNED_GEMINI_ROOT', geminiSessions);
vi.stubEnv('CODEX_HOME', account);
vi.stubEnv('O8_WORKER_SANDBOX', 'off');
vi.stubEnv('O8_CRASH_SURVIVABLE_WORKERS', '0');
const { workerModelCatalog } = await import('@/lib/orchestrator/worker-catalog');
const { opencodeRuntime } = await import('@/lib/runtimes/opencode');
const { getOwnedOpencodeRuntimeTail } = await import('@/lib/opencode/owned');
function launches(): string[][] {
  return existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
beforeAll(async () => {
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2);
if(args.includes('--version')){console.log('0.159.2');process.exit(0);}
if(args[0]==='app-server'){
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(!m.id)return;
  const result=m.method==='model/list'?{data:JSON.parse(fs.readFileSync(require('node:path').join(process.env.CODEX_HOME,'models.json'),'utf8'))}:m.method==='config/read'?{config:{}}:{};
  console.log(JSON.stringify({id:m.id,result}));
 }).on('close',()=>process.exit(0));
}else{
 fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(args)+'\\n');
 console.log(JSON.stringify({type:'init',sessionId:'ses_fixture',session_id:'fixture-session'}));
 console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-thread'}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
 console.log(JSON.stringify({type:'result',usage:{inputTokens:1,outputTokens:1}}));
 setTimeout(()=>{},150);
}
`, { mode: 0o700 });
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ productTelemetryEnabled: false, storageReserveFloorGb: 0.001, storageReserveRatio: 0.0001 });
});
beforeEach(() => {
  vi.stubEnv('CODEX_HOME', account);
  writeFileSync(modelFile, JSON.stringify(['fixture-new-reasoning-model', 'gpt-6.1-sol'].map(model => ({
    model, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }],
  }))));
});
afterAll(async () => {
  (await import('@/lib/db')).closeDb();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
it('retains ultra reported for a newly discovered model through the real catalog entry point', async () => {
  const catalog = await workerModelCatalog('codex', repo);
  expect(catalog.models.find(model => model.id === 'fixture-new-reasoning-model')?.efforts).toEqual(['adaptive', 'low', 'ultra']);
});
it('refuses an independent worker effort before recording a launch without that effort', async () => {
  const launching = opencodeRuntime.launch({ cwd: repo, prompt: 'Fixture task', model: 'fixture/model/high', effort: 'high' });
  // Drain the current broken launch as well, so the red run leaves no child behind.
  await launching.then(async result => {
    if (result.sessionKey) await vi.waitFor(async () => {
      expect((await getOwnedOpencodeRuntimeTail(result.sessionKey!)).surface.lifecycle?.lastOutcome).toBe('finished');
    });
  }).catch(() => {});
  await expect(launching).rejects.toMatchObject({ name: 'EffortPinRejectionError', code: 'effort_unsupported_runtime' });
  expect(launches()).toEqual([]);
  expect(existsSync(sessions) ? readdirSync(sessions) : []).toEqual([]);
});
it('plainly refuses a discovered choice the current worker transport cannot apply exactly', async () => {
  const { codexRuntime } = await import('@/lib/runtimes/codex');
  await expect(codexRuntime.launch({ cwd: repo, prompt: 'Fixture task', model: 'fixture-new-reasoning-model', effort: 'ultra' }))
    .rejects.toMatchObject({ name: 'EffortPinRejectionError', code: 'effort_coerced', message: expect.stringContaining('cannot honor effort "ultra"') });
  expect(launches()).toEqual([]);
});
it.each([undefined, 'adaptive'] as const)('keeps a model-encoded worker variant unchanged with %s effort', async effort => {
  const result = await opencodeRuntime.launch({ cwd: repo, prompt: 'Fixture task', model: 'fixture/model/high', effort });
  expect(result.ok, result.note).toBe(true);
  await vi.waitFor(async () => expect((await getOwnedOpencodeRuntimeTail(result.sessionKey!)).surface.lifecycle?.lastOutcome).toBe('finished'));
  const args = launches().at(-1)!;
  expect(args[args.indexOf('--model') + 1]).toBe('fixture/model/high');
  expect(args).not.toContain('--effort');
});

async function drain(result: { sessionKey?: string }, kind: 'codex' | 'gemini') {
  if (!result.sessionKey) return;
  const owned = kind === 'codex' ? await import('@/lib/codex/owned') : await import('@/lib/gemini/owned');
  const read = kind === 'codex' ? (owned as typeof import('@/lib/codex/owned')).getOwnedCodexRuntimeTail
    : (owned as typeof import('@/lib/gemini/owned')).getOwnedGeminiRuntimeTail;
  await vi.waitFor(async () => expect((await read(result.sessionKey!)).surface.lifecycle?.lastOutcome).toBe('finished'));
}
it('refuses high outside a discovered low/ultra set before worker persistence or launch', async () => {
  await workerModelCatalog('codex', repo);
  const { codexRuntime } = await import('@/lib/runtimes/codex');
  const before = launches();
  const launching = codexRuntime.launch({ cwd: repo, prompt: 'Fixture task', model: 'fixture-new-reasoning-model', effort: 'high' });
  await launching.then(result => drain(result, 'codex')).catch(() => {});
  await expect(launching).rejects.toMatchObject({ name: 'EffortPinRejectionError', code: 'effort_unsupported_model' });
  expect(launches()).toEqual(before);
  expect(existsSync(codexSessions) ? readdirSync(codexSessions) : []).toEqual([]);
});
it('rechecks changed discovered choices on cold worker resume before another process or state change', async () => {
  const { codexRuntime } = await import('@/lib/runtimes/codex');
  const { codexOwnedAdapter } = await import('@/lib/codex/owned');
  const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session');
  const launched = await codexRuntime.launch({ cwd: repo, prompt: 'Fixture task', model: 'gpt-6.1-sol', effort: 'low' });
  await drain(launched, 'codex');
  const file = readdirSync(codexSessions).map(dir => join(codexSessions, dir, 'session.json'))
    .find(file => JSON.parse(readFileSync(file, 'utf8')).surfaceId === launched.sessionKey)!;
  await vi.waitFor(() => expect(JSON.parse(readFileSync(file, 'utf8')).activeRun).toBeUndefined());
  const metadata = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...metadata, identity: { id: 'fixture-account', label: 'Fixture', configHomeRef: account } }));
  const other = join(root, 'other-account'); mkdirSync(other);
  writeFileSync(join(other, 'models.json'), JSON.stringify([{ model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }]));
  vi.stubEnv('CODEX_HOME', other);
  const saved = readFileSync(file, 'utf8'), before = launches();
  writeFileSync(modelFile, JSON.stringify([{ model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] }]));
  const resuming = createOwnedSessionStore(codexOwnedAdapter).resume(launched.sessionKey!, 'Continue');
  await resuming.then(() => drain(launched, 'codex')).catch(() => {});
  await expect(resuming).rejects.toMatchObject({ name: 'EffortPinRejectionError', code: 'effort_unsupported_model' });
  expect(launches()).toEqual(before);
  expect(readFileSync(file, 'utf8')).toBe(saved);
});
it('refuses a direct worker effort that has no argument mapping instead of dropping it', async () => {
  const { geminiRuntime } = await import('@/lib/runtimes/gemini');
  const before = launches();
  const launching = geminiRuntime.launch({ cwd: repo, prompt: 'Fixture task', model: 'fixture-model', effort: 'high' });
  await launching.then(result => drain(result, 'gemini')).catch(() => {});
  await expect(launching).rejects.toMatchObject({ name: 'EffortPinRejectionError', code: 'effort_unsupported_runtime' });
  expect(launches()).toEqual(before);
  expect(existsSync(geminiSessions) ? readdirSync(geminiSessions) : []).toEqual([]);
});
it('validates a packet launch against its pinned account rather than the currently selected account', async () => {
  const { registerRuntimeIdentity, selectRuntimeIdentity, getOrPinPacketRuntimeIdentity } = await import('@/lib/runtime/identity-catalog');
  const { codexOwnedAdapter } = await import('@/lib/codex/owned');
  const { createOwnedSessionStore } = await import('@/lib/runtimes/shared/owned-session');
  const pinned = await registerRuntimeIdentity({ runtime: 'codex', label: 'Fixture A', configHomeRef: account });
  await selectRuntimeIdentity('codex', pinned.id);
  await getOrPinPacketRuntimeIdentity({ runtime: 'codex', packetId: 'fixture-effort-packet', fallback: pinned });
  const other = join(root, 'packet-other-account'); mkdirSync(other);
  writeFileSync(join(other, 'models.json'), JSON.stringify([{ model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] }]));
  const selected = await registerRuntimeIdentity({ runtime: 'codex', label: 'Fixture B', configHomeRef: other });
  await selectRuntimeIdentity('codex', selected.id);
  const result = await createOwnedSessionStore(codexOwnedAdapter, {
    workspaceSpawnGuard: async () => ({ status: 'available', source: 'no-snapshot' }),
  }).launch({ cwd: repo, prompt: 'Fixture task',
    model: 'gpt-6.1-sol', effort: 'low', packetId: 'fixture-effort-packet' });
  expect(result.ok, result.note).toBe(true);
  await drain({ sessionKey: result.surfaceId }, 'codex');
  expect(launches().at(-1)).toContain('model_reasoning_effort=low');
});
