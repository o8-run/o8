import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ launch: vi.fn(), perform: vi.fn(), afterHead: undefined as (() => void) | undefined, beforeClaim: undefined as (() => void) | undefined }));
vi.mock('@/lib/runtime/actions', () => ({ launchRuntimeSurface: h.launch, performRuntimeAction: h.perform }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/approvals/resolution', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/approvals/resolution')>();
  return { ...actual, claimApprovalResolution: (...args: Parameters<typeof actual.claimApprovalResolution>) => {
    const callback = h.beforeClaim;
    h.beforeClaim = undefined;
    callback?.();
    return actual.claimApprovalResolution(...args);
  } };
});
vi.mock('@/lib/lane/head-sha-lock', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/lane/head-sha-lock')>();
  return { ...actual, readHeadSha: async (...args: Parameters<typeof actual.readHeadSha>) => {
    const result = await actual.readHeadSha(...args);
    const callback = h.afterHead;
    h.afterHead = undefined;
    callback?.();
    return result;
  } };
});

const root = mkdtempSync(join(tmpdir(), 'o8-terminal-approval-'));
const data = join(root, 'data');
mkdirSync(data);
process.env.O8_DATA_DIR = data;
process.env.CORTEX_IDE_DATA_DIR = data;
process.env.CORTEX_IDE_OWNED_CODEX_ROOT = join(root, 'codex');
process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = join(root, 'claude');
writeFileSync(join(data, 'worker-token'), 'fixture-terminal-worker-token');
const repo = join(root, 'repo');
mkdirSync(repo);
function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}
git('init', '-b', 'main');
git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');

const { GET, POST } = await import('@/app/api/panel/approvals/route');
const { createApproval, getApproval, listApprovalEvents, recordApprovalAudit } = await import('@/lib/approvals/store');
const { createLane, attachSession, setLaneStatus, getLane } = await import('@/lib/lane/registry');
const { closeDb, getSqlite } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
let seq = 0;

function fixture(runtime: 'codex' | 'claude-code' = 'codex') {
  const sessionKey = `${runtime}-owned:terminal-${++seq}`;
  const terminalSession = `terminal-${seq}`;
  const lane = createLane({ runtime, repoPath: repo, branch: 'main', sessionKey });
  setLaneStatus(lane.id, 'awaiting_input', 'system', 'approval_required');
  const sessionDir = join(root, runtime === 'codex' ? 'codex' : 'claude', `terminal-${seq}`);
  mkdirSync(sessionDir, { recursive: true });
  const record = {
    surfaceId: sessionKey, sessionDir, cwd: repo, repoPath: repo, laneId: lane.id,
    title: 'Fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    latestPrompt: 'fixture', latestSummary: 'waiting', threadId: `thread-${seq}`, recentRuns: [{
      id: `run-${seq}`, outcome: 'finished', finishedAt: new Date().toISOString(), tmuxSession: terminalSession,
    }],
  };
  const save = () => writeFileSync(join(sessionDir, 'session.json'), JSON.stringify(record));
  save();
  const approval = createApproval({
    source: 'runtime', runtime, agent: runtime, sessionKey, risk: 'medium',
    title: 'Resume lane', description: 'Continue after a checkpoint', summary: 'Continue after a checkpoint',
    metadata: { Lane: lane.id }, continuation: { kind: 'lane', laneId: lane.id, verb: 'resume' },
  });
  return { sessionKey, terminalSession, lane, approval, record, save };
}

type Fixture = ReturnType<typeof fixture>;
async function projection(f: Fixture) {
  const response = await GET(new NextRequest(`http://localhost/api/panel/approvals?sessionKey=${encodeURIComponent(f.sessionKey)}&terminalSession=${f.terminalSession}`));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.terminalAdapter).toMatchObject({ version: 1, sessionKey: f.sessionKey, terminalSession: f.terminalSession, approvalId: f.approval.id });
  return body.terminalAdapter as Record<string, unknown>;
}
function resolve(f: Fixture, terminalAdapter: unknown, action = 'approve', worker = false) {
  return POST(new NextRequest('http://localhost/api/panel/approvals', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${worker ? 'fixture-terminal-worker-token' : getOrCreateWsToken()}` },
    body: JSON.stringify({ id: f.approval.id, action, terminalAdapter }),
  }));
}

beforeEach(() => {
  h.launch.mockReset().mockResolvedValue({ ok: true, surfaceId: 'new-owned-run', note: 'launched' });
  h.perform.mockReset();
  h.afterHead = undefined;
  h.beforeClaim = undefined;
});
afterAll(() => { closeDb(); rmSync(root, { recursive: true, force: true }); });

describe('terminal lane approval through the shared route and persisted state', () => {
  it.each(['codex', 'claude-code'] as const)('refuses a %s owned-session rebind at the atomic decision claim', async runtime => {
    const f = fixture(runtime);
    const adapter = await projection(f);
    h.beforeClaim = () => { f.record.recentRuns[0].tmuxSession = 'replacement-terminal'; f.save(); };
    expect((await resolve(f, adapter, 'reject')).status).toBe(409);
    closeDb();
    expect(getApproval(f.approval.id)?.status).toBe('pending');
    expect(listApprovalEvents(f.approval.id).some(event => event.type === 'rejected')).toBe(false);
    expect(h.perform).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
  });
  it('refuses a replacement approval with the same timestamp at the atomic claim seam', async () => {
    const f = fixture();
    const adapter = await projection(f);
    h.beforeClaim = () => getSqlite().prepare('UPDATE approvals SET summary = ? WHERE id = ?').run('A different decision', f.approval.id);
    expect((await resolve(f, adapter, 'reject')).status).toBe(409);
    expect(getApproval(f.approval.id)).toMatchObject({ status: 'pending', summary: 'A different decision', updatedAt: f.approval.updatedAt });
  });
  it.each(['codex', 'claude-code'] as const)('approves the exact %s session without a new owned launch', async runtime => {
    const f = fixture(runtime);
    h.perform.mockResolvedValue({ ok: true, note: 'continued the reviewed session' });
    const adapter = await projection(f);
    expect((await resolve(f, adapter)).status).toBe(200);
    expect(h.perform).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: 'steer', surfaceId: f.sessionKey, steerSource: 'operator' }));
    expect(h.launch).not.toHaveBeenCalled();
    expect(getLane(f.lane.id)).toMatchObject({ sessionKey: f.sessionKey, status: 'running' });
    closeDb();
    expect(getApproval(f.approval.id)).toMatchObject({ status: 'approved', resolution: { continuationStatus: 'completed' } });
  });

  it('projects the newest retained run and keeps the oldest terminal raw', async () => {
    const f = fixture();
    f.record.recentRuns.push({ ...f.record.recentRuns[0], id: 'old-run', tmuxSession: 'old-terminal' });
    f.save();
    expect(await projection(f)).toMatchObject({ runId: f.record.recentRuns[0].id });
    const response = await GET(new NextRequest(`http://localhost/api/panel/approvals?sessionKey=${f.sessionKey}&terminalSession=old-terminal`));
    await expect(response.json()).resolves.toMatchObject({ terminalAdapter: null });
  });

  it('refuses a lane rebound during the real Git validation read', async () => {
    const f = fixture();
    const adapter = await projection(f);
    h.afterHead = () => attachSession(f.lane.id, 'codex-owned:replacement', 'system');
    expect((await resolve(f, adapter)).status).toBe(409);
    expect(getApproval(f.approval.id)?.status).toBe('pending');
    expect(h.perform).not.toHaveBeenCalled();
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('records a failed continuation without falling back to a fresh run', async () => {
    const f = fixture();
    h.perform.mockResolvedValue({ ok: false, note: 'session changed' });
    await resolve(f, await projection(f));
    expect(getApproval(f.approval.id)).toMatchObject({ status: 'approved', resolution: { continuationStatus: 'failed' } });
    expect(h.launch).not.toHaveBeenCalled();
  });
  it.each(['codex', 'claude-code'] as const)('projects and rejects the exact %s approval with durable terminal authority', async runtime => {
    const f = fixture(runtime);
    const adapter = await projection(f);
    expect((await resolve(f, adapter, 'reject')).status).toBe(200);
    closeDb();
    expect(getApproval(f.approval.id)?.status).toBe('rejected');
    expect(listApprovalEvents(f.approval.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'rejected', terminalAdapter: expect.objectContaining({ sessionKey: f.sessionKey, terminalSession: f.terminalSession, authority: 'lane-state' }) }),
    ]));
    expect(h.launch).not.toHaveBeenCalled();
  });

  it.each(['session', 'revision', 'version'] as const)('refuses a stale or unknown %s before claiming an approval', async drift => {
    const f = fixture();
    const adapter = { version: 1, sessionKey: f.sessionKey, terminalSession: f.terminalSession, approvalId: f.approval.id, revision: 'obsolete', [drift]: 'invalid' };
    expect((await resolve(f, adapter, 'reject')).status).toBe(409);
    expect(getApproval(f.approval.id)?.status).toBe('pending');
    expect(h.launch).not.toHaveBeenCalled();
  });

  it.each(['lane-session', 'terminal', 'approval', 'head', 'running'] as const)('invalidates a rendered control after %s changes', async drift => {
    const f = fixture();
    const adapter = await projection(f);
    if (drift === 'lane-session') attachSession(f.lane.id, 'codex-owned:replacement', 'system');
    if (drift === 'terminal') { f.record.recentRuns[0].tmuxSession = 'replacement'; f.save(); }
    if (drift === 'approval') recordApprovalAudit(f.approval.id, 'updated', 'system', 'new evidence');
    if (drift === 'head') git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'changed');
    if (drift === 'running') { f.record.recentRuns[0].outcome = 'running'; f.save(); }
    expect((await resolve(f, adapter, 'reject')).status).toBe(409);
    expect(getApproval(f.approval.id)?.status).toBe('pending');
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('refuses a worker before any decision or continuation', async () => {
    const f = fixture();
    expect((await resolve(f, await projection(f), 'approve', true)).status).toBe(403);
    expect(getApproval(f.approval.id)?.status).toBe('pending');
    expect(h.launch).not.toHaveBeenCalled();
  });
});
