import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: async () => ({ ready: true }) }));
vi.mock('@/lib/usage-log', () => ({ monitorUsageDispatch: vi.fn(), usageSnapshotFromTelemetry: vi.fn() }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-discovered-worker-effort-')));
const repo = join(root, 'repo');
const sessions = join(root, 'sessions');
const capture = join(root, 'launch.jsonl');
const binary = join(root, 'fixture.cjs');
mkdirSync(repo);
vi.stubEnv('HOME', root);
vi.stubEnv('O8_DATA_DIR', join(root, 'data'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', join(root, 'data'));
vi.stubEnv('O8_OWNED_OPENCODE_ROOT', sessions);
vi.stubEnv('O8_OPENCODE_BIN', binary);
vi.stubEnv('O8_CODEX_BIN', binary);
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
  const result=m.method==='model/list'?{data:[{model:'fixture-new-reasoning-model',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'ultra'}]}]}:m.method==='config/read'?{config:{}}:{};
  console.log(JSON.stringify({id:m.id,result}));
 }).on('close',()=>process.exit(0));
}else{
 fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(args)+'\\n');
 console.log(JSON.stringify({type:'init',sessionId:'ses_fixture'}));
 console.log(JSON.stringify({type:'result',usage:{inputTokens:1,outputTokens:1}}));
 setTimeout(()=>{},150);
}
`, { mode: 0o700 });
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ productTelemetryEnabled: false, storageReserveFloorGb: 0.001, storageReserveRatio: 0.0001 });
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
