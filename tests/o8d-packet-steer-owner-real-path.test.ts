import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { startParityReference } from './fixtures/ws-parity-server';
const local = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/runtime/actions', () => ({ performRuntimeAction: async () => { local.calls++; return { ok: true, status: 'completed' }; } }));
vi.mock('@/lib/codex/owned', async original => ({ ...await original<typeof import('@/lib/codex/owned')>(),
  continueOwnedCodexSession: async () => { throw new Error('Fallback must run in WS'); }, getOwnedCodexTelemetrySources: async () => null }));
vi.mock('@/lib/orchestrator/headless-loop', () => ({ runHeadlessSprintTick: async () => ({ launched: 0, active: 0 }) }));
let server: Awaited<ReturnType<typeof startParityReference>>;
let repo: string; let origin: string; let seq = 0;
let control: typeof import('@/lib/orchestrator/control-plane');
let lanes: typeof import('@/lib/lane/registry');
let db: typeof import('@/lib/db');
const read = () => JSON.parse(readFileSync(join(server.directory, 'steer-runtime.json'), 'utf8')) as { pid: number; calls: Array<{ surfaceId: string }>; delivered: Array<{ surfaceId: string; runId: string; fallback: boolean }> };
function flag(name: string, on = true) { const file = join(server.directory, name); if (on) writeFileSync(file, 'yes'); else if (existsSync(file)) unlinkSync(file); }
function request(path: string, body: unknown) { return new NextRequest('http://localhost' + path, { method: 'POST',
  headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
async function fixture(originTag?: 'design-mode') {
  const id = `packet-owner-${++seq}`; const surfaceId = `codex-owned:${id}`;
  const lane = lanes.createLane({ repoPath: repo, worktreePath: repo, branch: `fix/${id}`, runtime: 'codex', packetId: id, sessionKey: surfaceId });
  lanes.setLaneStatus(lane.id, 'running', 'system', 'session_launched');
  const packet = { id, runtime: 'codex', referenceLabel: `P${seq}`, title: 'Fixture', summary: 'Fixture', origin: originTag,
    workspaceTargetPath: repo, branchTarget: lane.branch, status: 'running', queueState: 'queued', releaseState: 'pending',
    orchestratorThreadId: 'thoughts-owner-parent', dependencyLabels: [], dependencyPacketIds: [], lane: { laneId: lane.id, sessionKey: surfaceId } } as OrchestratorPacket;
  await control.withControlPlaneLock(async () => {
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    control.writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath: repo, packets: [packet] });
  });
  const dir = join(server.directory, 'owned-codex', id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ surfaceId, sessionDir: dir, cwd: repo, repoPath: repo,
    laneId: lane.id, packetId: id, title: id, threadId: 'provider-thread', latestPrompt: 'fixture', latestSummary: 'done',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    recentRuns: [{ id: 'run-original', outcome: 'finished', mode: 'resume', finishedAt: new Date().toISOString() }] }));
  return { id, surfaceId, lane };
}
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true, preload: './tests/fixtures/ws-parity-packet-steer.cjs', entry: './tests/fixtures/ws-parity-task-dispatch-entry.mjs' });
  await server.stopNext(); origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  for (const key of ['O8_DATA_DIR', 'CORTEX_IDE_DATA_DIR']) vi.stubEnv(key, server.directory);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(server.directory, 'cortex-ide.db'));
  vi.stubEnv('CORTEX_IDE_OWNED_CODEX_ROOT', join(server.directory, 'owned-codex'));
  vi.stubEnv('O8_NEXT_O8D', '1'); vi.stubEnv('O8_WS_PORT', new URL(origin).port);
  repo = join(server.directory, 'repo'); mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  db = await import('@/lib/db'); control = await import('@/lib/orchestrator/control-plane'); lanes = await import('@/lib/lane/registry');
  await (await import('@/lib/repos/registry')).addRepo(repo);
  mkdirSync(join(server.directory, 'chat-history'), { recursive: true });
  writeFileSync(join(server.directory, 'chat-history', 'thoughts-owner-parent.json'), JSON.stringify({ repoPath: repo, backend: 'codex', messages: [] }));
}, 120000);
afterEach(() => { for (const name of ['steer-busy', 'hold-steer', 'steer-fallback']) flag(name, false); });
afterAll(async () => { db?.closeDb(); vi.unstubAllEnvs(); await server?.stop(); });
it('queues through Next and lets only WS claim and deliver on a headless wake', async () => {
  const f = await fixture(); flag('steer-busy');
  const route = await import('@/app/api/orchestrator/steer-packet/route');
  const response = await route.POST(request('/api/orchestrator/steer-packet', { packetId: f.id, message: 'fixture', idempotencyKey: f.id }));
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await response.json()).result.deliveryState).toBe('queued');
  flag('steer-busy', false);
  const tick = await import('@/app/api/orchestrator/headless-tick/route');
  await tick.POST(request('/api/orchestrator/headless-tick', {}));
  expect(read().delivered.filter(row => row.surfaceId === f.surfaceId)).toHaveLength(0);
  const wake = () => fetch(origin + '/api/orchestrator/headless-tick', { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: '{}' });
  expect((await wake()).status).toBe(200); await wake();
  expect(read().pid).toBe(server.pid);
  expect(read().delivered.filter(row => row.surfaceId === f.surfaceId)).toHaveLength(1);
  const claim = lanes.getLaneEvents(f.lane.id, 100).find(event => event.verb === 'steer_delivery' && event.payload.state === 'sending');
  expect(claim?.payload.ownerPid).toBe(server.pid);
  const event = lanes.getLaneEvents(f.lane.id, 100).find(row => row.verb === 'steered_packet')!;
  await (await import('@/lib/orchestrator/operator-mission-service/steer')).deliverQueuedPacketSteer(event);
  expect(read().delivered.filter(row => row.surfaceId === f.surfaceId)).toHaveLength(1);
  expect(lanes.getLaneEvents(f.lane.id, 100).find(event => event.verb === 'steer_run_admitted')?.payload.ownedRunId).toBe(read().delivered.at(-1)?.runId);
}, 30000);
it.each(['stop', 'session'])('refuses stale %s evidence at the prepared-run guard', async drift => {
  const f = await fixture(); flag('hold-steer');
  const { steerPacket } = await import('@/lib/orchestrator/operator-mission-service/steer');
  const delivery = steerPacket({ packetId: f.id, message: 'fixture' });
  const refusal = expect(delivery).rejects.toThrow('stopped, closed, or changed workers');
  await vi.waitFor(() => expect(read().calls.some(row => row.surfaceId === f.surfaceId)).toBe(true));
  if (drift === 'stop') (await import('@/lib/db/worker-correction-fences')).advanceCorrectionStop(`worker:${f.surfaceId}`);
  else lanes.updateLane(f.lane.id, { sessionKey: 'codex-owned:replacement' });
  flag('hold-steer', false); await refusal;
  expect(read().delivered.filter(row => row.surfaceId === f.surfaceId)).toHaveLength(0);
  expect(lanes.getLaneEvents(f.lane.id, 100).some(event => event.verb === 'steer_delivery' && event.payload.state === 'failed')).toBe(true);
}, 30000);
it('runs the direct Codex fallback in WS', async () => {
  const f = await fixture(); flag('steer-fallback');
  const result = await (await import('@/lib/orchestrator/operator-mission-service/steer')).steerPacket({ packetId: f.id, message: 'fallback' });
  expect(result.deliveryState).toBe('delivered'); expect(read().pid).toBe(server.pid);
  expect(read().delivered.filter(row => row.surfaceId === f.surfaceId)).toMatchObject([{ fallback: true }]);
  expect(local.calls).toBe(0);
}, 30000);
it('routes the UI-loop caller to WS', async () => {
  const f = await fixture('design-mode'); flag('steer-busy');
  (await import('@/lib/orchestrator/ui-loop')).setUiLoopSettleTimeoutForTest(20);
  const ui = await import('@/app/api/orchestrator/ui-loop/steer/route');
  const response = await ui.POST(request('/api/orchestrator/ui-loop/steer', { repo, text: 'Edit the button' }));
  expect(response.status, await response.clone().text()).toBe(200);
  expect((await response.json()).result.kind).toBe('steered');
  expect(read().delivered.filter(row => row.surfaceId === f.surfaceId)).toHaveLength(0);
  flag('steer-busy', false);
  await fetch(origin + '/api/orchestrator/headless-tick', { method: 'POST', headers: { authorization: `Bearer ${server.token}` } });
  expect(read().delivered.filter(row => row.surfaceId === f.surfaceId)).toHaveLength(1); expect(local.calls).toBe(0);
  const leases = (await import('@/lib/leases/resource-lease-default-store')).getResourceLeaseStore();
  await vi.waitFor(async () => expect((await leases.status(`ui-loop:${repo}`)).holder).toBeNull(), { timeout: 10000 });
}, 30000);
it('routes task-artifact delivery to WS', async () => {
  const f = await fixture(); flag('steer-busy');
  const { createTaskArtifact, submitTaskArtifactAction } = await import('@/lib/task-artifacts/service');
  const artifact = await createTaskArtifact({ title: 'Fixture', html: '<p>Fixture</p>', packetId: f.id,
    actions: [{ name: 'submit', label: 'Submit', schema: { fields: { note: { type: 'string' } } } }] }, { role: 'operator' });
  const result = await submitTaskArtifactAction(artifact.id, { action: 'submit', nonce: 'owner-artifact-nonce', payload: { note: 'fixture' }, target: artifact.target, actor: 'operator' });
  expect(result).toMatchObject({ accepted: true, deliverVia: 'packet', action: { delivery: 'delivered' } });
  expect(read().delivered.filter(row => row.surfaceId === f.surfaceId)).toHaveLength(0);
  flag('steer-busy', false);
  await fetch(origin + '/api/orchestrator/headless-tick', { method: 'POST', headers: { authorization: `Bearer ${server.token}` } });
  expect(read().delivered.filter(row => row.surfaceId === f.surfaceId)).toHaveLength(1);
}, 30000);
it('routes exact-run worker correction through its WS admission', async () => {
  const f = await fixture();
  const { correctWorkers } = await import('@/lib/orchestrator/worker-corrections');
  const receipt = await correctWorkers({ repoPath: repo, threadId: 'thoughts-owner-parent', id: 'owner-correction-identity',
    payload: { message: 'fixture', mode: 'send', holdMerges: false, targets: [{ surfaceId: f.surfaceId, runId: 'run-original' }] } });
  expect(receipt.deliveries[0].status).toBe('delivered'); expect(read().pid).toBe(server.pid);
  expect(read().delivered.filter(row => row.surfaceId === f.surfaceId)).toHaveLength(1);
}, 30000);
it('keeps owner admission fail closed for device, worker and forged local headers', async () => {
  const f = await fixture(); flag('steer-busy');
  const device = 'steer-owner-device'; const worker = 'steer-owner-worker';
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
  for (const [token, status] of [['',401],['bad',401],[device,403],[worker,403],[server.token,403]] as const) {
    const response = await fetch(origin + '/api/orchestrator/steer-owner', { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json', 'x-o8-relay-forward': '1', 'x-o8-client-addr': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' }, body: '{}' });
    expect(response.status).toBe(status);
    const probe = await fetch(origin + '/api/runtime/owner', { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-o8-relay-forward': '1' } });
    expect(probe.status).toBe(status);
  }
  const route = await import('@/app/api/orchestrator/steer-packet/route');
  for (const [token, status] of [['', 401], ['bad', 401], [worker, 403], [device, 200]] as const) {
    const response = await route.POST(new NextRequest('http://localhost/api/orchestrator/steer-packet', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ packetId: f.id, message: 'auth fixture', idempotencyKey: `auth-${token}` }) }));
    expect(response.status).toBe(status);
  }
  flag('steer-busy', false);
  await fetch(origin + '/api/orchestrator/headless-tick', { method: 'POST', headers: { authorization: `Bearer ${server.token}` } });
  expect(read().delivered.filter(row => row.surfaceId === f.surfaceId)).toHaveLength(1);
});
it('retains main local delivery with the native flag unset', async () => {
  const f = await fixture(); vi.stubEnv('O8_NEXT_O8D', '');
  await (await import('@/lib/orchestrator/operator-mission-service/steer')).steerPacket({ packetId: f.id, message: 'local' });
  expect(local.calls).toBe(1); vi.stubEnv('O8_NEXT_O8D', '1');
}, 30000);

async function stdioDispatch(data: string, port: number, taskId: string, steer = false) {
  const api = steer ? server.apiUrl : `http://127.0.0.1:${port}`;
  const receiptFile = join(data, steer ? 'steer-runtime.json' : 'task-runtime.json');
  const child = spawn(process.execPath, [steer ? '--require=./tests/fixtures/ws-parity-packet-steer.cjs' : '--require=./tests/fixtures/ws-parity-task-dispatch.cjs',
    '--require=./scripts/next/brain-runtime.cjs', 'tests/fixtures/stdio-runtime-owner-entry.mjs'], {
    cwd: process.cwd(), env: { ...process.env, HOME: data, USERPROFILE: data, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data,
      CORTEX_IDE_DB_PATH: join(data, 'cortex-ide.db'), O8_NEXT_O8D: '', O8_WS_PORT: String(port), O8_API_PORT: new URL(api).port,
      PORT: new URL(api).port, O8_API_BASE: api, WS_TOKEN: server.token, O8_MCP_NO_ORPHAN_KILL: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    const response = await new Promise<{ result?: { isError?: boolean }; error?: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stdio timeout: ${stderr.slice(-2000)}`)), 30000);
      let pending = '';
      child.stdout.on('data', chunk => {
        pending += String(chunk);
        for (;;) {
          const end = pending.indexOf('\n'); if (end < 0) break;
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          try { const body = JSON.parse(line); if (body.id === 101) { clearTimeout(timer); resolve(body); } } catch { /* stdio diagnostics */ }
        }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`stdio exited ${code}: ${stderr.slice(-2000)}`)); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/call', params: steer ? { name: 'steer_packet', arguments: { packetId: taskId, message: 'stdio fixture' } } : { name: 'o8_task_dispatch', arguments: { taskId } } }) + '\n');
    });
    expect(response.result?.isError, JSON.stringify(response)).not.toBe(true);
    await vi.waitFor(() => {
      const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
      if (steer) expect(receipt.delivered.filter((row: { surfaceId: string }) => row.surfaceId === `codex-owned:${taskId}`)).toHaveLength(1);
      else expect(receipt.spawns).toHaveLength(1);
    }, { timeout: 15000 });
    return { pid: child.pid, receipt: JSON.parse(readFileSync(receiptFile, 'utf8')) };
  } finally {
    child.stdin.end();
    if (child.exitCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve()));
  }
}
function queuedPacket(id: string) {
  return { id, referenceLabel: 'P1', title: 'Stdio task', summary: 'Fixture', runtime: 'codex', workspaceTargetPath: repo,
    branchTarget: `task/${id}`, dependencyLabels: [], dependencyPacketIds: [], status: 'queued', queueState: 'held',
    holdIntent: 'explicit-dispatch', releaseState: 'pending', lane: null } as OrchestratorPacket;
}
it('stdio task dispatch discovers the live WS owner without an inherited flag', async () => {
  const id = 'stdio-owned-task'; const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  await control.withControlPlaneLock(() => control.writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath: repo, packets: [queuedPacket(id)] }));
  writeFileSync(join(server.directory, 'api-port'), new URL(origin).port);
  const result = await stdioDispatch(server.directory, Number(new URL(origin).port), id);
  expect(result.receipt.pid).toBe(server.pid); expect(result.receipt.pid).not.toBe(result.pid);
}, 60000);
it('stdio task dispatch remains local with no WS owner', async () => {
  const data = mkdtempSync(join(tmpdir(), 'o8-stdio-local-'));
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  try {
    const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
    writeFileSync(join(data, 'ws-token'), server.token); writeFileSync(join(data, 'api-port'), String(port));
    writeFileSync(join(data, 'orchestrator-state.json'), JSON.stringify({ version: 1, mission: { ...createEmptyOrchestratorMissionState(), repoPath: repo, packets: [queuedPacket('stdio-local-task')] } }));
    const result = await stdioDispatch(data, port, 'stdio-local-task');
    expect(result.receipt.pid).toBe(result.pid); expect(result.receipt.pid).not.toBe(server.pid);
  } finally { rmSync(data, { recursive: true, force: true }); }
}, 60000);

it('stdio packet steer uses WS while its Next API listener is stopped', async () => {
  const f = await fixture();
  writeFileSync(join(server.directory, 'api-port'), new URL(server.apiUrl).port);
  const result = await stdioDispatch(server.directory, Number(new URL(origin).port), f.id, true);
  expect(result.receipt.pid).toBe(server.pid); expect(result.receipt.pid).not.toBe(result.pid);
}, 60000);
