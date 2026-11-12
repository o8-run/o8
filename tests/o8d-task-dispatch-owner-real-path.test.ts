import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { startParityReference } from './fixtures/ws-parity-server';

// A regression that executes in Next must never touch a real provider.
const local = vi.hoisted(() => ({ spawns: 0 }));
vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: async () => { local.spawns++; return { ok: true, surfaceId: 'fixture:next', note: 'Next stub started' }; },
  performRuntimeAction: async () => ({ ok: true }),
}));
vi.mock('@/lib/runtimes/shared/auth-detect', async original => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(), assertRuntimeDispatchable: async () => {},
}));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: async () => {} }));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: () => {} }));

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let actions: typeof import('@/lib/tasks/actions');
let lanes: typeof import('@/lib/lane/registry');
let control: typeof import('@/lib/orchestrator/control-plane');
let db: typeof import('@/lib/db');
let mcp: typeof import('@/app/api/mcp/route');
let taskRoute: typeof import('@/app/api/tasks/[taskId]/dispatch/route');
let seq = 0;
const read = () => JSON.parse(readFileSync(join(server.directory, 'task-runtime.json'), 'utf8')) as {
  pid: number; node: string; launchCount: number; sessions: Array<[string, { laneId: string; live: boolean }]>; calls: Array<{ laneId: string }>; spawns: string[]; accepted: Array<{ laneId: string; dispatchId: string }>;
};
const gate = () => writeFileSync(join(server.directory, 'hold-task-launch'), 'hold');
const release = () => { if (!server) return; const file = join(server.directory, 'hold-task-launch'); if (existsSync(file)) unlinkSync(file); };
function request(path: string, body: unknown) {
  return new NextRequest('http://localhost' + path, { method: 'POST', headers: {
    authorization: `Bearer ${server.token}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
}
async function throughNext(taskId: string, message?: string) {
  const response = await mcp.POST(request('/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'o8_task_dispatch', arguments: { taskId, message } } }));
  expect(response.status).toBe(200);
  const body = await response.json();
  return { ...JSON.parse(body.result.content[0].text), isError: body.result.isError };
}
async function fixture() {
  const id = `pkt-owner-${++seq}`;
  const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  const packet = { id, referenceLabel: `P${seq}`, title: 'Owner task', summary: 'Fixture dispatch', runtime: 'codex',
    workspaceTargetPath: server.directory, branchTarget: `task/${id}`, dependencyLabels: [], dependencyPacketIds: [],
    status: 'queued', queueState: 'held', holdIntent: 'explicit-dispatch', releaseState: 'pending', lane: null } as OrchestratorPacket;
  control.writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath: server.directory, packets: [packet] });
  return id;
}
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true, preload: './tests/fixtures/ws-parity-task-dispatch.cjs', entry: './tests/fixtures/ws-parity-task-dispatch-entry.mjs' });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  vi.stubEnv('CORTEX_IDE_DATA_DIR', server.directory);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(server.directory, 'cortex-ide.db'));
  vi.stubEnv('O8_DATA_DIR', server.directory);
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8_WS_PORT', new URL(origin).port);
  execFileSync('git', ['-C', server.directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  execFileSync('git', ['-C', server.directory, 'remote', 'add', 'origin', server.directory]);
  db = await import('@/lib/db');
  actions = await import('@/lib/tasks/actions');
  lanes = await import('@/lib/lane/registry');
  control = await import('@/lib/orchestrator/control-plane');
  mcp = await import('@/app/api/mcp/route');
  taskRoute = await import('@/app/api/tasks/[taskId]/dispatch/route');
  await (await import('@/lib/repos/registry')).addRepo(server.directory);
}, 120_000);
afterAll(async () => { release(); (await import('@/lib/db')).closeDb(); vi.unstubAllEnvs(); await server?.stop(); });
it('accepts through Next and owns admission, deferred launch and replay in WS', async () => {
  const id = await fixture(); gate();
  try {
    const receipt = await throughNext(id);
    expect(receipt).toMatchObject({ ok: true, packetId: id, status: 'launching', dispatchId: expect.any(String) });
    await vi.waitFor(() => expect(read().calls.some(call => call.laneId === receipt.laneId)).toBe(true), { timeout: 10000 });
    expect(read().pid).not.toBe(process.pid);
    expect(read().accepted).toContainEqual({ laneId: receipt.laneId, dispatchId: receipt.dispatchId });
    const replay = await throughNext(id);
    expect(replay).toMatchObject({ dispatchId: receipt.dispatchId, replayed: true });
    expect((await throughNext(id, 'different intent')).isError).toBe(true);
    expect(read().calls.filter(call => call.laneId === receipt.laneId)).toHaveLength(1);
    expect(local.spawns).toBe(0);
    release();
    await vi.waitFor(() => expect(lanes.findLaneByPacket(id)?.status).toBe('running'), { timeout: 10000 });
    expect(read().spawns.filter(laneId => laneId === receipt.laneId)).toHaveLength(1);
    expect(read().launchCount).toBe(1);
    expect(read().sessions).toEqual([[`fixture:${receipt.laneId}`, { laneId: receipt.laneId, live: true }]]);
  } finally { release(); }
}, 30000);
it('honours cancellation before spawn in WS', async () => {
  const id = await fixture(); gate();
  try {
    const receipt = await throughNext(id);
    await vi.waitFor(() => expect(read().calls.some(call => call.laneId === receipt.laneId)).toBe(true), { timeout: 10000 });
    (await import('@/lib/lane/pre-run-cancellation')).cancelPreRunPacketLaunches([id], 'stop');
    release();
    await vi.waitFor(() => expect(lanes.getLane(receipt.laneId)?.status).toBe('paused'));
    await vi.waitFor(() => expect((requireLeaseCount())).toBe(0), { timeout: 10000 });
    expect(read().spawns).not.toContain(receipt.laneId);
    expect(lanes.getLane(receipt.laneId)?.sessionKey).toBeNull();
  } finally { release(); }
}, 30000);
function requireLeaseCount() {
  return db.getSqlite().prepare('SELECT COUNT(*) FROM workspace_lifecycle_leases').pluck().get();
}
it('refuses a superseded deferred receipt without spawning or settling over it', async () => {
  const id = await fixture(); gate();
  try {
    const receipt = await throughNext(id);
    await vi.waitFor(() => expect(read().calls.some(call => call.laneId === receipt.laneId)).toBe(true), { timeout: 10000 });
    lanes.appendEvent(receipt.laneId, 'task_dispatch_accepted', 'user', { dispatchId: 'new-admission', intentHash: 'new-intent', packetId: id });
    release();
    await vi.waitFor(() => expect(requireLeaseCount()).toBe(0), { timeout: 10000 });
    expect(read().spawns).not.toContain(receipt.laneId);
    expect(lanes.getLaneEvents(receipt.laneId, 100).some(event => event.verb === 'task_dispatch_failed')).toBe(false);
  } finally { release(); }
}, 30000);
it('serves the task HTTP dispatch entry natively and through Next', async () => {
  const id = await fixture();
  const response = await taskRoute.POST(request(`/api/tasks/${id}/dispatch`, {}), { params: Promise.resolve({ taskId: id }) });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body, JSON.stringify(body)).toMatchObject({ ok: true, packetId: id });
  const missing = await fetch(`${origin}/api/tasks/missing/dispatch`, { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }, body: '{}' });
  expect(missing.status).toBe(404);
  expect(local.spawns).toBe(0);
}, 30000);
it('keeps dispatch and owner credentials fail closed against forged local headers', async () => {
  const device = 'task-owner-device';
  const worker = 'task-owner-worker';
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
  for (const path of ['/api/tasks/missing/dispatch', '/api/tasks/dispatch-owner']) {
    for (const [token, status] of [['', 401], ['wrong', 401], [device, 403], [worker, 403]] as const) {
      const response = await fetch(origin + path, { method: 'POST', headers: {
        'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
        'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1', 'x-o8-relay-forward': '1',
      }, body: JSON.stringify({ taskId: 'missing', input: {} }) });
      expect(response.status).toBe(status);
    }
  }
  const relayed = await fetch(origin + '/api/tasks/dispatch-owner', { method: 'POST', headers: {
    authorization: `Bearer ${server.token}`, 'content-type': 'application/json', 'x-o8-relay-forward': '1',
  }, body: JSON.stringify({ taskId: 'missing', input: {} }) });
  expect(relayed.status).toBe(403);
});
it('preserves local dispatch when the flag is off', async () => {
  vi.stubEnv('O8_NEXT_O8D', '0');
  const id = await fixture();
  const result = await actions.dispatchTask(id, { waitForLaunch: true });
  expect(result.ok).toBe(true);
  expect(local.spawns).toBe(1);
  vi.stubEnv('O8_NEXT_O8D', '1');
}, 30000);
