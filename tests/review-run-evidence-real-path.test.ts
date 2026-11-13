import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
const { createLane } = await import('@/lib/lane/registry');
const { recordOrchestratorReview, getApproval, listApprovalsForContext } = await import('@/lib/approvals/store');
const { getSqlite } = await import('@/lib/db');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { addRepo } = await import('@/lib/repos/registry');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const mergeRoute = await import('@/app/api/orchestrator/merge/route');
const reviewRoute = await import('@/app/api/orchestrator/review/route');
const stateRoute = await import('@/app/api/orchestrator/review-state/route');
const lanesRoute = await import('@/app/api/lanes/route');
const { runPacketReview } = await import('../cli/src/commands/packet/review');
const { handleSubmitReview } = await import('@/lib/mcp/operator-handlers/mission');
const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
afterEach(() => vi.unstubAllEnvs());
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-run-review-')); roots.push(root);
  const repo = join(root, 'repo'); const origin = join(root, 'origin.git');
  mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'o8 test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  mkdirSync(join(repo, 'native/o8-next/src'), { recursive: true });
  writeFileSync(join(repo, 'native/o8-next/src/fixture.rs'), '// original\n');
  writeFileSync(join(repo, 'base.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const packetId = `run-evidence-${randomUUID()}`; const branch = `fixture/${packetId}`;
  const { path: worktree } = await getWorktreeManager(repo).create({ agentType: 'codex', taskName: packetId, packetId,
    branchName: branch, baseBranch: 'main', skipSetup: true, isolationPreference: 'git-worktree' });
  mkdirSync(join(worktree, 'native/o8-next/src'), { recursive: true });
  writeFileSync(join(worktree, 'native/o8-next/src/fixture.rs'), '// fixture\n');
  git(worktree, 'add', '.'); git(worktree, 'commit', '-qm', 'change');
  const head = git(worktree, 'rev-parse', 'HEAD');
  await addRepo(repo);
  const lane = createLane({ repoPath: repo, worktreePath: worktree, branch, baseBranch: 'main', runtime: 'codex', packetId,
    label: 'Run evidence fixture', sessionKey: `codex:${packetId}` });
  recordOrchestratorReview(packetId, { approved: true, findings: [], reviewer: 'codex', reviewedHeadSha: head, requiresSecondPass: false });
  const approval = listApprovalsForContext({ packetId, laneId: lane.id }).find(a => a.toolName === 'orchestrator_review')!;
  // Literal old saved JSON: no evidence/mode/label, even after new writers start adding them.
  const args = { packetId, approved: true, findings: [], reviewedHeadSha: head, reviewTurnOutcome: 'completed', requiresSecondPass: false };
  getSqlite()!.prepare('UPDATE approvals SET args_json = ? WHERE id = ?').run(JSON.stringify(args), approval.id);
  return { repo, origin, worktree, packetId, head, base, lane, approvalId: approval.id, args };
}
function request(path: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, { method: body ? 'POST' : 'GET',
    headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
function evidence(headSha: string) {
  return { status: 'run', headSha, reviewerRuntime: 'codex', recordedAt: new Date().toISOString(),
    observations: [{ kind: 'command', command: 'node --version', result: 'Node version printed', exitCode: 0, excerpt: 'v22.0.0' }] };
}
it('reads a literal old saved approval as approved, not run in storage and native review data', async () => {
  const f = await fixture();
  expect(getApproval(f.approvalId)?.args).toMatchObject({ reviewMode: 'read_only', verdictLabel: 'approved, not run', runEvidence: { status: 'not_run' } });
  const state = await stateRoute.GET(request(`/api/orchestrator/review-state?packetId=${f.packetId}`));
  expect(state.status).toBe(200);
  expect(await state.json()).toMatchObject({ orchestratorReview: { verdict: 'approved', verdictLabel: 'approved, not run', reviewMode: 'read_only' } });
});
it.each(['missing', 'stale', 'unattributed'] as const)('real merge route refuses %s run evidence under a matching policy, including operator calls', async mode => {
  const f = await fixture();
  if (mode !== 'missing') getSqlite()!.prepare('UPDATE approvals SET args_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...f.args, runEvidence: evidence(mode === 'stale' ? f.base : f.head), reviewMode: 'run', verdictLabel: 'approved, run (reviewer-reported)' }), f.approvalId);
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', '["native/o8-next/src/**"]');
  const response = await mergeRoute.POST(request('/api/orchestrator/merge', { packetId: f.packetId, expectedHeadSha: f.head, idempotencyKey: randomUUID() }));
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'review_run_evidence_required' } });
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.base);
  expect(git(f.origin, 'rev-parse', 'main')).toBe(f.base);
}, 30_000);
it('records well-formed current-head evidence through POST review and exposes approved, run', async () => {
  const f = await fixture();
  const receipt = evidence(f.head);
  const response = await reviewRoute.POST(request('/api/orchestrator/review', { packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head,
    runEvidence: receipt, clientMutationId: randomUUID() }));
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.result).toMatchObject({ recorded: true, reviewMode: 'run', verdictLabel: 'approved, run (reviewer-reported)', runEvidence: receipt });
  expect(getApproval(payload.result.auditApprovalId)?.args).toMatchObject({ runEvidence: receipt, reviewMode: 'run' });
  const state = await stateRoute.GET(request(`/api/orchestrator/review-state?packetId=${f.packetId}`));
  expect(await state.json()).toMatchObject({ orchestratorReview: { reviewMode: 'run', verdictLabel: 'approved, run (reviewer-reported)', runEvidence: receipt } });
}, 30_000);
it.each(['malformed', 'stale'] as const)('POST review preserves the approval but downgrades a %s run claim with a warning', async mode => {
  const f = await fixture();
  const response = await reviewRoute.POST(request('/api/orchestrator/review', { packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head,
    runEvidence: mode === 'stale' ? evidence(f.base) : { status: 'run', result: 'I ran it successfully' }, clientMutationId: randomUUID() }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ result: { recorded: true, reviewMode: 'read_only', runEvidenceWarning: expect.any(String), runEvidence: { status: 'not_run' } } });
});
it('matching current-head evidence clears preview; off and nonmatching policies preserve read-only approvals', async () => {
  const f = await fixture();
  const { previewPacketMerge } = await import('@/lib/lane/preview-merge');
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', '["native/o8-next/src/**"]');
  const blocked = await previewPacketMerge(f.packetId);
  expect(blocked.wouldMerge).toBe(false);
  expect(blocked.checks).toContainEqual(expect.objectContaining({ name: 'review_run_evidence_required', verdict: 'fail' }));
  const receipt = evidence(f.head);
  const result = await reviewRoute.POST(request('/api/orchestrator/review', { packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head,
    runEvidence: receipt, clientMutationId: randomUUID() }));
  expect(result.status).toBe(200);
  expect((await previewPacketMerge(f.packetId)).checks).toContainEqual(expect.objectContaining({ name: 'review-run-evidence', verdict: 'pass' }));
  await reviewRoute.POST(request('/api/orchestrator/review', { packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head,
    runEvidence: { status: 'not_run', reason: 'No execution on this pass.' }, clientMutationId: randomUUID() }));
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', '["docs/**"]');
  expect((await previewPacketMerge(f.packetId)).checks).toContainEqual(expect.objectContaining({ name: 'review-run-evidence', verdict: 'pass' }));
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', '[]');
  expect((await previewPacketMerge(f.packetId)).checks).not.toContainEqual(expect.objectContaining({ name: 'review-run-evidence' }));
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', 'not JSON');
  const invalid = await mergeRoute.POST(request('/api/orchestrator/merge', { packetId: f.packetId, expectedHeadSha: f.head, idempotencyKey: randomUUID() }));
  expect(invalid.status).toBe(409);
  expect(await invalid.json()).toMatchObject({ error: { code: 'review_run_policy_invalid' } });
}, 30_000);
it('rejects incomplete or unbounded observations through the review route', async () => {
  const f = await fixture();
  const valid = evidence(f.head);
  const invalid: unknown[] = [
    { ...valid, reviewerRuntime: '' }, { ...valid, recordedAt: 'yesterday' }, { ...valid, recordedAt: '2026-11-13T00:00:00' }, { ...valid, headSha: f.head.slice(0, 8) },
    { ...valid, observations: [] }, { ...valid, observations: [{ ...valid.observations[0], exitCode: null }] },
    { ...valid, observations: [{ kind: 'launch', command: 'launch fixture', result: 'Rendered', exitCode: null }] },
    { ...valid, observations: [{ ...valid.observations[0], excerpt: 'x'.repeat(4001) }] }, { status: 'not_run', reason: '' },
  ];
  for (const runEvidence of invalid) {
    const response = await reviewRoute.POST(request('/api/orchestrator/review', { packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head, runEvidence, clientMutationId: randomUUID() }));
    expect(response.status, JSON.stringify(runEvidence)).toBe(200);
    expect(await response.json()).toMatchObject({ result: { reviewMode: 'read_only', runEvidenceWarning: expect.any(String) } });
  }
}, 30_000);
it('CLI and MCP submit and report the same structured review through owned HTTP routes', async () => {
  const f = await fixture();
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const input = new NextRequest(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}) });
      const response = req.url?.startsWith('/api/lanes') ? await lanesRoute.GET(input)
        : req.url === '/api/orchestrator/review' ? await reviewRoute.POST(input)
        : req.url === '/api/orchestrator/merge' ? await mergeRoute.POST(input) : new Response('Unknown route', { status: 404 });
      res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(await response.text());
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture address');
  vi.stubEnv('O8_API_PORT', String(address.port)); vi.stubEnv('O8_WS_PORT', String(address.port)); vi.stubEnv('O8_API_TOKEN', getOrCreateWsToken());
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const path = join(f.repo, 'receipt.json'); writeFileSync(path, JSON.stringify(evidence(f.head)));
    expect(await runPacketReview({ human: false, verbose: false }, [f.packetId, '--approve', '--expected-sha', f.head, '--run-evidence', path])).toBe(0);
    const payload = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(payload).toContain('approved, run (reviewer-reported)');
    stdout.mockClear();
    expect(await runPacketReview({ human: true, verbose: false }, [f.packetId, '--approve', '--expected-sha', f.head, '--not-run', 'Window driver unavailable.'])).toBe(0);
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('approved, not run');
    const response = await handleSubmitReview({ packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head, runEvidence: evidence(f.head) });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(JSON.stringify(response)).toContain('approved, run (reviewer-reported)');
    for (const claim of [{ status: 'run', result: 'prose' }, evidence(f.base)]) {
      const downgraded = await handleSubmitReview({ packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head, runEvidence: claim });
      expect(downgraded.isError, JSON.stringify(downgraded)).not.toBe(true);
      expect(JSON.stringify(downgraded)).toContain('approved, not run');
      expect(JSON.stringify(downgraded)).toContain('runEvidenceWarning');
    }
    const token = 'sk-' + 'y'.repeat(48);
    const secretReceipt = evidence(f.head);
    secretReceipt.observations[0].excerpt = token;
    const safe = await handleSubmitReview({ packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head, runEvidence: secretReceipt });
    expect(safe.isError, JSON.stringify(safe)).not.toBe(true);
    expect(JSON.stringify(safe)).not.toContain(token);
  } finally { stdout.mockRestore(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}, 30_000);

it('a rename out of a required path still requires evidence, even with a newline in its new name', async () => {
  const f = await fixture();
  git(f.worktree, 'mv', 'native/o8-next/src/fixture.rs', 'renamed\nfixture.rs');
  git(f.worktree, 'commit', '-qm', 'rename');
  const head = git(f.worktree, 'rev-parse', 'HEAD');
  recordOrchestratorReview(f.packetId, { approved: true, findings: [], reviewer: 'codex', reviewedHeadSha: head, requiresSecondPass: false });
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', '["native/o8-next/src/**"]');
  const response = await mergeRoute.POST(request('/api/orchestrator/merge', { packetId: f.packetId, expectedHeadSha: head, idempotencyKey: randomUUID() }));
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'review_run_evidence_required' } });
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.base);
}, 30_000);

it('refuses a dirty operator candidate before any merge-time commit', async () => {
  const f = await fixture();
  git(f.worktree, 'reset', '--hard', f.base);
  writeFileSync(join(f.worktree, 'base.txt'), 'ordinary committed change\n');
  git(f.worktree, 'add', '.'); git(f.worktree, 'commit', '-qm', 'ordinary change');
  const head = git(f.worktree, 'rev-parse', 'HEAD');
  // No pinned review. Protected work exists only in the dirty tree.
  getSqlite().prepare('DELETE FROM approvals WHERE id = ?').run(f.approvalId);
  writeFileSync(join(f.worktree, 'native/o8-next/src/fixture.rs'), '// pending protected change\n');
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', '["native/o8-next/src/**"]');
  const response = await mergeRoute.POST(request('/api/orchestrator/merge', { packetId: f.packetId, expectedHeadSha: head, commitMessage: 'operator snapshot', idempotencyKey: randomUUID() }));
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'review_run_candidate_unavailable' } });
  expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.base);
}, 30_000);
it('redacts evidence before durable review storage and review-state output', async () => {
  const f = await fixture();
  const token = 'sk-' + 'x'.repeat(48);
  const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  const { withControlPlaneLock, writeOrchestratorControlPlaneState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  await withControlPlaneLock(() => writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: `mission-${randomUUID()}`, repoPath: f.repo,
    packets: [{ id: f.packetId, title: 'Run evidence fixture', runtime: 'codex', status: 'queued', queueState: 'held', holdIntent: 'explicit-dispatch', releaseState: 'pending',
      workspaceTargetPath: f.worktree, branchTarget: f.lane.branch } as import('@/lib/orchestrator/types').OrchestratorPacket] }));
  const receipt = evidence(f.head);
  receipt.observations[0] = { ...receipt.observations[0], command: `echo ${token}`, result: token, excerpt: token };
  const response = await reviewRoute.POST(request('/api/orchestrator/review', { packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head, runEvidence: receipt, clientMutationId: randomUUID() }));
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(JSON.stringify(payload)).not.toContain(token);
  const raw = getSqlite().prepare('SELECT args_json, audit_json FROM approvals WHERE id = ?').get(payload.result.auditApprovalId);
  expect(JSON.stringify(raw)).not.toContain(token);
  expect(JSON.stringify(readOrchestratorControlPlaneState().packets.find(p => p.id === f.packetId)?.review)).not.toContain(token);
  const { getLaneEvents } = await import('@/lib/lane/registry');
  expect(JSON.stringify(getLaneEvents(f.lane.id))).not.toContain(token);
  const { getMissionStatus } = await import('@/lib/orchestrator/operator-mission-service');
  expect(JSON.stringify(await getMissionStatus({ includeCost: false }))).not.toContain(token);
  const state = await stateRoute.GET(request(`/api/orchestrator/review-state?packetId=${f.packetId}`));
  expect(await state.text()).not.toContain(token);
}, 30_000);

it('successfully merges through the real merge route with current operator evidence and policy on', async () => {
  const f = await fixture();
  const reviewed = await reviewRoute.POST(request('/api/orchestrator/review', { packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head, runEvidence: evidence(f.head), clientMutationId: randomUUID() }));
  expect(reviewed.status).toBe(200);
  const review = (await reviewed.json()).result;
  expect(review.runEvidence.principal).toEqual({ role: 'operator', source: 'authenticated_operator' });
  // The isolated fixture's one-file change has no second pass requirement.
  expect(getApproval(review.auditApprovalId)?.args?.requiresSecondPass).toBe(false);
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', '["native/o8-next/src/**"]');
  const response = await mergeRoute.POST(request('/api/orchestrator/merge', { packetId: f.packetId, expectedHeadSha: f.head, idempotencyKey: randomUUID() }));
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ result: { merged: true } });
  expect(git(f.repo, 'show', 'main:native/o8-next/src/fixture.rs')).toBe('// fixture');
  expect(git(f.origin, 'rev-parse', 'main')).toBe(git(f.repo, 'rev-parse', 'main'));
}, 30_000);
it('matches required paths regardless of case and separator and publishes the policy source', async () => {
  const f = await fixture();
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', JSON.stringify(['NATIVE\\O8-NEXT\\SRC\\**']));
  const state = await stateRoute.GET(request(`/api/orchestrator/review-state?packetId=${f.packetId}`));
  expect(await state.json()).toMatchObject({ reviewRunPolicy: { enabled: true, valid: true, source: 'environment:O8_REVIEW_RUN_REQUIRED_PATHS', paths: ['NATIVE/O8-NEXT/SRC/**'] } });
  const { previewPacketMerge } = await import('@/lib/lane/preview-merge');
  expect(await previewPacketMerge(f.packetId)).toMatchObject({ reviewRunPolicy: { enabled: true, source: 'environment:O8_REVIEW_RUN_REQUIRED_PATHS' } });
  const response = await mergeRoute.POST(request('/api/orchestrator/merge', { packetId: f.packetId, expectedHeadSha: f.head, idempotencyKey: randomUUID() }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: 'review_run_evidence_required' } });
}, 30_000);
it.each(['valid', 'malformed', 'stale', 'unassigned'] as const)('records a Codex fallback verdict with %s runEvidence without changing the code verdict', async kind => {
  const f = await fixture();
  const { startReviewTurn, finishReviewTurn } = await import('@/lib/lane/review-turn-state');
  const { recordCodexAutoReviewVerdict } = await import('@/lib/lane/codex-auto-review-verdict');
  const turn = startReviewTurn({ laneId: f.lane.id, threadId: `review-fallback-${randomUUID()}`, backend: 'codex', surface: 'auto-review', expectedHeadSha: f.head });
  finishReviewTurn({ laneId: f.lane.id, reviewTurnId: turn, outcome: 'completed' });
  const result = await recordCodexAutoReviewVerdict({ lane: f.lane, requiresSecondPass: false, reviewTurnId: kind === 'unassigned' ? `unknown-${randomUUID()}` : turn, expectedHeadSha: f.head,
    rawText: 'CODEX_AUTO_REVIEW: ' + JSON.stringify({ approved: true, findings: [], runEvidence: kind === 'malformed' ? { status: 'run', result: 'prose only' } : evidence(kind === 'stale' ? f.base : f.head) }) });
  expect(result).toMatchObject({ reviewUnavailable: false, verdict: { approved: true } });
  const approval = listApprovalsForContext({ packetId: f.packetId }).filter(a => a.toolName === 'orchestrator_review').sort((a,b) => b.updatedAt - a.updatedAt)[0]!;
  expect(approval.status).toBe('approved');
  if (kind === 'valid') expect(approval.args).toMatchObject({ reviewMode: 'run', verdictLabel: 'approved, run (reviewer-reported)', runEvidence: { principal: { role: 'assigned_reviewer', source: 'server_review_turn', packetId: f.packetId, reviewTurnId: turn } } });
  else expect(approval.args).toMatchObject({ reviewMode: 'read_only', runEvidenceWarning: expect.any(String) });
}, 30_000);
it('policy checks the fetched remote-customer candidate instead of the canonical checkout', async () => {
  const f = await fixture();
  const { mintPacketWorkerToken, resolvePacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
  const token = resolvePacketWorkerToken(mintPacketWorkerToken(f.packetId))!;
  const branch = `remote/${randomUUID()}`;
  git(f.worktree, 'push', 'origin', `HEAD:refs/heads/${branch}`);
  getSqlite().prepare('UPDATE lanes SET runtime = ?, worktree_path = NULL, packet_id = NULL WHERE id = ?').run('remote-customer', f.lane.id);
  getSqlite().prepare('INSERT INTO worker_runs (id, lane_id, worker_token_id, transport, status, remote_branch, started_at, last_event_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), f.lane.id, token.tokenId, 'fixture', 'completed', branch, new Date().toISOString(), new Date().toISOString());
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', '["native/o8-next/src/**"]');
  const { POST } = await import('@/app/api/lanes/route');
  const response = await POST(request('/api/lanes', { verb: 'merge', laneId: f.lane.id }));
  expect(response.status, await response.clone().text()).toBe(409);
  expect(await response.json()).toMatchObject({ ok: false, reason: 'review_run_evidence_required' });
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.base);
  expect(git(f.origin, 'rev-parse', 'main')).toBe(f.base);
}, 30_000);
it('refuses a spoken snapshot with dirty edits under policy before committing it', async () => {
  const f = await fixture();
  git(f.worktree, 'reset', '--hard', f.base);
  writeFileSync(join(f.worktree, 'base.txt'), 'ordinary committed change\n'); git(f.worktree, 'add', '.'); git(f.worktree, 'commit', '-qm', 'ordinary change');
  const head = git(f.worktree, 'rev-parse', 'HEAD');
  getSqlite().prepare('DELETE FROM approvals WHERE id = ?').run(f.approvalId);
  writeFileSync(join(f.worktree, 'native/o8-next/src/fixture.rs'), '// spoken pending edit\n');
  const { createApproval } = await import('@/lib/approvals/store');
  const { POST } = await import('@/app/api/panel/approvals/route');
  const card = createApproval({ source: 'test', runtime: 'codex', agent: 'fixture', sessionKey: f.lane.sessionKey!, title: 'Merge fixture', description: 'Fixture merge', summary: '', risk: 'low',
    continuation: { kind: 'lane', laneId: f.lane.id, verb: 'merge', commitMessage: 'spoken fixture snapshot' } });
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', '["native/o8-next/src/**"]');
  const state = await stateRoute.GET(request(`/api/orchestrator/review-state?packetId=${f.packetId}&spoken=1&approvalId=${card.id}`));
  expect(state.status, await state.clone().text()).toBe(200);
  const receipt = (await state.json()).spokenReview.evidence;
  const response = await POST(request('/api/panel/approvals', { action: 'approve', id: card.id, spokenReviewEvidence: { approvalId: card.id, packetId: f.packetId,
    reviewedHeadSha: receipt.headSha, reviewedDiffFingerprint: receipt.fingerprint, reviewedGovernanceFingerprint: receipt.governanceFingerprint } }));
  const body = await response.json();
  expect(response.status).toBe(409);
  expect(body).toMatchObject({ ok: false, code: 'review_run_candidate_unavailable', approval: { status: 'pending' } });
  expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.base);
}, 30_000);

it.each(['on', 'off'])('reports a missing remote branch accurately with policy %s', async mode => {
  const f = await fixture();
  getSqlite().prepare('UPDATE lanes SET runtime = ?, worktree_path = NULL, packet_id = NULL WHERE id = ?').run('remote-customer', f.lane.id);
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', mode === 'on' ? '["native/o8-next/src/**"]' : '[]');
  const { POST } = await import('@/app/api/lanes/route');
  const response = await POST(request('/api/lanes', { verb: 'merge', laneId: f.lane.id }));
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ ok: false, reason: 'remote_branch_missing' });
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.base);
}, 30_000);

it('keeps the existing head-integrity refusal when a tip advances beyond a run-approved commit', async () => {
  const f = await fixture();
  const reviewed = await reviewRoute.POST(request('/api/orchestrator/review', { packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head, runEvidence: evidence(f.head), clientMutationId: randomUUID() }));
  expect(reviewed.status).toBe(200);
  writeFileSync(join(f.worktree, 'base.txt'), 'advanced tip\n');
  git(f.worktree, 'add', '.'); git(f.worktree, 'commit', '-qm', 'advance tip');
  const tip = git(f.worktree, 'rev-parse', 'HEAD');
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', '["native/o8-next/src/**"]');
  const { POST } = await import('@/app/api/lanes/route');
  const response = await POST(request('/api/lanes', { verb: 'merge', laneId: f.lane.id }));
  expect(response.status, await response.clone().text()).toBe(422);
  expect(await response.json()).toMatchObject({ ok: false, reason: 'head_moved_since_review', reviewedHeadSha: f.head, currentHeadSha: tip });
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.base);
  expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(tip);
}, 30_000);
it('checks the resolved spoken snapshot even when its SHA differs from the tip', async () => {
  const f = await fixture();
  // The later tip has no protected diff; reading it instead of the resolved snapshot would pass policy.
  const tip = git(f.worktree, 'commit-tree', `${f.base}^{tree}`, '-p', f.head, '-m', 'concurrent tip');
  expect(tip).not.toBe(f.head);
  expect(git(f.worktree, 'diff', '--name-only', `${f.base}..${tip}`)).toBe('');
  const { createApproval } = await import('@/lib/approvals/store');
  const { POST } = await import('@/app/api/panel/approvals/route');
  const card = createApproval({ source: 'test', runtime: 'codex', agent: 'fixture', sessionKey: f.lane.sessionKey!, title: 'Merge fixture', description: 'Fixture merge', summary: '', risk: 'low',
    continuation: { kind: 'lane', laneId: f.lane.id, verb: 'merge' } });
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', '["native/o8-next/src/**"]');
  const state = await stateRoute.GET(request(`/api/orchestrator/review-state?packetId=${f.packetId}&spoken=1&approvalId=${card.id}`));
  expect(state.status, await state.clone().text()).toBe(200);
  const receipt = (await state.json()).spokenReview.evidence;
  const snapshot = await import('@/lib/lane/spoken-review-snapshot');
  const resolveSnapshot = snapshot.resolveSpokenReviewSnapshotSha;
  // Run the real resolver, then schedule a real concurrent Git update before its caller resumes.
  const moved = vi.spyOn(snapshot, 'resolveSpokenReviewSnapshotSha').mockImplementationOnce(async input => {
    const sha = await resolveSnapshot(input);
    expect(sha).toBe(f.head);
    git(f.worktree, 'reset', '--hard', tip);
    return sha;
  });
  try {
    const response = await POST(request('/api/panel/approvals', { action: 'approve', id: card.id, spokenReviewEvidence: { approvalId: card.id, packetId: f.packetId,
      reviewedHeadSha: receipt.headSha, reviewedDiffFingerprint: receipt.fingerprint, reviewedGovernanceFingerprint: receipt.governanceFingerprint } }));
    expect(moved).toHaveBeenCalledTimes(1);
    expect(response.status, await response.clone().text()).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: 'review_run_evidence_required', approval: { status: 'pending' } });
    expect(body.error).toContain(f.head);
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(tip);
    expect(git(f.repo, 'rev-parse', 'main')).toBe(f.base);
    expect(git(f.origin, 'rev-parse', 'main')).toBe(f.base);
  } finally { moved.mockRestore(); }
}, 30_000);
it.each(['on', 'off'])('reports an ordinary remote fetch failure accurately with policy %s', async mode => {
  const f = await fixture();
  const { mintPacketWorkerToken, resolvePacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
  const token = resolvePacketWorkerToken(mintPacketWorkerToken(f.packetId))!;
  getSqlite().prepare('UPDATE lanes SET runtime = ?, worktree_path = NULL, packet_id = NULL WHERE id = ?').run('remote-customer', f.lane.id);
  getSqlite().prepare('INSERT INTO worker_runs (id, lane_id, worker_token_id, transport, status, remote_branch, started_at, last_event_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), f.lane.id, token.tokenId, 'fixture', 'completed', `missing/${randomUUID()}`, new Date().toISOString(), new Date().toISOString());
  vi.stubEnv('O8_REVIEW_RUN_REQUIRED_PATHS', mode === 'on' ? '["native/o8-next/src/**"]' : '[]');
  const { POST } = await import('@/app/api/lanes/route');
  const response = await POST(request('/api/lanes', { verb: 'merge', laneId: f.lane.id }));
  expect(response.status, await response.clone().text()).toBe(422);
  const body = await response.json();
  expect(body).toMatchObject({ ok: false, reason: 'remote_fetch_failed' });
  expect(body.note).toContain('Failed to fetch remote branch');
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.base);
  expect(git(f.origin, 'rev-parse', 'main')).toBe(f.base);
}, 30_000);
