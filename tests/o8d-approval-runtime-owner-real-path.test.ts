import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startParityReference } from './fixtures/ws-parity-server';

vi.mock('@/lib/runtimes/registry', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/runtimes/registry')>();
  return { ...actual, getRuntime: () => ({ resume: async () => ({ ok: false, note: 'Next has no owner session' }) }) };
});
vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: () => { throw new Error('Next must not launch a runtime'); },
  performRuntimeAction: () => { throw new Error('Next must not mutate a runtime'); },
}));

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let POST: typeof import('@/app/api/panel/approvals/route').POST;
let store: typeof import('@/lib/approvals/store');
const device = 'approval-runtime-device';
const worker = 'approval-runtime-worker';
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1', 'x-o8-relay-forward': '1' };
const call = (path: string, body: unknown, token = server.token) => fetch(origin + path, {
  method: 'POST', headers: { ...forged, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});
const receipt = () => JSON.parse(readFileSync(join(server.directory, 'approval-runtime.json'), 'utf8'));
function approval(sessionKey: string) {
  return store.createApproval({ source: 'runtime', runtime: 'codex', agent: 'Fixture', sessionKey,
    title: 'Continue', description: 'Continue', summary: 'Continue', risk: 'low',
    continuation: { kind: 'runtime', runtimeId: 'codex', action: 'resume', sessionKey, message: 'Continue fixture' } });
}
function next(body: unknown, token = server.token) {
  return POST(new NextRequest('http://localhost/api/panel/approvals', { method: 'POST',
    headers: { ...forged, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}
beforeAll(async () => {
  server = await startParityReference({ o8d: true, nativeHttp: true, preload: './tests/fixtures/ws-parity-approval-runtime.cjs' });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  vi.stubEnv('CORTEX_IDE_DATA_DIR', server.directory);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(server.directory, 'cortex-ide.db'));
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8_WS_PORT', new URL(origin).port);
  store = await import('@/lib/approvals/store');
  ({ POST } = await import('@/app/api/panel/approvals/route'));
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
}, 120_000);
afterAll(async () => {
  (await import('@/lib/db')).closeDb();
  vi.unstubAllEnvs();
  await server?.stop();
});
it('continues the WS session through Next and stops it in that owner', async () => {
  const launch = await call('/api/runtime/launch', { runtime: 'codex', cwd: server.directory, prompt: 'fixture', clientMutationId: 'fixture-launch' });
  expect(launch.status, await launch.clone().text()).toBe(200);
  const launched = await launch.json();
  const key = launched.surfaceId;
  expect(key).toBeTruthy();
  const card = approval(key);
  const response = await next({ action: 'approve', id: card.id });
  expect(response.status).toBe(200);
  expect((await response.json()).note).toBe('Continued same owner session');
  expect(receipt()).toMatchObject({ launches: 1, sessions: [[key, { live: true, messages: ['Continue fixture'] }]] });
  expect(receipt().pid).not.toBe(process.pid);
  const stopped = await call('/api/runtime/action', { action: 'interrupt', surfaceId: key, clientMutationId: 'fixture-stop' });
  expect(stopped.status).toBe(200);
  expect(receipt().sessions[0][1].live).toBe(false);
});
it('refuses a stale reviewed terminal subject in WS', async () => {
  execFileSync('git', ['-C', server.directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
  const key = 'codex-owned:reviewed';
  const lane = createLane({ runtime: 'codex', repoPath: server.directory, branch: 'main', sessionKey: key });
  setLaneStatus(lane.id, 'awaiting_input', 'system', 'approval_required');
  const dir = join(server.directory, 'owned-codex', 'reviewed');
  mkdirSync(dir, { recursive: true });
  const record = { surfaceId: key, sessionDir: dir, cwd: server.directory, repoPath: server.directory, laneId: lane.id,
    title: 'Fixture', threadId: 'fixture-thread', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    latestPrompt: 'fixture', latestSummary: 'waiting', recentRuns: [{ id: 'reviewed-run', outcome: 'finished', finishedAt: new Date().toISOString(), tmuxSession: 'fixture-terminal' }] };
  writeFileSync(join(dir, 'session.json'), JSON.stringify(record));
  const card = store.createApproval({ source: 'runtime', runtime: 'codex', agent: 'Fixture', sessionKey: key,
    title: 'Resume lane', description: 'Continue', summary: 'Continue', risk: 'medium', metadata: { Lane: lane.id },
    continuation: { kind: 'lane', laneId: lane.id, verb: 'resume' } });
  const projection = await fetch(origin + '/api/panel/approvals?sessionKey=' + encodeURIComponent(key) + '&terminalSession=fixture-terminal', {
    headers: { authorization: `Bearer ${server.token}` },
  });
  const { terminalAdapter } = await projection.json();
  expect(terminalAdapter).toMatchObject({ approvalId: card.id, runId: 'reviewed-run' });
  record.recentRuns[0].id = 'replacement-run';
  writeFileSync(join(dir, 'session.json'), JSON.stringify(record));
  const response = await next({ action: 'approve', id: card.id, terminalAdapter });
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe('terminal_approval_changed');
  expect(store.getApproval(card.id)?.status).toBe('pending');
});
it('rechecks forged terminal evidence in WS without resolving the approval', async () => {
  const card = approval('codex-owned:forged');
  const response = await next({ action: 'approve', id: card.id, terminalAdapter: { sessionKey: 'codex-owned:forged' } });
  expect(response.status).toBe(409);
  expect(store.getApproval(card.id)?.status).toBe('pending');
});
it('keeps the bearer matrix and gives forged local headers no authority', async () => {
  for (const [token, status] of [['', 401], ['wrong', 401], [worker, 403], [device, 404], [server.token, 404]] as const) {
    const response = await call('/api/panel/approvals', { action: 'approve', id: 'missing', runtimeApprovalOperation: true }, token);
    expect(response.status).toBe(status);
  }
});
it('launches an approved runtime in WS', async () => {
  const card = store.createApproval({ source: 'runtime', runtime: 'codex', agent: 'Fixture', sessionKey: 'runtime:pending-launch',
    title: 'Launch', description: 'Launch', summary: 'Launch', risk: 'low',
    continuation: { kind: 'runtime', runtimeId: 'codex', action: 'launch', sessionKey: 'runtime:pending-launch', prompt: 'Fixture', cwd: server.directory } });
  const response = await next({ action: 'approve', id: card.id }, device);
  expect(response.status).toBe(200);
  expect((await response.json()).note).toBe('Fixture launched');
  expect(receipt().launches).toBe(2);
});
it('keeps flag-off requests local', async () => {
  vi.stubEnv('O8_NEXT_O8D', '0');
  const card = approval('codex-owned:local-only');
  const response = await next({ action: 'reject', id: card.id });
  expect(response.status).toBe(200);
  expect(store.getApproval(card.id)?.status).toBe('rejected');
  vi.stubEnv('O8_NEXT_O8D', '1');
});
