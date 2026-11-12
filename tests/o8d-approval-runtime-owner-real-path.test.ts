import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

vi.mock('@/lib/intake/plan-dispatch', () => ({
  dispatchApprovedPlan: () => { throw new Error('Next must not dispatch an approved plan'); },
}));

let server: Awaited<ReturnType<typeof startParityReference>>;
let origin: string;
let directory: string;
let POST: typeof import('@/app/api/panel/approvals/route').POST;
let store: typeof import('@/lib/approvals/store');
let database: typeof import('@/lib/db');
const device = 'approval-runtime-device';
const worker = 'approval-runtime-worker';
const forged = { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-o8-client-addr': '127.0.0.1', 'x-o8-relay-forward': '1' };
const call = (path: string, body: unknown, token = server.token) => fetch(origin + path, {
  method: 'POST', headers: { ...forged, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
});
const receipt = () => JSON.parse(readFileSync(join(server.directory, 'approval-runtime.json'), 'utf8'));
// WS also writes this database. Take the write lock before fixture reads so a
// deferred lane transaction cannot lose its read-to-write upgrade to WS.
// BEGIN IMMEDIATE waits using the connection's existing production busy timeout.
function seedFixture<T>(write: () => T): T {
  return database.getSqlite().transaction(write).immediate();
}
function createFixtureApproval(input: Parameters<typeof store.createApproval>[0]) {
  return seedFixture(() => store.createApproval(input));
}
function approval(sessionKey: string) {
  return createFixtureApproval({ source: 'runtime', runtime: 'codex', agent: 'Fixture', sessionKey,
    title: 'Continue', description: 'Continue', summary: 'Continue', risk: 'low',
    continuation: { kind: 'runtime', runtimeId: 'codex', action: 'resume', sessionKey, message: 'Continue fixture' } });
}
function next(body: unknown, token = server.token, headers: Record<string, string> = {}) {
  return POST(new NextRequest('http://localhost/api/panel/approvals', { method: 'POST',
    headers: { ...forged, ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}
beforeAll(async () => {
  // Prepare Git evidence before WS can run repository refreshes against it.
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-approval-runtime-owner-')));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', directory]);
  execFileSync('git', ['-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  server = await startParityReference({ directory, o8d: true, nativeHttp: true, preload: './tests/fixtures/ws-parity-approval-runtime.cjs' });
  await server.stopNext();
  origin = server.url.replace('ws:', 'http:').replace('/ws', '');
  vi.stubEnv('CORTEX_IDE_DATA_DIR', server.directory);
  vi.stubEnv('CORTEX_IDE_DB_PATH', join(server.directory, 'cortex-ide.db'));
  vi.stubEnv('O8_NEXT_O8D', '1');
  vi.stubEnv('O8_WS_PORT', new URL(origin).port);
  database = await import('@/lib/db');
  store = await import('@/lib/approvals/store');
  ({ POST } = await import('@/app/api/panel/approvals/route'));
  writeFileSync(join(server.directory, 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex'));
  writeFileSync(join(server.directory, 'worker-token'), worker);
}, 120_000);
afterAll(async () => {
  (await import('@/lib/db')).closeDb();
  vi.unstubAllEnvs();
  await server?.stop();
  if (directory) rmSync(directory, { recursive: true, force: true });
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
async function terminalFixture(name: string) {
  const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
  const key = `codex-owned:${name}`;
  const lane = seedFixture(() => {
    const created = createLane({ runtime: 'codex', repoPath: server.directory, branch: 'main', sessionKey: key });
    setLaneStatus(created.id, 'awaiting_input', 'system', 'approval_required');
    return created;
  });
  const dir = join(server.directory, 'owned-codex', name);
  mkdirSync(dir, { recursive: true });
  const record = { surfaceId: key, sessionDir: dir, cwd: server.directory, repoPath: server.directory, laneId: lane.id,
    title: 'Fixture', threadId: 'fixture-thread', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    latestPrompt: 'fixture', latestSummary: 'waiting', recentRuns: [{ id: 'reviewed-run', outcome: 'finished', finishedAt: new Date().toISOString(), tmuxSession: 'fixture-terminal' }] };
  writeFileSync(join(dir, 'session.json'), JSON.stringify(record));
  const card = createFixtureApproval({ source: 'runtime', runtime: 'codex', agent: 'Fixture', sessionKey: key,
    title: 'Resume lane', description: 'Continue', summary: 'Continue', risk: 'medium', metadata: { Lane: lane.id },
    continuation: { kind: 'lane', laneId: lane.id, verb: 'resume' } });
  const projection = await fetch(origin + '/api/panel/approvals?sessionKey=' + encodeURIComponent(key) + '&terminalSession=fixture-terminal', {
    headers: { authorization: `Bearer ${server.token}` },
  });
  const { terminalAdapter } = await projection.json();
  expect(terminalAdapter).toMatchObject({ approvalId: card.id, runId: 'reviewed-run' });
  return { card, terminalAdapter, record, dir, key };
}
it('steers the reviewed terminal once in WS through Next', async () => {
  const { card, terminalAdapter, key } = await terminalFixture('terminal-success');
  const before = receipt().launches;
  const response = await next({ action: 'approve', id: card.id, terminalAdapter });
  expect(response.status).toBe(200);
  expect((await response.json()).note).toBe('Continued same owner session');
  expect(receipt()).toMatchObject({ launches: before, claimedAtSteer: 'approved' });
  expect(receipt().pid).not.toBe(process.pid);
  expect(receipt().sessions.find(([id]: [string]) => id === key)[1].messages).toHaveLength(1);
  expect(store.getApproval(card.id)?.resolution?.continuationStatus).toBe('completed');
});
it('refuses a run changed after claim at the WS steer fence', async () => {
  const { card, terminalAdapter, dir, key } = await terminalFixture('terminal-race');
  writeFileSync(join(dir, 'change-before-steer'), '1');
  const before = receipt().fences;
  const response = await next({ action: 'approve', id: card.id, terminalAdapter });
  expect(response.status).toBe(200);
  expect((await response.json()).note).toContain('reviewed terminal session, run or HEAD changed');
  expect(receipt()).toMatchObject({ fences: before + 1, claimedAtSteer: 'approved' });
  expect(receipt().pid).not.toBe(process.pid);
  expect(receipt().sessions.some(([id]: [string]) => id === key)).toBe(false);
  expect(store.getApproval(card.id)).toMatchObject({ status: 'approved', resolution: { continuationStatus: 'failed' } });
});
it('refuses a stale reviewed terminal subject in WS', async () => {
  const { card, terminalAdapter, record, dir } = await terminalFixture('terminal-stale');
  record.recentRuns[0].id = 'replacement-run';
  writeFileSync(join(dir, 'session.json'), JSON.stringify(record));
  const response = await next({ action: 'approve', id: card.id, terminalAdapter });
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe('terminal_approval_changed');
  expect(store.getApproval(card.id)?.status).toBe('pending');
});
it('launches an inbox lane resume once in WS', async () => {
  const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
  const lane = seedFixture(() => {
    const created = createLane({ runtime: 'codex', repoPath: server.directory, branch: 'main' });
    setLaneStatus(created.id, 'paused', 'system', 'fixture');
    return created;
  });
  const card = createFixtureApproval({ source: 'runtime', runtime: 'codex', agent: 'Fixture', sessionKey: 'runtime:lane-launch',
    title: 'Resume', description: 'Resume', summary: 'Resume', risk: 'low',
    continuation: { kind: 'lane', laneId: lane.id, verb: 'resume' } });
  const before = receipt().launches;
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await next({ action: 'approve', id: card.id });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.ok).toBe(true);
    expect(result.note).toContain(attempt === 0 ? 'Resumed in' : 'already resolved');
  }
  expect(receipt().launches).toBe(before + 1);
  expect(receipt().pid).not.toBe(process.pid);
});
it('preserves the agent-tool merge hold through Next to WS', async () => {
  const localHold = vi.spyOn(await import('@/lib/lane/merge-hold'), 'isMergeApprovalHeld');
  const card = createFixtureApproval({ source: 'runtime', runtime: 'codex', agent: 'Fixture', sessionKey: 'runtime:held',
    title: 'Held', description: 'Held', summary: 'Held', risk: 'low', policyRuleId: 'mission-merge-hold',
    continuation: { kind: 'lane', laneId: 'held-lane', verb: 'merge' } });
  const response = await next({ action: 'approve', id: card.id }, server.token, { 'x-o8-agent-tool': '1' });
  expect(response.status).toBe(403);
  expect((await response.json()).error).toContain('mission holds merges');
  expect(localHold).not.toHaveBeenCalled();
  localHold.mockRestore();
  expect(store.getApproval(card.id)?.status).toBe('pending');
});
it('refuses a worker through Next before reading the approval', async () => {
  const lookup = vi.spyOn(store, 'getApproval');
  const response = await next({ action: 'approve', id: 'missing' }, worker);
  expect(response.status).toBe(403);
  expect(lookup).not.toHaveBeenCalled();
  lookup.mockRestore();
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
it('forwards no cookie, and a cookie changes no WS principal', async () => {
  const cookie = `o8-token=${server.token}`;
  const original = globalThis.fetch;
  const forwarded: Headers[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).startsWith(origin)) forwarded.push(new Headers(init?.headers));
    return original(input, init);
  });
  try {
    const card = createFixtureApproval({ source: 'runtime', runtime: 'codex', agent: 'Fixture', sessionKey: 'runtime:cookie-launch',
      title: 'Launch', description: 'Launch', summary: 'Launch', risk: 'low',
      continuation: { kind: 'runtime', runtimeId: 'codex', action: 'launch', sessionKey: 'runtime:cookie-launch', prompt: 'Fixture', cwd: server.directory } });
    const response = await next({ action: 'approve', id: card.id }, device, { cookie });
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].has('cookie')).toBe(false);
    expect(forwarded[0].get('authorization')).toBe(`Bearer ${device}`);
  } finally { spy.mockRestore(); }
  // WS resolves the caller from the bearer alone: an operator cookie neither adds nor removes authority.
  for (const [token, status] of [[worker, 403], [device, 404], ['wrong', 401]] as const) {
    for (const extra of [{}, { cookie }]) {
      const response = await fetch(origin + '/api/panel/approvals', { method: 'POST', body: JSON.stringify({ action: 'approve', id: 'missing', runtimeApprovalOperation: true }),
        headers: { ...forged, ...extra, 'content-type': 'application/json', authorization: `Bearer ${token}` } });
      expect(response.status).toBe(status);
    }
  }
});
it('launches an approved runtime in WS', async () => {
  const before = receipt().launches;
  const card = createFixtureApproval({ source: 'runtime', runtime: 'codex', agent: 'Fixture', sessionKey: 'runtime:pending-launch',
    title: 'Launch', description: 'Launch', summary: 'Launch', risk: 'low',
    continuation: { kind: 'runtime', runtimeId: 'codex', action: 'launch', sessionKey: 'runtime:pending-launch', prompt: 'Fixture', cwd: server.directory } });
  const response = await next({ action: 'approve', id: card.id }, device);
  expect(response.status).toBe(200);
  expect((await response.json()).note).toBe('Fixture launched');
  expect(receipt().launches).toBe(before + 1);
});
it('keeps flag-off requests local', async () => {
  vi.stubEnv('O8_NEXT_O8D', '0');
  const card = approval('codex-owned:local-only');
  const response = await next({ action: 'reject', id: card.id });
  expect(response.status).toBe(200);
  expect(store.getApproval(card.id)?.status).toBe('rejected');
  vi.stubEnv('O8_NEXT_O8D', '1');
});
it('dispatches an approved plan in WS through Next', async () => {
  const card = createFixtureApproval({ source: 'runtime', runtime: 'codex', agent: 'Fixture', sessionKey: 'runtime:plan',
    title: 'Plan', description: 'Plan', summary: 'Plan', risk: 'low',
    continuation: { kind: 'plan', repoPath: server.directory, issueNumber: 4242, issueTitle: 'Fixture plan',
      issueUrl: 'https://example.invalid/issues/4242', runtime: 'codex', tasks: [{ title: 'Fixture task', body: 'Do the fixture task' }] } });
  const response = await next({ action: 'approve', id: card.id });
  expect(response.status).toBe(200);
  expect((await response.json()).note).toContain('Dispatched 1 packet for issue #4242.');
  expect(store.getApproval(card.id)?.resolution?.continuationStatus).not.toBe('outcome_unknown');
});
