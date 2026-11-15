import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, expect, it, vi } from 'vitest';

const root = mkdtempSync(join(tmpdir(), 'o8-decisions-'));
process.env.O8_DATA_DIR = root;
process.env.CORTEX_IDE_DATA_DIR = root;
const repoPath = join(root, 'repo');
mkdirSync(repoPath);
function git(...args: string[]) { return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim(); }
git('init', '-q', '-b', 'main');
writeFileSync(join(repoPath, 'fixture.txt'), 'fixture\n');
git('add', 'fixture.txt');
git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture');
const head = git('rev-parse', 'HEAD');
const registry = await import('@/lib/lane/registry');
const { closeDb, getSqlite } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
const lane = registry.createLane({ repoPath, worktreePath: repoPath, packetId: 'pkt-decision', branch: 'main', runtime: 'codex' });
registry.updateLane(lane.id, { status: 'awaiting_orchestrator' });
getSqlite().prepare(`INSERT INTO review_queue (id, lane_id, repo_path, status, attempts, head_sha) VALUES (?, ?, ?, 'failed', 5, ?)`)
  .run('review-decision', lane.id, repoPath, head);
registry.appendEvent(lane.id, 'review_queue_blocked', 'system', { reviewId: 'review-decision', attempts: 5 });
closeDb();
function request(token = getOrCreateWsToken(), query = '') {
  return new NextRequest(`http://localhost/api/panel/inbox/decisions${query}`, { headers: { host: 'localhost', authorization: `Bearer ${token}` } });
}
async function read(query = '') {
  const { matchNativeHttpRoute } = await import('@/lib/ws-server/native-http-registry');
  const match = matchNativeHttpRoute('/api/panel/inbox/decisions', 'GET');
  expect(match?.route.path).toBe('/api/panel/inbox/decisions');
  const handlers = await match!.route.load() as { GET: (req: NextRequest) => Promise<Response> };
  return handlers.GET(request(undefined, query));
}
afterAll(() => { vi.unstubAllGlobals(); closeDb(); rmSync(root, { recursive: true, force: true }); });

it('joins persisted failed review attempts into one stable decision through native HTTP', async () => {
  const before = getSqlite().prepare('SELECT COUNT(*) AS n FROM lane_events').get();
  const response = await read();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  const first = await response.json();
  expect(first.schema).toBe('o8/inbox-decisions/v1');
  expect(first.decisions).toHaveLength(1);
  expect(first.decisions[0]).toMatchObject({ laneId: lane.id, taskId: 'pkt-decision', headSha: head, phase: 'review', state: 'unresolved',
    attempts: { review: 5 }, primaryAction: { kind: 'human', method: 'GET' }, policy: { nextAction: { value: 'human' } },
    evidence: { diff: `/api/lanes/${lane.id}/diff`, activity: `/api/lanes/${lane.id}/events` } });
  expect(getSqlite().prepare('SELECT COUNT(*) AS n FROM lane_events').get()).toEqual(before);
  registry.appendEvent(lane.id, 'review_queue_blocked', 'system', { reviewId: 'review-decision', attempts: 5 });
  registry.appendEvent(lane.id, 'update', 'system');
  closeDb();
  const again = await (await read()).json();
  expect(again.decisions).toHaveLength(1);
  expect(again.decisions[0].id).toBe(first.decisions[0].id);
  expect(again.decisions[0].revisionToken).toBe(first.decisions[0].revisionToken);
});

it('serves the CLI and registered MCP tool through the same authenticated production route', async () => {
  process.env.O8_API_TOKEN = getOrCreateWsToken();
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const { matchNativeHttpRoute } = await import('@/lib/ws-server/native-http-registry');
    const match = matchNativeHttpRoute(new URL(String(input)).pathname, init?.method ?? 'GET');
    const handlers = await match!.route.load() as { GET: (req: NextRequest) => Promise<Response> };
    return handlers.GET(new NextRequest(String(input), { headers: init?.headers }));
  });
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    const { runInbox } = await import('../cli/src/commands/inbox');
    expect(await runInbox({ human: false, verbose: false }, 'decisions', [])).toBe(0);
    expect(output.mock.calls.some(([text]) => String(text).includes('o8/inbox-decisions/v1'))).toBe(true);
    const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
    const result = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_inbox_decisions', arguments: {} } });
    expect(JSON.stringify(result)).toContain('o8/inbox-decisions/v1');
    expect(await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_inbox_decisions', arguments: {} } }, 'devices')).toMatchObject({ result: { isError: true } });
  } finally { output.mockRestore(); vi.unstubAllGlobals(); delete process.env.O8_API_TOKEN; }
});

it('refuses workers before reading task state and rejects invalid filters', async () => {
  const { GET } = await import('@/app/api/panel/inbox/decisions/route');
  const lookup = vi.spyOn(registry, 'listLanes');
  expect((await GET(request(mintPacketWorkerToken('pkt-decision')))).status).toBe(403);
  expect(lookup).not.toHaveBeenCalled();
  lookup.mockRestore();
  expect((await read('?state=invalid')).status).toBe(400);
});

it('distinguishes a changed revision and settles a completed task in history', async () => {
  const first = (await (await read()).json()).decisions[0];
  writeFileSync(join(repoPath, 'fixture.txt'), 'changed\n');
  git('add', 'fixture.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'changed fixture');
  const next = (await (await read()).json()).decisions[0];
  expect(next.id).not.toBe(first.id);
  expect(next.headSha).toBe(git('rev-parse', 'HEAD'));
  registry.updateLane(lane.id, { status: 'completed', outcome: 'merged' });
  closeDb();
  expect((await (await read()).json()).decisions).toHaveLength(0);
  const history = (await (await read('?state=history')).json()).decisions;
  expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ taskId: 'pkt-decision', state: 'resolved' })]));
});


it('retains one uncertain delivery across replacement lanes and terminal state until reconciled', async () => {
  const { createProject } = await import('@/lib/projects/store');
  const project = createProject({ name: 'Uncertain decision fixture' });
  const original = registry.createLane({ projectId: project.id, repoPath, worktreePath: repoPath, packetId: 'pkt-uncertain', branch: 'main', runtime: 'codex' });
  registry.updateLane(original.id, { status: 'archived' });
  const replacement = registry.createLane({ projectId: project.id, repoPath, worktreePath: repoPath, packetId: 'pkt-uncertain', branch: 'main', runtime: 'codex' });
  registry.updateLane(replacement.id, { status: 'completed' });
  const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'mission-uncertain', repoPath, packets: [{
    id: 'pkt-uncertain', referenceLabel: 'uncertain', workspaceTargetPath: repoPath, branchTarget: 'main', title: 'Uncertain', summary: 'Uncertain', runtime: 'codex',
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued', releaseState: 'pending', status: 'awaiting_review',
    lane: { laneId: original.id, tileId: 'old-tile', tabId: 'old-tab', repoPath, runtime: 'codex' },
  }] });
  const db = getSqlite();
  db.prepare('INSERT INTO worker_corrections (id, repo_path, thread_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('correction-uncertain', repoPath, 'thread-uncertain', '{}', Date.now());
  db.prepare('INSERT INTO worker_correction_deliveries (correction_id, surface_id, run_id, status, note, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('correction-uncertain', 'surface-uncertain', 'run-uncertain', 'unknown', 'Unconfirmed', Date.now());
  db.prepare('INSERT INTO correction_reviews (correction_id, lane_id, packet_id, source_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('correction-uncertain', original.id, 'pkt-uncertain', '{}', Date.now());
  closeDb();
  const query = `?projectId=${project.id}`;
  const value = (await (await read(query)).json()).decisions;
  expect(value).toHaveLength(1);
  expect(value[0]).toMatchObject({ laneId: replacement.id, uncertain: true, state: 'unresolved', primaryAction: { kind: 'human',
    path: '/api/orchestrator/worker-corrections?packetId=pkt-uncertain' } });
  getSqlite().prepare("UPDATE worker_correction_deliveries SET status = 'delivered' WHERE correction_id = ?").run('correction-uncertain');
  closeDb();
  expect((await (await read(query)).json()).decisions).toHaveLength(0);
  expect((await (await read(query + '&state=history')).json()).decisions).toEqual([expect.objectContaining({ state: 'resolved', primaryAction: null })]);
});

it('projects all three policy actions, new findings and cursor pages without dispatching work', async () => {
  const { createProject } = await import('@/lib/projects/store');
  const { PATCH } = await import('@/app/api/projects/[id]/route');
  const { createApproval, resolveApproval } = await import('@/lib/approvals/store');
  const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  const project = createProject({ name: 'Ready decision fixture' });
  expect((await PATCH(new NextRequest(`http://localhost/api/projects/${project.id}`, { method: 'PATCH',
    headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}` }, body: JSON.stringify({ mergeMode: 'direct' }),
  }), { params: Promise.resolve({ id: project.id }) })).status).toBe(200);
  const ready = registry.createLane({ projectId: project.id, repoPath, worktreePath: repoPath, packetId: 'pkt-ready', branch: 'main', runtime: 'codex' });
  registry.updateLane(ready.id, { status: 'reviewing', sessionKey: 'session-ready' });
  const currentHead = git('rev-parse', 'HEAD');
  registry.appendEvent(ready.id, 'review_risk_classified', 'system', { reviewedHeadSha: currentHead, tier: 'standard', reasons: [], responsibleFiles: [],
    diffBase: { comparisonRef: currentHead, mergeBase: currentHead, usedFallback: false, warning: null } });
  const packet = { id: 'pkt-ready', referenceLabel: 'ready', workspaceTargetPath: repoPath, branchTarget: 'main', title: 'Ready', summary: 'Ready', runtime: 'codex' as const,
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued' as const, releaseState: 'pending' as const, status: 'awaiting_review' as const, lane: null };
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'mission-ready', repoPath, packets: [packet] });
  const approval = createApproval({ source: 'test', runtime: 'codex', agent: 'Test', sessionKey: 'session-ready', title: 'Ready', description: 'Reviewed fixture', summary: 'Reviewed fixture',
    risk: 'low', toolName: 'orchestrator_review', args: { packetId: packet.id, approved: true, reviewedHeadSha: currentHead, reviewTurnId: 'review-ready', reviewTurnOutcome: 'completed' },
    metadata: { Packet: packet.id, laneId: ready.id } });
  resolveApproval(approval.id, 'approve', 'test');
  writeFileSync(join(root, 'settings.toml'), '[review]\nrequire_approval = "never"\n');
  const query = `?projectId=${project.id}`;
  let decision = (await (await read(query)).json()).decisions[0];
  expect(decision.primaryAction.kind).toBe('prepare_pull_request');
  writeFileSync(join(root, 'settings.toml'), '[review]\nrequire_approval = "always"\n');
  decision = (await (await read(query)).json()).decisions[0];
  expect(decision.primaryAction).toMatchObject({ kind: 'approval_required', path: '/api/panel/approvals?status=pending' });
  const before = decision.revisionToken;
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'mission-ready', repoPath, packets: [{ ...packet, mergeHold: true }] });
  decision = (await (await read(query)).json()).decisions[0];
  expect(decision.primaryAction.kind).toBe('human');
  expect(decision.revisionToken).not.toBe(before);
  const previousToken = decision.revisionToken;
  const previousId = decision.id;
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'mission-ready', repoPath, packets: [{ ...packet, mergeHold: true,
    review: { approved: false, reviewedHeadSha: currentHead, recordedAt: new Date().toISOString(), summary: 'New finding',
      findings: [{ file: 'fixture.txt', line: 1, severity: 'warning', description: 'Inspect fixture', resolution: 'deferred' }] },
  }] });
  const finding = (await (await read(query)).json()).decisions[0];
  expect(finding.id).toBe(previousId);
  expect(finding.revisionToken).not.toBe(previousToken);
  expect(finding.review.findings).toBe(1);
  const page = await (await read('?state=all&limit=1')).json();
  expect(page.nextCursor).toEqual(expect.any(String));
  const next = await (await read(`?state=all&limit=1&cursor=${page.nextCursor}`)).json();
  expect(next.decisions.every((item: { laneId: string }) => item.laneId > page.nextCursor)).toBe(true);
  const irrelevant = registry.createLane({ projectId: project.id, repoPath, worktreePath: repoPath, branch: 'main', runtime: 'codex' });
  registry.updateLane(irrelevant.id, { status: 'awaiting_orchestrator' });
  expect((await (await read(query)).json()).decisions).toHaveLength(1);
});


it('keeps paused, failed and recovering reviews actionable and completed supersession visible during progress', async () => {
  const { createProject } = await import('@/lib/projects/store');
  const { settleSupersededReviewAttempts } = await import('@/lib/lane/review-attempt-head');
  const project = createProject({ name: 'Superseded review fixture' });
  const current = registry.createLane({ projectId: project.id, repoPath, worktreePath: repoPath, packetId: 'pkt-superseded', branch: 'main', runtime: 'codex' });
  const oldHead = 'a'.repeat(40);
  getSqlite().prepare("INSERT INTO review_queue (id, lane_id, repo_path, status, attempts, head_sha) VALUES (?, ?, ?, 'pending', 2, ?)")
    .run('review-superseded', current.id, repoPath, oldHead);
  expect(settleSupersededReviewAttempts({ lane: current, currentHeadSha: git('rev-parse', 'HEAD'), reason: 'Revision changed' })).toBe(1);
  const query = `?projectId=${project.id}`;
  for (const status of ['paused', 'failed', 'recovering'] as const) {
    registry.updateLane(current.id, { status });
    closeDb();
    expect((await (await read(query)).json()).decisions).toEqual([expect.objectContaining({ state: 'unresolved', primaryAction: { kind: 'human', label: expect.any(String), method: 'GET', path: expect.any(String), consequence: expect.any(String) } })]);
  }
  const manual = registry.appendEvent(current.id, 'review_recorded', 'orchestrator', { reviewedHeadSha: 'b'.repeat(40), approved: false });
  registry.updateLane(current.id, { status: 'running' });
  closeDb();
  expect((await (await read(query)).json()).decisions).toHaveLength(0);
  const history = (await (await read(query + '&state=history')).json()).decisions;
  expect(history).toEqual([
    expect.objectContaining({ state: 'superseded', headSha: oldHead, policy: null, review: null, responsibleAgent: null,
      priorAttempts: { reviews: [expect.objectContaining({ id: 'review-superseded', status: 'completed' })], corrections: [] } }),
    expect.objectContaining({ state: 'superseded', headSha: 'b'.repeat(40), primaryAction: null,
      priorAttempts: { reviews: [expect.objectContaining({ id: manual.id, status: 'recorded' })], corrections: [] } }),
  ]);
  getSqlite().prepare("INSERT INTO review_queue (id, lane_id, repo_path, status, attempts, head_sha) VALUES (?, ?, ?, 'pending', 0, ?)")
    .run('review-current-pending', current.id, repoPath, git('rev-parse', 'HEAD'));
  registry.updateLane(current.id, { status: 'reviewing' });
  expect((await (await read(query)).json()).decisions).toHaveLength(0);
  process.env.O8_REVIEW_MODE = 'manual';
  try { expect((await (await read(query)).json()).decisions).toHaveLength(1); }
  finally { delete process.env.O8_REVIEW_MODE; }
  const insert = getSqlite().prepare("INSERT INTO review_queue (id, lane_id, repo_path, status, attempts, head_sha) VALUES (?, ?, ?, 'completed', 1, ?)");
  for (let index = 1; index <= 12; index++) insert.run(`old-review-${index}`, current.id, repoPath, index.toString(16).padStart(40, '0'));
  const bounded = (await (await read(query + '&state=history&limit=1')).json()).decisions;
  expect(bounded).toHaveLength(10);
  expect(bounded.every((item: { historyTruncated: boolean }) => item.historyTruncated)).toBe(true);
});
