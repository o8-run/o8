import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OwnedSessionRecord } from '@/lib/runtimes/shared/owned-session/types';

const { readiness } = vi.hoisted(() => ({ readiness: vi.fn(async () => ({ ready: true })) }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: vi.fn(async () => {}) }));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: readiness }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true) }));
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/codex/service-tier-catalogue', () => ({ getCodexSpeedCatalogue: async () => ({ models: { 'gpt-5.6-terra': [] }, reasoningEfforts: { 'gpt-5.6-terra': ['low'] } }) }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-worker-correction-')));
const data = join(root, 'data'); const repo = join(data, 'repo'); const bin = join(root, 'codex');
mkdirSync(join(data, 'chat-history'), { recursive: true }); mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
execFileSync('git', ['-C', repo, '-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
for (const [key, value] of Object.entries({ O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
  CORTEX_IDE_DB_PATH: join(data, 'cortex-ide.db'), CORTEX_IDE_OWNED_CODEX_ROOT: join(data, 'owned-codex'),
  O8_CODEX_BIN: bin, O8_CRASH_SURVIVABLE_WORKERS: '0', O8_WORKER_SANDBOX: '0' })) vi.stubEnv(key, value);
writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
const emit = value => console.log(JSON.stringify({...value, timestamp: new Date().toISOString()}));
emit({type:'thread.started', thread_id:'fixture-worker'});
const finish = () => { emit({type:'item.completed', item:{id:'answer', type:'agent_message', text:'Corrected result'}}); emit({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}); };
if (process.argv.at(-1)?.includes('KEEP_RUNNING')) setTimeout(finish, 30000); else finish();
`); chmodSync(bin, 0o755);
const parent = 'thoughts-correction-parent';
for (const thread of [parent, 'thoughts-other']) writeFileSync(join(data, 'chat-history', `${thread}.json`), JSON.stringify({ repoPath: repo, backend: 'codex', messages: [
  { id: 'user-origin', role: 'user', content: 'Delegate inspections.', timestamp: 1 },
  { id: 'assistant-origin', role: 'assistant', content: 'Starting workers.', backend: 'codex', model: 'gpt-5.6-terra', timestamp: 2,
    receipt: { leadModel: 'gpt-5.6-terra', effort: 'low', mode: 'multitask', pickedMode: 'fast', permissionMode: 'full' } },
] }));
const { POST: delegate } = await import('@/app/api/orchestrator/delegate/route');
const corrections = await import('@/app/api/orchestrator/worker-corrections/route');
const { fastDelegationCapability } = await import('@/lib/orchestrator/fast-delegation-auth');
const { holdWorkerCorrections } = await import('@/lib/orchestrator/worker-corrections');
const { listSessionRules } = await import('@/lib/db/session-rules-store');
const owned = await import('@/lib/codex/owned');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { closeDb } = await import('@/lib/db');
const surfaces: string[] = [];
function record(surface: string): OwnedSessionRecord {
  return JSON.parse(readFileSync(join(data, 'owned-codex', surface.slice('codex-owned:'.length), 'session.json'), 'utf8'));
}
function request(body: unknown, token = getOrCreateWsToken()) {
  return new NextRequest('http://localhost/api/orchestrator/worker-corrections', { method: 'POST',
    headers: { host: 'localhost', authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function launch(id: string, running = false) {
  const response = await delegate(new NextRequest('http://localhost/api/orchestrator/delegate', { method: 'POST', body: JSON.stringify({
    prompt: running ? 'KEEP_RUNNING' : `Inspect ${id}`, repoPath: repo, taskName: id, runtime: 'codex', model: 'gpt-5.6-terra', requestedEffort: 'low',
    checkoutMode: 'shared', parentThreadId: parent, fastCapability: fastDelegationCapability(repo, parent), assignedPaths: [`src/${id}`], readOnly: false, clientMutationId: id,
  }) }));
  const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200);
  surfaces.push(body.surfaceId);
  await vi.waitFor(async () => { await owned.getOwnedCodexFleetAdditions({ fresh: true }); expect(record(body.surfaceId).threadId).toBeTruthy();
    if (!running) expect(record(body.surfaceId).activeRun).toBeUndefined(); }, { timeout: 15000, interval: 80 });
  const session = record(body.surfaceId); return { surfaceId: body.surfaceId, runId: (session.activeRun ?? session.recentRuns[0]).id };
}
beforeAll(async () => {
  const { addRepo } = await import('@/lib/repos/registry'); await addRepo(repo);
  const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
  await updateOperatorDefaults({ workerRuntimes: ['codex'], defaultDispatchRuntime: 'codex' });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
});
afterAll(async () => {
  for (const surface of surfaces) if (existsSync(join(data, 'owned-codex', surface.slice('codex-owned:'.length), 'session.json')) && record(surface).activeRun) await owned.interruptOwnedCodexSession(surface);
  const timer = (globalThis as unknown as Record<symbol, NodeJS.Timeout | undefined>)[Symbol.for('o8.ownedSession.refreshTimer.codex')];
  if (timer) clearInterval(timer);
  closeDb(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true });
});

it('corrects exact real owned runs, persists separate receipts and never redelivers a duplicate', async () => {
  const first = await launch('first'); const second = await launch('second', true);
  const original = record(first.surfaceId);
  const body = { repoPath: repo, threadId: parent, id: 'correction-real-two', payload: {
    targets: [first, second], message: 'Report the corrected result. Do not merge.', mode: 'pause-and-send', holdMerges: true,
  } };
  const response = await corrections.POST(request(body)); const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  expect(value.receipt.deliveries.map((item: { status: string }) => item.status), JSON.stringify(value)).toEqual(['delivered', 'delivered']);
  for (const target of [first, second]) await vi.waitFor(async () => { await owned.getOwnedCodexFleetAdditions({ fresh: true }); expect(record(target.surfaceId).activeRun).toBeUndefined(); }, { timeout: 10000 });
  expect(record(second.surfaceId).recentRuns.find(run => run.id === second.runId)?.outcome).toBe('interrupted');
  expect(record(first.surfaceId)).toMatchObject({ repoPath: original.repoPath, model: original.model, threadId: original.threadId });
  expect(record(first.surfaceId).recentRuns[0].prompt).toContain('Merge is blocked');
  expect(listSessionRules(parent).filter(rule => rule.constraint === 'no_merge')).toHaveLength(1);
  const before = record(first.surfaceId).recentRuns.map(run => run.id);
  closeDb();
  expect((await corrections.POST(request(body))).status).toBe(200);
  expect(record(first.surfaceId).recentRuns.map(run => run.id)).toEqual(before);
  expect((await corrections.POST(request({ ...body, payload: { ...body.payload, message: 'Different' } }))).status).toBe(409);
  expect((await corrections.POST(request({ ...body, id: 'correction-wrong-parent', threadId: 'thoughts-other' }))).status).toBe(409);
  expect((await corrections.POST(request({ ...body, id: 'correction-anonymous' }, 'not-operator'))).status).toBe(403);
}, 60000);

it('retains the merge restriction when a busy worker refuses send, and Parent Stop fences pending admission', async () => {
  const busy = await launch('busy', true);
  const body = { repoPath: repo, threadId: parent, id: 'correction-busy-send', payload: {
    targets: [busy], message: 'Keep the result for review.', mode: 'send', holdMerges: true,
  } };
  const response = await corrections.POST(request(body)); const value = await response.json();
  expect(value.receipt.deliveries[0].status, JSON.stringify(value)).toBe('unavailable');
  expect(listSessionRules(parent).filter(rule => rule.constraint === 'no_merge')).toHaveLength(2);
  const idle = await launch('stopped-before-admission');
  let release!: () => void;
  readiness.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { ready: true }; });
  const pending = corrections.POST(request({ ...body, id: 'correction-parent-stop', payload: { ...body.payload, targets: [idle], holdMerges: false } }));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 15000 });
  holdWorkerCorrections({ repoPath: repo, threadId: parent }); release();
  const stopped = await (await pending).json();
  expect(stopped.receipt.deliveries[0].status).toBe('held');
  expect(record(idle.surfaceId).recentRuns).toHaveLength(1);
}, 60000);


it('fences Parent Stop before persistence and an idle-worker Stop during another correction', async () => {
  const idle = await launch('stop-before-persistence');
  const recovery = await import('@/lib/runtimes/shared/owned-session/automatic-recovery');
  const originalRead = recovery.readOwnedRecoveryState;
  let release!: () => void;
  const readSpy = vi.spyOn(recovery, 'readOwnedRecoveryState').mockImplementationOnce(async (...args) => {
    await new Promise<void>(resolve => { release = resolve; }); return originalRead(...args);
  });
  const body = { repoPath: repo, threadId: parent, id: 'stop-before-persistence', payload: {
    targets: [idle], message: 'Report the result.', mode: 'send', holdMerges: false,
  } };
  const pending = corrections.POST(request(body));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 15000 });
  holdWorkerCorrections({ repoPath: repo, threadId: parent }); release();
  const rejected = await pending;
  expect(rejected.status).toBe(409); expect((await rejected.json()).notAdmitted).toBe(true);
  readSpy.mockRestore();
  expect(record(idle.surfaceId).recentRuns).toHaveLength(1);

  let resume!: () => void;
  readiness.mockImplementationOnce(async () => { await new Promise<void>(resolve => { resume = resolve; }); return { ready: true }; });
  const prepared = corrections.POST(request({ ...body, id: 'idle-stop-resume-pending' }));
  await vi.waitFor(() => expect(resume).toBeTypeOf('function'), { timeout: 15000 });
  const stopped = await corrections.POST(request({ ...body, id: 'idle-explicit-stop', payload: { ...body.payload, mode: 'stop' } }));
  expect((await stopped.json()).receipt.deliveries[0].status).toBe('held');
  resume();
  expect((await (await prepared).json()).receipt.deliveries[0].status).toBe('held');
  expect(record(idle.surfaceId).recentRuns).toHaveLength(1);
}, 60000);
