import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import '@/lib/lane/commands';
import { POST } from '@/app/api/panel/approvals/route';
import { createApproval, getApproval, recordOrchestratorReview } from '@/lib/approvals/store';
import { createLane, getLane } from '@/lib/lane/registry';
import { getWorktreeManager } from '@/lib/worktree/launch';
import { getSqlite } from '@/lib/db';
import { createProject } from '@/lib/projects/store';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { PATCH as patchProject } from '@/app/api/projects/[id]/route';
import { getDataDir } from '@/lib/data-dir-migration';

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const token = 'device-publication-fixture-0123456789';
async function fixture(pin = true, direct = true) {
  const root = mkdtempSync(join(tmpdir(), 'o8-device-publication-')); roots.push(root);
  const repo = join(root, 'repo'); mkdirSync(repo);
  const origin = join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.name', 'Fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repo, 'file.txt'), 'base\n'); git(repo, 'add', 'file.txt'); git(repo, 'commit', '-qm', 'base');
  git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-qu', 'origin', 'main');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const project = createProject({ name: `Device fixture ${Date.now()}` });
  if (direct) {
    const response = await patchProject(new NextRequest(`http://localhost/api/projects/${project.id}`, { method: 'PATCH', headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}` }, body: JSON.stringify({ mergeMode: 'direct' }) }), { params: Promise.resolve({ id: project.id }) });
    expect(response.status).toBe(200);
  }
  const packetId = `device-fixture-${Date.now()}`;
  const worktree = await getWorktreeManager(repo).create({ agentType: 'codex', taskName: packetId, branchName: `work/${packetId}`, baseBranch: 'main', packetId, skipSetup: true, isolationPreference: 'git-worktree' });
  writeFileSync(join(worktree.path, 'file.txt'), 'approved\n'); git(worktree.path, 'add', 'file.txt'); git(worktree.path, 'commit', '-qm', 'approved change');
  const sha = git(worktree.path, 'rev-parse', 'HEAD');
  const lane = createLane({ projectId: project.id, repoPath: repo, worktreePath: worktree.path, branch: `work/${packetId}`, baseBranch: 'main', runtime: 'codex', packetId, label: 'Device fixture' });
  recordOrchestratorReview(packetId, { approved: true, findings: [], reviewer: 'fixture', reviewedHeadSha: sha, requiresSecondPass: false });
  const approval = createApproval({ source: 'test', runtime: 'codex', agent: 'fixture', sessionKey: `fixture-${packetId}`, title: 'Merge approved change', description: 'Fixture merge decision', summary: 'Merge', risk: 'low', continuation: { kind: 'lane', laneId: lane.id, verb: 'merge', ...(pin ? { expectedHeadSha: sha } : {}) } });
  writeFileSync(join(getDataDir(), 'mobile-device-tokens'), createHash('sha256').update(token).digest('hex') + '\n');
  return { root, repo, origin, lane, sha, approval };
}
const approve = (id: string) => POST(new NextRequest('http://localhost/api/panel/approvals', { method: 'POST', headers: { host: 'localhost', authorization: `Bearer ${token}` }, body: JSON.stringify({ id, action: 'approve' }) }));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('device approval merges the pinned source and retains the device principal in durable evidence', async () => {
  const f = await fixture();
  const response = await approve(f.approval.id);
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(git(f.origin, 'show', 'main:file.txt')).toBe('approved');
  expect(getApproval(f.approval.id)?.resolution).toMatchObject({ authorizingPrincipal: 'device', approvedHeadSha: f.sha });
  const events = getSqlite().prepare("SELECT payload_json FROM lane_events WHERE lane_id=? AND verb='merge'").all(f.lane.id) as Array<{ payload_json: string }>;
  expect(events.map(e => JSON.parse(e.payload_json))).toContainEqual(expect.objectContaining({ authorizingPrincipal: 'device', approvedSha: f.sha, mergedSha: git(f.origin, 'rev-parse', 'main'), checks: expect.any(Array) }));
});
it('a moved device-approved head refuses and returns the lane to review', async () => {
  const f = await fixture(); const base = git(f.origin, 'rev-parse', 'main');
  writeFileSync(join(f.lane.worktreePath!, 'file.txt'), 'replacement\n'); git(f.lane.worktreePath!, 'add', 'file.txt'); git(f.lane.worktreePath!, 'commit', '-qm', 'replacement');
  const response = await approve(f.approval.id);
  expect(response.status).toBe(409);
  expect(git(f.origin, 'rev-parse', 'main')).toBe(base);
  expect(getLane(f.lane.id)?.status).toBe('reviewing');
  expect(getApproval(f.approval.id)?.status).toBe('pending');
});
it('a device continuation without an approved SHA refuses before merge', async () => {
  const f = await fixture(false); const base = git(f.origin, 'rev-parse', 'main');
  const response = await approve(f.approval.id);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: 'approved_head_required' });
  expect(git(f.origin, 'rev-parse', 'main')).toBe(base);
  expect(getLane(f.lane.id)?.status).toBe('reviewing');
  expect(getApproval(f.approval.id)).toMatchObject({ status: 'rejected', resolution: { note: expect.stringContaining('Return to review') } });
});

it('new merge cards carry the exact head used for their saved diff', async () => {
  const f = await fixture(false);
  const { createLaneActionApproval } = await import('@/lib/lane/commands-approval');
  const result = await createLaneActionApproval(f.lane, 'orchestrator', { verb: 'merge', title: 'Merge fixture', description: 'Review fixture', summary: 'Merge fixture', risk: 'low', policyRuleId: 'lane-merge', note: 'Held for review' });
  expect(getApproval(result.approvalId!)?.continuation).toMatchObject({ expectedHeadSha: f.sha });
});
it.each([true, false])('refuses a head moved after the device decision was durably recorded, direct=%s', async direct => {
  const f = await fixture(true, direct); const base = git(f.origin, 'rev-parse', 'main');
  const commands = await import('@/lib/lane/commands');
  const dispatch = commands.dispatch;
  const boundary = vi.spyOn(commands, 'dispatch').mockImplementationOnce(async command => {
    expect(getApproval(f.approval.id)?.resolution).toMatchObject({ authorizingPrincipal: 'device', approvedHeadSha: f.sha });
    writeFileSync(join(f.lane.worktreePath!, 'file.txt'), 'late replacement\n');
    git(f.lane.worktreePath!, 'add', 'file.txt'); git(f.lane.worktreePath!, 'commit', '-qm', 'late replacement');
    return dispatch(command);
  });
  try {
    const response = await approve(f.approval.id);
    expect(response.status).toBe(409);
    expect(git(f.origin, 'rev-parse', 'main')).toBe(base);
    expect(getLane(f.lane.id)?.status).toBe('reviewing');
    expect(getApproval(f.approval.id)?.status).toBe('pending');
  } finally { boundary.mockRestore(); }
});

it.each([true, false])('an unavailable pinned commit after the device decision returns to review with a reason, direct=%s', async direct => {
  const f = await fixture(true, direct); const base = git(f.origin, 'rev-parse', 'main');
  const head = await import('@/lib/lane/head-sha-lock');
  const commands = await import('@/lib/lane/commands');
  const dispatch = commands.dispatch;
  let resolution: ReturnType<typeof vi.spyOn> | undefined;
  const boundary = vi.spyOn(commands, 'dispatch').mockImplementationOnce(async command => {
    expect(getApproval(f.approval.id)?.resolution).toMatchObject({ authorizingPrincipal: 'device', approvedHeadSha: f.sha });
    resolution = vi.spyOn(head, 'resolveHeadSha').mockResolvedValueOnce(undefined);
    return dispatch(command);
  });
  try {
    const response = await approve(f.approval.id);
    expect(response.status).toBe(409);
    expect(getLane(f.lane.id)?.status).toBe('reviewing');
    expect(getApproval(f.approval.id)).toMatchObject({ status: 'pending', audit: expect.arrayContaining([expect.objectContaining({ note: expect.stringContaining('could not be resolved') })]) });
    expect(git(f.origin, 'rev-parse', 'main')).toBe(base);
  } finally { boundary.mockRestore(); resolution?.mockRestore(); }
});
it.each([[false, true], [true, true], [false, false], [true, false]])('remote-lane device cards pin the fetched source, moved=%s direct=%s', async (moved, direct) => {
  const f = await fixture(false, direct);
  const { createLaneActionApproval } = await import('@/lib/lane/commands-approval');
  const branch = `remote/${f.lane.id}`;
  git(f.lane.worktreePath!, 'push', 'origin', `HEAD:refs/heads/${branch}`);
  const lane = createLane({ projectId: f.lane.projectId ?? undefined, repoPath: f.repo, branch, baseBranch: 'main', runtime: 'remote-customer' as typeof f.lane.runtime, label: 'Remote device fixture' });
  const { createToken } = await import('@/lib/worker/tokens');
  const workerToken = createToken({ label: 'Remote publication fixture' });
  getSqlite().prepare('INSERT INTO worker_runs (id, lane_id, worker_token_id, transport, status, remote_branch, started_at, last_event_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`run-${lane.id}`, lane.id, workerToken.id, 'ssh', 'completed', branch, new Date().toISOString(), new Date().toISOString());
  const result = await createLaneActionApproval(lane, 'orchestrator', { verb: 'merge', title: 'Merge remote fixture', description: 'Review remote fixture', summary: 'Merge fixture', risk: 'low', policyRuleId: 'lane-merge', note: 'Held for review' });
  expect(getApproval(result.approvalId!)?.continuation).toMatchObject({ expectedHeadSha: f.sha });
  if (moved) {
    writeFileSync(join(f.lane.worktreePath!, 'file.txt'), 'remote replacement\n');
    git(f.lane.worktreePath!, 'add', 'file.txt'); git(f.lane.worktreePath!, 'commit', '-qm', 'remote replacement');
    git(f.lane.worktreePath!, 'push', 'origin', `HEAD:refs/heads/${branch}`);
  }
  const response = await approve(result.approvalId!);
  const body = await response.json();
  if (moved) {
    expect(response.status, JSON.stringify(body)).toBe(409);
    expect(getLane(lane.id)?.status).toBe('reviewing');
    expect(getApproval(result.approvalId!)?.status).toBe('pending');
    expect(git(f.origin, 'show', 'main:file.txt')).toBe('base');
    return;
  }
  if (!direct) {
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ note: expect.stringContaining('PR-first project policy'), approval: { resolution: { continuationStatus: 'failed' } } });
    expect(git(f.origin, 'show', 'main:file.txt')).toBe('base');
    return;
  }
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body, JSON.stringify(body)).toMatchObject({ approval: { resolution: { continuationStatus: 'completed' } } });
  expect(getApproval(result.approvalId!)?.resolution).toMatchObject({ authorizingPrincipal: 'device', approvedHeadSha: f.sha });
  expect(git(f.origin, 'show', 'main:file.txt')).toBe('approved');
});

it('a valid device approval preserves PR-first without an operator opt-in', async () => {
  const f = await fixture(true, false);
  const response = await approve(f.approval.id);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ note: expect.stringContaining('PR-first project policy'), approval: { resolution: { continuationStatus: 'failed' } } });
  expect(git(f.origin, 'show', 'main:file.txt')).toBe('base');
});
