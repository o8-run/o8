import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { seedSessionFixture } from '../scripts/o8d/parity';
const { actions } = vi.hoisted(() => ({ actions: vi.fn(async () => ({ ok: true, note: 'fixture accepted' })) }));
vi.mock('@/lib/mcp/worker-observation', () => ({ relatedWorkerMembership: () => [{ surfaceId: 'codex-owned:fixture', membership: 'active', checkoutMode: 'shared', runtime: 'codex' }] }));
vi.mock('@/lib/orchestrator/shared-checkout-team', () => ({ assertSharedCheckoutOwner: () => {}, readActiveSharedCheckoutTeam: () => ({ members: [{ surfaceId: 'codex-owned:fixture', state: 'running' }] }) }));
vi.mock('@/lib/runtimes/shared/owned-session/automatic-recovery', async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), readOwnedRecoveryState: async () => ({ owned: true, operatorCorrectionAllowed: true, runId: 'fixture-run', outcome: 'idle', interrupted: false }) }));
vi.mock('@/lib/runtime/actions', () => ({ performRuntimeAction: actions }));
vi.mock('@/lib/runtimes/shared/owned-session/action-admission', async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), withOwnedActionAdmission: async (_input: unknown, operation: () => unknown) => operation(), holdPendingOwnedCorrections: () => {} }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-session-rule-caller-')));
await seedSessionFixture(root); writeFileSync(join(root, 'ws-token'), 'fixture-session-rule-operator');
vi.stubEnv('O8_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DATA_DIR', root); vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'cortex-ide.db')); vi.stubEnv('O8_API_FRONT_DOOR', '1');
const { markNativeCortexReader } = await import('@/lib/cortex/owner-process'); markNativeCortexReader();
const { correctWorkers } = await import('@/lib/orchestrator/worker-corrections');
const { getSqlite, closeDb } = await import('@/lib/db');
const { addSessionRule, removeSessionRule } = await import('@/lib/db/session-rules-store');
const { withSessionMergePublication, assertSessionMergeAllowed } = await import('@/lib/orchestrator/session-merge-restriction');
const control = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
function packet(thread: string) {
  control.writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'session-rule-fixture', repoPath: join(root, 'fixture-repo'), packets: [{ id: 'fixture-merge-packet', orchestratorThreadId: thread, status: 'awaiting_review', title: 'Fixture merge', dependencyPacketIds: [], dependencyLabels: [] } as never] });
}

let daemon: ReturnType<typeof spawn>, origin = '', dropped = 0;
let mode: 'forward' | 'lost' | 'refuse' = 'forward';
const proxy = createServer((req, res) => {
  if (mode === 'refuse') { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Fixture o8d refused the correction.' } })); return; }
  const upstream = request(origin + req.url, { method: req.method, headers: { ...req.headers, host: new URL(origin).host } }, answer => {
    if (mode === 'lost') { answer.resume(); answer.on('end', () => { dropped++; res.destroy(); }); return; }
    res.writeHead(answer.statusCode!, answer.headers); answer.pipe(res);
  }); upstream.on('error', () => res.destroy()); req.pipe(upstream);
});
const input = (id: string) => ({ repoPath: join(root, 'fixture-repo'), threadId: 'thoughts-review', id, payload: { message: 'Hold this merge', mode: 'send', holdMerges: true, targets: [{ surfaceId: 'codex-owned:fixture', runId: 'fixture-run' }] } });
beforeAll(async () => {
  const binary = process.env.O8D_TEST_BINARY ?? join(process.cwd(), 'crates/o8d/target/session-reads/debug/o8d');
  if (!process.env.O8D_TEST_BINARY) await new Promise<void>((resolve, reject) => { const build = spawn('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-session-reads', '--jobs', '1', '--target-dir', 'crates/o8d/target/session-reads'], { stdio: 'inherit' }); build.once('exit', code => code === 0 ? resolve() : reject(Error('o8d build failed'))); build.once('error', reject); });
  daemon = spawn(binary, ['--experimental-ws', '--listen', '127.0.0.1:0', '--app-upstream', '127.0.0.1:1'], { env: { ...process.env, O8D_NATIVE_OWNED: '1', O8D_NATIVE_SESSION_READS: undefined, O8D_BRIDGE_KEY: 'fixture-session-rule-bridge', O8D_EPOCH: 'fixture-session-rule', O8D_SESSION_DATA_DIR: root, O8D_SESSION_DB_PATH: join(root, 'cortex-ide.db'), O8D_REQUEST_COUNTS_PATH: join(root, 'o8d-request-counts.jsonl') }, stdio: ['pipe', 'pipe', 'pipe'] });
  origin = await new Promise<string>((resolve, reject) => { let output = ''; const timer = setTimeout(() => reject(Error('daemon timeout')), 10000); daemon.stdout!.on('data', chunk => { output += chunk; for (const line of output.split('\n')) try { const data = JSON.parse(line); if (data.listening) { clearTimeout(timer); resolve('http://' + data.listening); } } catch { /* startup frame */ } }); daemon.once('error', reject); });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening'); const port = (proxy.address() as { port: number }).port;
  vi.stubEnv('PORT', String(port)); vi.stubEnv('O8_API_PORT', String(port)); vi.stubEnv('O8_WS_PORT', String(port));
}, 300000);
afterAll(async () => { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); if (daemon?.exitCode === null) { daemon.kill('SIGTERM'); await once(daemon, 'exit'); } closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
it('surfaces a refused correction and performs no write or delivery', async () => {
  mode = 'refuse'; actions.mockClear(); await expect(correctWorkers(input('refused-correction'))).rejects.toThrow('Fixture o8d refused');
  expect(getSqlite().prepare('SELECT count(*) n FROM worker_corrections').get()).toEqual({ n: 0 }); expect(actions).not.toHaveBeenCalled();
});
it('lost response after COMMIT is unknown; original-id reconciliation never redelivers', async () => {
  mode = 'lost'; actions.mockClear(); const operation = input('lost-response-correction');
  await expect(correctWorkers(operation)).rejects.toThrow('outcome is unconfirmed'); expect(dropped).toBe(1); expect(actions).not.toHaveBeenCalled();
  expect(getSqlite().prepare('SELECT count(*) n FROM session_rules').get()).toEqual({ n: 1 });
  expect(getSqlite().prepare('SELECT status FROM worker_correction_deliveries WHERE correction_id=?').get(operation.id)).toEqual({ status: 'pending' });
  mode = 'forward'; const receipt = await correctWorkers(operation); expect(receipt.id).toBe(operation.id); expect(receipt.ruleId).toBeTruthy(); expect(receipt.deliveries[0].status).toBe('pending'); expect(actions).not.toHaveBeenCalled();
  expect(getSqlite().prepare('SELECT count(*) n FROM worker_corrections').get()).toEqual({ n: 1 }); expect(getSqlite().prepare('SELECT count(*) n FROM session_rules').get()).toEqual({ n: 1 });
  await expect(correctWorkers({ ...operation, payload: { ...operation.payload, message: 'mismatch' } })).rejects.toThrow('another request');
});
it('shares the actual Node lifecycle lease and fences every Node rule writer', async () => {
  mode = 'forward'; actions.mockClear();
  writeFileSync(join(root, 'chat-history', 'thoughts-contention.json'), JSON.stringify({ repoPath: join(root, 'fixture-repo'), messages: [] }));
  packet('thoughts-contention'); let entered = false;
  await withSessionMergePublication('fixture-merge-packet', async () => { entered = true; await expect(correctWorkers({ ...input('busy-correction'), threadId: 'thoughts-contention' })).rejects.toThrow('already in progress'); });
  expect(entered).toBe(true); expect(actions).not.toHaveBeenCalled();
  packet('thoughts-review'); expect(() => assertSessionMergeAllowed('fixture-merge-packet')).toThrow('Merge blocked');
  const publish = vi.fn(async () => {}); await expect(withSessionMergePublication('fixture-merge-packet', publish)).rejects.toThrow('Merge blocked'); expect(publish).not.toHaveBeenCalled();
  expect(() => addSessionRule('thoughts-review', 'must refuse')).toThrow('native operator transport'); expect(() => removeSessionRule('missing')).toThrow('native operator transport');
});

it('holdMerges:false keeps the reviewed callback transaction in Node and never writes a rule', async () => {
  mode = 'forward'; actions.mockClear();
  const checks = { code: vi.fn(), state: vi.fn(), persist: vi.fn() };
  const before = getSqlite().prepare('SELECT count(*) n FROM session_rules').get();
  const operation = input('review-false-correction');
  const result = await correctWorkers({ ...operation, payload: { ...operation.payload, holdMerges: false } }, checks);
  expect(result.ruleId).toBeNull(); expect(checks.code).toHaveBeenCalled(); expect(checks.state).toHaveBeenCalled(); expect(checks.persist).toHaveBeenCalledOnce();
  expect(getSqlite().prepare('SELECT count(*) n FROM session_rules').get()).toEqual(before);
});

it('a successful native hold delivers once and identical replay never dispatches again', async () => {
  mode = 'forward'; actions.mockClear(); const operation = input('successful-native-hold');
  const receipt = await correctWorkers(operation); expect(receipt.ruleId).toBeTruthy(); expect(receipt.deliveries[0].status).toBe('delivered'); expect(actions).toHaveBeenCalledOnce();
  expect(await correctWorkers(operation)).toEqual(receipt); expect(actions).toHaveBeenCalledOnce();
});
it('an unreachable daemon surfaces unknown and does not admit or deliver a correction', async () => {
  actions.mockClear(); const previous = origin; origin = 'http://127.0.0.1:1';
  try { await expect(correctWorkers(input('unreachable-native-hold'))).rejects.toThrow('outcome is unconfirmed'); } finally { origin = previous; }
  expect(actions).not.toHaveBeenCalled(); expect(getSqlite().prepare('SELECT id FROM worker_corrections WHERE id=?').get('unreachable-native-hold')).toBeUndefined();
});
