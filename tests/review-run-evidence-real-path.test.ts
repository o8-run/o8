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
  return { repo, origin, worktree, packetId, head, base, approvalId: approval.id, args };
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
it.each(['missing', 'stale'] as const)('real merge route refuses %s run evidence under a matching policy, including operator calls', async mode => {
  const f = await fixture();
  if (mode === 'stale') getSqlite()!.prepare('UPDATE approvals SET args_json = ? WHERE id = ?')
    .run(JSON.stringify({ ...f.args, runEvidence: evidence(f.base), reviewMode: 'run', verdictLabel: 'approved, run' }), f.approvalId);
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
  expect(payload.result).toMatchObject({ recorded: true, reviewMode: 'run', verdictLabel: 'approved, run', runEvidence: receipt });
  expect(getApproval(payload.result.auditApprovalId)?.args).toMatchObject({ runEvidence: receipt, reviewMode: 'run' });
  const state = await stateRoute.GET(request(`/api/orchestrator/review-state?packetId=${f.packetId}`));
  expect(await state.json()).toMatchObject({ orchestratorReview: { reviewMode: 'run', verdictLabel: 'approved, run', runEvidence: receipt } });
}, 30_000);
it.each(['malformed', 'stale'] as const)('POST review rejects a %s structured run claim instead of accepting prose as evidence', async mode => {
  const f = await fixture();
  const response = await reviewRoute.POST(request('/api/orchestrator/review', { packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head,
    runEvidence: mode === 'stale' ? evidence(f.base) : { status: 'run', result: 'I ran it successfully' }, clientMutationId: randomUUID() }));
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_run_evidence' } });
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
  expect((await previewPacketMerge(f.packetId)).checks).toContainEqual(expect.objectContaining({ name: 'review-run-evidence', verdict: 'pass' }));
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
    expect(response.status, JSON.stringify(runEvidence)).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_run_evidence' } });
  }
}, 30_000);
it('CLI and MCP submit and report the same structured review through owned HTTP routes', async () => {
  const f = await fixture();
  const { createServer } = await import('node:http');
  const lanesRoute = await import('@/app/api/lanes/route');
  const { runPacketReview } = await import('../cli/src/commands/packet/review');
  const { handleSubmitReview } = await import('@/lib/mcp/operator-handlers/mission');
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
    expect(payload).toContain('approved, run');
    stdout.mockClear();
    expect(await runPacketReview({ human: true, verbose: false }, [f.packetId, '--approve', '--expected-sha', f.head, '--not-run', 'Window driver unavailable.'])).toBe(0);
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('approved, not run');
    const response = await handleSubmitReview({ packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head, runEvidence: evidence(f.head) });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(JSON.stringify(response)).toContain('approved, run');
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
