import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ORCHESTRATOR_RUNTIME_IDS } from '@/lib/orchestrator/runtime-capabilities';

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => true), publishCortexChange: vi.fn(async () => {}) }));
vi.mock('@/lib/codebase-memory/client', () => ({ extractGraphResolvedSymbols: vi.fn(async () => ({ edges: [], unavailable: true })) }));

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-review-reuse-')));
const repo = join(root, 'repo');
const runtime = ORCHESTRATOR_RUNTIME_IDS[0];
const area = 'src/cache/read.ts';
const observation = 'Cache reads must preserve the project boundary.';
mkdirSync(join(repo, 'src/cache'), { recursive: true });
for (const [key, value] of Object.entries({ O8_DATA_DIR: join(root, 'data'), CORTEX_IDE_DATA_DIR: join(root, 'data'),
  CORTEX_IDE_DB_PATH: join(root, 'data', 'state.db') })) vi.stubEnv(key, value);
function git(...args: string[]) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
}
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'fixture');
git('config', 'user.email', 'fixture@example.invalid');
function commit(text: string) {
  writeFileSync(join(repo, area), text);
  git('add', '--', area);
  git('commit', '-qm', 'fixture');
  return git('rev-parse', 'HEAD');
}
const initialHead = commit('export const read = () => false;\n');
const { closeDb, getSqlite } = await import('@/lib/db');
const { createMission } = await import('@/lib/orchestrator/operator-mission-service/mission');
const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createLane } = await import('@/lib/lane/registry');
const { buildPacketPrompt } = await import('@/lib/orchestrator/packet-prompt');
const { POST: review } = await import('@/app/api/orchestrator/review/route');
const { GET: inventory, DELETE: forget } = await import('@/app/api/cortex/recent-outcomes/route');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
let projectId: string;
let sourcePacket: string;
let rejectedId: string;
let acceptedId: string;
let sequence = 0;
function request(url: string, body?: unknown, method = 'POST') {
  return new NextRequest(`http://localhost${url}`, { method: body === undefined ? 'GET' : method,
    headers: { host: 'localhost', authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function task(body: string, targetProject = projectId, targetRepo = repo) {
  await createMission({ repoPath: targetRepo, projectId: targetProject, runtime, constraints: '', taskContract: 'off',
    issues: [{ number: 90001 + sequence, title: `Fixture ${++sequence}`, body, url: '' }] });
  return readOrchestratorControlPlaneState().packets[0];
}
async function save(approved: boolean, head: string, mutation: string, findings = [{ file: area, severity: 'bug',
  description: observation, status: approved ? 'fixed' : 'deferred' }]) {
  const body = { packetId: sourcePacket, approved, findings, reviewedHeadSha: head, clientMutationId: mutation };
  const response = await review(request('/api/orchestrator/review', body));
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(200);
  return { value, body };
}
async function recall(body = `Extend ${area}`, targetProject = projectId, targetRepo = repo) {
  const packet = await task(body, targetProject, targetRepo);
  return buildPacketPrompt(packet, [packet]);
}
async function retained() {
  const response = await inventory(request(`/api/cortex/recent-outcomes?inventory=1&${new URLSearchParams({ repoPath: repo, projectId })}`));
  expect(response.status).toBe(200);
  return (await response.json()).reviewOutcomes as Array<{ id: string; withheldReason: string | null }>;
}
beforeAll(async () => {
  const { addRepo } = await import('@/lib/repos/registry');
  const registered = await addRepo(repo);
  const { createProject, addRepoToProject } = await import('@/lib/projects/store');
  projectId = createProject({ name: 'Review reuse fixture' }).id;
  addRepoToProject(projectId, registered.id, 'library', 'manual');
  const { setActiveProject } = await import('@/lib/repos/projects');
  await setActiveProject(projectId);
});
afterAll(() => { closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it('persists review, correction and acceptance, then briefs a real successor with evidence after restart', async () => {
  const packet = await task(`Repair ${area}`); sourcePacket = packet.id;
  createLane({ repoPath: repo, projectId, branch: 'main', runtime, packetId: sourcePacket });
  const rejected = await save(false, initialHead, 'rejection');
  rejectedId = rejected.value.result.auditApprovalId;
  const correctedHead = commit('export const read = () => true;\n');
  const accepted = await save(true, correctedHead, 'acceptance');
  acceptedId = accepted.value.result.auditApprovalId;
  closeDb();
  const replay = await review(request('/api/orchestrator/review', accepted.body));
  expect((await replay.json()).result.auditApprovalId).toBe(acceptedId);
  const prompt = await recall();
  expect(prompt).toContain('## Relevant Review Outcomes');
  expect(prompt).toContain(observation);
  expect(prompt).toContain(`approval:${acceptedId}`);
  expect(prompt).toContain(`approval:${rejectedId}#finding:0`);
  expect(prompt).toContain(correctedHead);
  expect(prompt).toContain('historical evidence');
  expect(prompt).toContain('same project and repository');
  expect((await retained()).filter(row => row.id === `review:${acceptedId}`)).toHaveLength(1);
}, 60000);

it('scopes retrieval by area, project and repository', async () => {
  expect(await recall('Update src/search/query.ts')).not.toContain(observation);
  const { createProject, addRepoToProject } = await import('@/lib/projects/store');
  const { listRepos } = await import('@/lib/repos/registry');
  const other = createProject({ name: 'Other review fixture' });
  addRepoToProject(other.id, (await listRepos()).find(item => item.localPath === repo)!.id, 'library', 'manual');
  expect(await recall(`Extend ${area}`, other.id)).not.toContain(observation);
  const sibling = join(root, 'sibling'); mkdirSync(sibling);
  execFileSync('git', ['init', '-q', '-b', 'main', sibling]);
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: sibling });
  const { addRepo } = await import('@/lib/repos/registry');
  addRepoToProject(projectId, (await addRepo(sibling)).id, 'library', 'manual');
  expect(await recall(`Extend ${area}`, projectId, sibling)).not.toContain(observation);
}, 60000);

it('withholds superseded and stale acceptance with inspectable reasons', async () => {
  const db = getSqlite();
  db.prepare("UPDATE approvals SET args_json = json_set(args_json, '$.reviewSuperseded', json('true')) WHERE id = ?").run(acceptedId);
  expect(await recall()).not.toContain(observation);
  expect((await retained()).find(row => row.id === `review:${acceptedId}`)?.withheldReason).toContain('superseded');
  db.prepare("UPDATE approvals SET args_json = json_set(args_json, '$.reviewSuperseded', json('false')), created_at = ? WHERE id = ?")
    .run(Date.now() - 31 * 86400000, acceptedId);
  expect(await recall()).toContain(observation);
  const saved = db.prepare('SELECT audit_json AS audit FROM approvals WHERE id = ?').get(acceptedId) as { audit: string };
  const staleAudit = (JSON.parse(saved.audit) as Array<{ type: string; timestamp: number }>).map(event => event.type === 'orchestrator_review'
    ? { ...event, timestamp: Date.now() - 31 * 86400000 } : event);
  db.prepare('UPDATE approvals SET audit_json = ? WHERE id = ?').run(JSON.stringify(staleAudit), acceptedId);
  expect(await recall()).not.toContain(observation);
  expect((await retained()).find(row => row.id === `review:${acceptedId}`)?.withheldReason).toContain('stale');
  db.prepare('UPDATE approvals SET created_at = ?, audit_json = ? WHERE id = ?').run(Date.now(), saved.audit, acceptedId);
}, 60000);

it('forgets a lesson through the existing memory route without deleting its review history', async () => {
  const response = await forget(request('/api/cortex/recent-outcomes', { id: `review:${acceptedId}`, repoPath: repo, projectId }, 'DELETE'));
  expect(response.status).toBe(200);
  closeDb();
  expect(await recall()).not.toContain(observation);
  expect(getSqlite().prepare('SELECT id FROM approvals WHERE id = ?').get(acceptedId)).toBeTruthy();
}, 60000);

it('retrieves a verified rejection as an observation and withholds a later unverified verdict', async () => {
  const packet = await task(`Inspect ${area}`); sourcePacket = packet.id;
  createLane({ repoPath: repo, projectId, branch: 'main', runtime, packetId: sourcePacket });
  const rejected = await save(false, git('rev-parse', 'HEAD'), 'new-rejection');
  const prompt = await recall();
  expect(prompt).toContain('rejected_with_findings');
  expect(prompt).toContain(observation);
  expect(prompt).toContain(rejected.value.result.auditApprovalId);
  const { submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service/review');
  const unverified = await submitPacketReview({ packetId: sourcePacket, approved: true, reviewedHeadSha: git('rev-parse', 'HEAD'),
    findings: [{ file: area, severity: 'bug', description: observation, resolution: 'fixed' }] });
  expect(await recall()).not.toContain(observation);
  expect((await retained()).find(row => row.id === `review:${unverified.auditApprovalId}`)?.withheldReason).toContain('unverified');
}, 60000);

it('captures finding-free acceptance against the exact committed diff', async () => {
  git('branch', 'review-base', initialHead);
  const packet = await task(`Preserve the boundary in ${area}`); sourcePacket = packet.id;
  createLane({ repoPath: repo, projectId, branch: 'main', baseBranch: 'review-base', runtime, packetId: sourcePacket });
  const accepted = await save(true, git('rev-parse', 'HEAD'), 'clean-acceptance', []);
  const prompt = await recall();
  expect(prompt).toContain('[accepted; operator_decision]');
  expect(prompt).toContain(`approval:${accepted.value.result.auditApprovalId}`);
}, 60000);

it('reuses the automatic verdict entry point and withdraws failed turns and unresolved acceptance', async () => {
  const packet = await task(`Verify ${area}`);
  const lane = createLane({ repoPath: repo, projectId, branch: 'main', runtime, packetId: packet.id });
  const { recordOrchestratorReview, listApprovalsForContext, finalizeOrchestratorReviewTurn } = await import('@/lib/approvals/store');
  const head = git('rev-parse', 'HEAD');
  const turn = 'fixture-independent-review';
  recordOrchestratorReview(packet.id, { approved: false, reviewedHeadSha: head, reviewTurnId: turn,
    findings: [{ file: area, severity: 'bug', description: 'Automatic review observation.', resolution: 'deferred' }],
    runEvidence: { status: 'run', headSha: head, reviewerRuntime: runtime, recordedAt: new Date().toISOString(),
      principal: { role: 'assigned_reviewer', source: 'server_review_turn', packetId: packet.id, reviewTurnId: turn, reviewerRuntime: runtime },
      observations: [{ kind: 'command', command: 'fixture check', result: 'Observed failure', exitCode: 1, excerpt: 'Project boundary missing' }] } });
  const automatic = listApprovalsForContext({ packetId: packet.id, laneId: lane.id }).find(row => row.toolName === 'orchestrator_review')!;
  expect(await recall()).toContain('Automatic review observation.');
  finalizeOrchestratorReviewTurn(turn, 'failed');
  expect(await recall()).not.toContain('Automatic review observation.');
  expect((await retained()).find(row => row.id === `review:${automatic.id}`)?.withheldReason).toContain('superseded');
  sourcePacket = packet.id;
  const unresolved = await save(true, head, 'unresolved-acceptance', [{ file: area, severity: 'bug', description: 'Unresolved observation.', status: 'deferred' }]);
  expect(await recall()).not.toContain('Unresolved observation.');
  expect((await retained()).find(row => row.id === `review:${unresolved.value.result.auditApprovalId}`)?.withheldReason).toContain('unresolved');
}, 60000);

it('retrieves only the matching finding from a review covering several areas', async () => {
  const packet = await task(`Inspect ${area}`); sourcePacket = packet.id;
  createLane({ repoPath: repo, projectId, branch: 'main', runtime, packetId: sourcePacket });
  const saved = await save(true, git('rev-parse', 'HEAD'), 'several-areas', [
    ...['identity', 'billing', 'search'].map(name => ({ file: `src/${name}/read.ts`, severity: 'bug',
      description: `Observation limited to ${name}.`, status: 'fixed' })),
    { file: area, severity: 'bug', description: 'Observation limited to cache.', status: 'accepted' },
  ]);
  const prompt = await recall();
  expect(prompt).toContain('Observation limited to cache.');
  expect(prompt).toContain('[accepted]: Observation limited to cache.');
  expect(prompt).toContain(`approval:${saved.value.result.auditApprovalId}#finding:3`);
  for (const name of ['identity', 'billing', 'search']) expect(prompt).not.toContain(`Observation limited to ${name}.`);
}, 60000);

it('keeps independent-review second-pass and unresolved-finding holds effective', async () => {
  const { startReviewTurn, finishReviewTurn } = await import('@/lib/lane/review-turn-state');
  const { recordOrchestratorReview } = await import('@/lib/approvals/store');
  for (const hold of ['second-pass', 'unresolved'] as const) {
    const packet = await task(`Inspect ${area}`);
    const lane = createLane({ repoPath: repo, projectId, branch: 'main', runtime, packetId: packet.id });
    const head = git('rev-parse', 'HEAD');
    const turn = startReviewTurn({ laneId: lane.id, threadId: `fixture-${hold}`, backend: runtime, surface: 'auto-review', expectedHeadSha: head });
    finishReviewTurn({ laneId: lane.id, reviewTurnId: turn, outcome: 'completed' });
    recordOrchestratorReview(packet.id, { approved: true, reviewedHeadSha: head, reviewTurnId: turn,
      requiresSecondPass: hold === 'second-pass', findings: [{ file: area, severity: 'bug',
        description: `Held independent ${hold}.`, resolution: hold === 'unresolved' ? 'deferred' : 'fixed' }] });
    expect(await recall()).not.toContain(`Held independent ${hold}.`);
  }
}, 60000);

it('pages and forgets retained sources beyond the contextual scan window', async () => {
  const db = getSqlite();
  const oldest = db.prepare(`SELECT * FROM approvals WHERE project_id = ?
    AND json_type(args_json, '$.reusableOutcome') = 'object' ORDER BY rowid LIMIT 1`).get(projectId) as Record<string, unknown>;
  const columns = Object.keys(oldest);
  const insert = db.prepare(`INSERT INTO approvals (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
  db.transaction(() => {
    for (let index = 0; index < 210; index++) insert.run(...columns.map(column => column === 'id' ? `inventory-fixture-${index}` : oldest[column]));
  })();
  const count = (db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE project_id = ?
    AND json_type(args_json, '$.reusableOutcome') = 'object'`).get(projectId) as { n: number }).n;
  const response = await inventory(request(`/api/cortex/recent-outcomes?inventory=1&${new URLSearchParams({
    repoPath: repo, projectId, offset: String(count - 1), limit: '1',
  })}`));
  expect((await response.json()).reviewOutcomes).toEqual([expect.objectContaining({ id: `review:${oldest.id}` })]);
  expect((await forget(request('/api/cortex/recent-outcomes', { id: `review:${oldest.id}`, repoPath: repo, projectId }, 'DELETE'))).status).toBe(200);
}, 60000);
