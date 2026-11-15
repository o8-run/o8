import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const root = mkdtempSync(join(tmpdir(), 'o8-integration-queue-'));
vi.stubEnv('O8_DATA_DIR', root);
vi.stubEnv('CORTEX_IDE_DATA_DIR', root);
vi.stubEnv('CORTEX_IDE_DB_PATH', join(root, 'state.db'));
const repoPath = join(root, 'repo');
mkdirSync(repoPath);
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd, encoding: 'utf8' }).trim();
}
git(repoPath, 'init', '-q', '-b', 'main');
writeFileSync(join(repoPath, 'shared.txt'), 'start\n');
writeFileSync(join(repoPath, 'behavior.json'), '{"left":false,"right":false}\n');
git(repoPath, 'add', 'shared.txt', 'behavior.json');
git(repoPath, 'commit', '-qm', 'base fixture');
const base = git(repoPath, 'rev-parse', 'HEAD');
const registry = await import('@/lib/lane/registry');
const { createApproval, resolveApproval } = await import('@/lib/approvals/store');
const { closeDb } = await import('@/lib/db');
const { createProject } = await import('@/lib/projects/store');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const packets: OrchestratorPacket[] = [];
const lanes = new Map<string, ReturnType<typeof registry.createLane>>();
let repoId: string;
const project = createProject({ name: 'Integration fixture' });
function persist() {
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), missionId: 'integration-fixture', repoPath, packets });
  closeDb();
}
function approve(id: string) {
  const lane = lanes.get(id)!;
  const head = git(lane.worktreePath!, 'rev-parse', 'HEAD');
  const approval = createApproval({ source: 'test', runtime: 'codex', agent: 'Fixture', sessionKey: `fixture:${id}`, title: id,
    description: 'Independent fixture review', summary: 'Independent fixture review', risk: 'low', toolName: 'orchestrator_review',
    args: { packetId: id, approved: true, reviewedHeadSha: head, reviewTurnId: `${id}:${head}`, reviewTurnOutcome: 'completed' }, metadata: { Packet: id, laneId: lane.id } });
  resolveApproval(approval.id, 'approve', 'test');
  registry.appendEvent(lane.id, 'review_risk_classified', 'system', { reviewedHeadSha: head, tier: 'standard', reasons: [], responsibleFiles: [],
    diffBase: { comparisonRef: base, mergeBase: base, usedFallback: false, warning: false } });
}
function change(id: string, files: Record<string, string>, parent = base, depends: string[] = []) {
  const worktreePath = join(root, id);
  git(repoPath, 'worktree', 'add', '-qb', id, worktreePath, parent);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(worktreePath, file), content);
  git(worktreePath, 'add', ...Object.keys(files));
  git(worktreePath, 'commit', '-qm', 'reviewed fixture');
  const lane = registry.createLane({ projectId: project.id, repoPath, worktreePath, packetId: id, branch: id, runtime: 'codex', baseCommit: base });
  registry.updateLane(lane.id, { status: 'reviewing', sessionKey: `fixture:${id}` });
  lanes.set(id, lane);
  packets.push({ id, referenceLabel: id, workspaceTargetPath: repoPath, branchTarget: id, title: id, summary: id, runtime: 'codex', dependencyLabels: [], dependencyPacketIds: depends,
    queueState: 'queued', releaseState: 'pending', status: 'awaiting_review', lane: null, orchestratorThreadId: id });
  persist(); approve(id);
  return git(worktreePath, 'rev-parse', 'HEAD');
}
const checks = [{ name: 'combined-behavior', command: process.execPath, args: ['-e', "const f=require('node:fs');if(!f.existsSync('independent.txt'))process.exit(1)"], timeoutMs: 10000 }];
beforeAll(async () => {
  writeFileSync(join(root, 'settings.toml'), '[review]\nrequire_approval = "never"\n');
  const { addRepo } = await import('@/lib/repos/registry');
  repoId = (await addRepo(repoPath)).id;
  const parent = change('parent', { 'shared.txt': 'parent\n' });
  change('dependent', { 'dependent.txt': 'dependent\n' }, parent, ['parent']);
  change('overlap', { 'shared.txt': 'overlap\n' });
  change('independent', { 'independent.txt': 'independent\n' });
});
afterAll(() => { vi.unstubAllGlobals(); closeDb(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
function request(method: string, body?: unknown, token = getOrCreateWsToken()) {
  return new NextRequest(`http://localhost/api/repos/${repoId}/integration-queue`, { method, headers: { authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function prepare(changes: Array<{ id: string; dependsOn?: string[] }> = ['parent', 'dependent', 'overlap', 'independent'].map(id => ({ id })), requiredChecks = checks) {
  const { POST } = await import('@/app/api/repos/[id]/integration-queue/route');
  const response = await POST(request('POST', { targetRef: 'refs/heads/main', changes, checks: requiredChecks }), { params: Promise.resolve({ id: repoId }) });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
async function read() {
  const { GET } = await import('@/app/api/repos/[id]/integration-queue/route');
  const response = await GET(request('GET'), { params: Promise.resolve({ id: repoId }) });
  expect(response.status).toBe(200);
  return response.json();
}
it('reads an empty queue without creating queue state', async () => {
  expect(existsSync(join(root, 'integration-queue'))).toBe(false);
  expect(await read()).toMatchObject({ plan: null, attempt: null, history: [] });
  expect(existsSync(join(root, 'integration-queue'))).toBe(false);
});
it('persists ordering for four reviewed changes while independent work passes a held dependency', async () => {
  packets.find(p => p.id === 'parent')!.mergeHold = true; persist();
  const result = await prepare();
  expect(result.plan.order).toEqual(['independent']);
  expect(result.plan.entries.find((e: { id: string }) => e.id === 'parent').blockers.join(' ')).toContain('held');
  expect(result.plan.entries.find((e: { id: string }) => e.id === 'dependent').blockers.join(' ')).toContain('parent');
  expect(result.plan.entries.find((e: { id: string }) => e.id === 'overlap').blockers.join(' ')).toContain('parent');
  expect(result.attempt, JSON.stringify(result.attempt)).toMatchObject({ status: 'passed', candidate: { headSha: expect.any(String), treeSha: expect.any(String) }, publication: 'not_requested' });
  expect(result.attempt.checks).toEqual([expect.objectContaining({ name: 'combined-behavior', verdict: 'pass' })]);
  closeDb();
  expect((await read()).attempt.id).toBe(result.attempt.id);
  const cold = execFileSync(process.execPath, ['--conditions=react-server', '--import', 'tsx', join(process.cwd(), 'tests/fixtures/integration-queue-restart-child.ts'), repoId], { encoding: 'utf8', timeout: 30000 });
  const recovered = JSON.parse(cold.split('QUEUE_RESTART_RESULT:')[1].split('\n')[0]);
  expect(recovered).toMatchObject({ status: 200, body: { attempt: { id: result.attempt.id, status: 'passed' } } });
  expect(git(repoPath, 'rev-parse', 'main')).toBe(base);
  expect(readFileSync(join(lanes.get('parent')!.worktreePath!, 'shared.txt'), 'utf8')).toBe('parent\n');
}, 90000);
it('reports unknown dependencies and cycles, without holding unrelated work', async () => {
  const result = await prepare([{ id: 'parent', dependsOn: ['dependent'] }, { id: 'dependent' }, { id: 'overlap', dependsOn: ['unknown'] }, { id: 'independent' }]);
  expect(result.plan.order).toEqual(['independent']);
  expect(result.plan.entries.find((e: { id: string }) => e.id === 'parent').blockers.join(' ')).toContain('cycle');
  expect(result.plan.entries.find((e: { id: string }) => e.id === 'overlap').blockers.join(' ')).toContain('unknown');
});
it('prepares a combined candidate in dependency order and detects conflicts without publishing', async () => {
  packets.find(p => p.id === 'parent')!.mergeHold = false; persist();
  const ordered = await prepare([{ id: 'dependent' }, { id: 'parent' }, { id: 'independent' }]);
  expect(ordered.attempt.status).toBe('passed');
  expect(ordered.plan.order.indexOf('parent')).toBeLessThan(ordered.plan.order.indexOf('dependent'));
  expect(ordered.plan.entries.find((e: { id: string }) => e.id === 'dependent').detectedDependencies).toContain('parent');
  const conflicted = await prepare();
  expect(conflicted.attempt).toMatchObject({ status: 'conflict', candidate: null, checks: [], publication: 'not_requested' });
  expect(git(repoPath, 'rev-parse', 'main')).toBe(base);
});
it('runs actual combined behavior rather than treating branch checks as integration proof', async () => {
  change('left', { 'left.txt': 'left\n' }); change('right', { 'right.txt': 'right\n' });
  const combinedChecks = [{ name: 'incompatible-combination', command: process.execPath, args: ['-e', "const f=require('node:fs');process.exit(f.existsSync('left.txt')&&f.existsSync('right.txt')?1:0)"], timeoutMs: 10000 }];
  expect((await prepare([{ id: 'left' }], combinedChecks)).attempt.status).toBe('passed');
  expect((await prepare([{ id: 'right' }], combinedChecks)).attempt.status).toBe('passed');
  const combined = await prepare([{ id: 'left' }, { id: 'right' }], combinedChecks);
  expect(combined.attempt).toMatchObject({ status: 'failed', checks: [{ name: 'incompatible-combination', verdict: 'fail', exitCode: 1 }], publication: 'not_requested' });
  expect(combined.attempt.sources.map((source: { id: string }) => source.id)).toEqual(['left', 'right']);
  closeDb();
  expect((await read()).attempt.id).toBe(combined.attempt.id);
  expect((await read()).history.some((attempt: { status: string }) => attempt.status === 'conflict')).toBe(true);
});
it('invalidates evidence on target movement, repair, check changes and fresh policy holds', async () => {
  const first = await prepare([{ id: 'independent' }]);
  expect(first.attempt.status).toBe('passed');
  writeFileSync(join(repoPath, 'target.txt'), 'target\n'); git(repoPath, 'add', 'target.txt'); git(repoPath, 'commit', '-qm', 'target movement');
  expect((await read()).attempt.status).toBe('stale');
  const targetMoved = await prepare([{ id: 'independent' }]);
  expect(targetMoved.attempt.status).toBe('passed');
  expect(targetMoved.attempt.targetSha).not.toBe(first.attempt.targetSha);
  expect(targetMoved.attempt.candidate.treeSha).not.toBe(first.attempt.candidate.treeSha);
  const lane = lanes.get('independent')!;
  writeFileSync(join(lane.worktreePath!, 'independent.txt'), 'repair\n'); git(lane.worktreePath!, 'add', 'independent.txt'); git(lane.worktreePath!, 'commit', '-qm', 'repair fixture');
  expect((await read()).attempt.status).toBe('stale');
  expect((await prepare([{ id: 'independent' }])).attempt.status).toBe('blocked');
  approve('independent'); closeDb();
  const repaired = await prepare([{ id: 'independent' }]);
  expect(repaired.attempt.status).toBe('passed');
  expect(repaired.attempt.inputHash).not.toBe(targetMoved.attempt.inputHash);
  const changedChecks = await prepare([{ id: 'independent' }], [{ ...checks[0], name: 'changed-check' }]);
  expect(changedChecks.attempt.inputHash).not.toBe(repaired.attempt.inputHash);
  packets.find(p => p.id === 'independent')!.mergeHold = true; persist();
  expect((await read()).attempt.status).toBe('stale');
  expect((await prepare([{ id: 'independent' }])).attempt.status).toBe('blocked');
  packets.find(p => p.id === 'independent')!.mergeHold = false; persist();
});
it('refuses duplicate preparation while one integration owner is checking', async () => {
  const checksModule = await import('@/lib/sandbox/run-confined');
  const original = checksModule.runConfinedProcess;
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const spy = vi.spyOn(checksModule, 'runConfinedProcess').mockImplementation(async (...args) => { entered(); await waiting; return original(...args); });
  const pending = prepare([{ id: 'independent' }]);
  try {
    await Promise.race([started, pending.then(() => { throw new Error('Preparation completed without entering its check.'); })]);
    const { POST } = await import('@/app/api/repos/[id]/integration-queue/route');
    const duplicate = await Promise.race([
      POST(request('POST', { targetRef: 'refs/heads/main', changes: [{ id: 'independent' }], checks }), { params: Promise.resolve({ id: repoId }) }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('Duplicate drain did not refuse promptly.')), 5000).unref()),
    ]);
    expect(duplicate.status).toBe(409);
  } finally { release(); spy.mockRestore(); }
  expect((await pending).attempt.status).toBe('passed');
});
it('invalidates a result when the target moves during a running check', async () => {
  const checksModule = await import('@/lib/sandbox/run-confined');
  const original = checksModule.runConfinedProcess;
  const spy = vi.spyOn(checksModule, 'runConfinedProcess').mockImplementation(async (...args) => {
    const result = await original(...args);
    writeFileSync(join(repoPath, 'moved-during-check.txt'), 'moved\n');
    git(repoPath, 'add', 'moved-during-check.txt'); git(repoPath, 'commit', '-qm', 'move during check');
    return result;
  });
  try { expect((await prepare([{ id: 'independent' }])).attempt.status).toBe('stale'); }
  finally { spy.mockRestore(); }
});
it('keeps check mutations and missing sources on the human path', async () => {
  const mutated = await prepare([{ id: 'independent' }], [{ name: 'mutation', command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('independent.txt','changed')"], timeoutMs: 10000 }]);
  expect(mutated.attempt).toMatchObject({ status: 'failed', reason: expect.stringContaining('modified the candidate') });
  const unknown = await prepare([{ id: 'missing-source' }, { id: 'independent' }]);
  expect(unknown.plan.blockers.join(' ')).toContain('Overlap detection is incomplete');
  expect(unknown.attempt.status).toBe('blocked');
});
it('reconciles interrupted verification without repeating publication', async () => {
  const result = await prepare([{ id: 'independent' }]);
  const { readQueueRecord, writeQueueRecord } = await import('@/lib/integration-queue/store');
  const record = readQueueRecord(repoId)!;
  record.attempts.at(-1)!.status = 'verifying'; record.attempts.at(-1)!.finishedAt = null;
  writeQueueRecord(record); closeDb();
  const retried = await prepare([{ id: 'independent' }]);
  expect(retried.attempt.id).not.toBe(result.attempt.id);
  expect(retried.history.find((a: { id: string }) => a.id === result.attempt.id)).toMatchObject({ status: 'interrupted', publication: 'not_requested' });
});
it('routes native HTTP, CLI and MCP read and write to the persisted operator route', async () => {
  const { matchNativeHttpRoute } = await import('@/lib/ws-server/native-http-registry');
  expect(matchNativeHttpRoute(`/api/repos/${repoId}/integration-queue`, 'POST')?.route.path).toBe('/api/repos/[id]/integration-queue');
  vi.stubEnv('O8_API_TOKEN', getOrCreateWsToken());
  const { GET, POST } = await import('@/app/api/repos/[id]/integration-queue/route');
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const req = new NextRequest(String(input), { method: init?.method, headers: init?.headers, body: init?.body });
    return (init?.method === 'POST' ? POST : GET)(req, { params: Promise.resolve({ id: repoId }) });
  });
  const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  try {
    const { runIntegrationQueue } = await import('../cli/src/commands/integration-queue');
    const { handleOperatorMcpMessage } = await import('@/lib/mcp/operator-mcp-host');
    const specFile = join(root, 'spec.json'); writeFileSync(specFile, JSON.stringify({ targetRef: 'refs/heads/main', changes: [{ id: 'independent' }], checks }));
    expect(await runIntegrationQueue({ human: false, verbose: false }, 'prepare', ['--repo-id', repoId, '--spec', specFile])).toBe(0);
    const saved = (await read()).attempt.id;
    const mcp = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'o8_integration_queue', arguments: { repoId, action: 'read' } } });
    expect(JSON.stringify(mcp)).toContain(saved);
    expect(await runIntegrationQueue({ human: false, verbose: false }, 'read', ['--repo-id', repoId])).toBe(0);
    const prepared = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'o8_integration_queue', arguments: { repoId, action: 'prepare', targetRef: 'refs/heads/main', changes: [{ id: 'independent' }], checks } } });
    expect(JSON.stringify(prepared)).toContain('passed');
    const denied = await handleOperatorMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'o8_integration_queue', arguments: { repoId, action: 'read' } } }, 'devices');
    expect(denied).toMatchObject({ result: { isError: true } });
  } finally { output.mockRestore(); vi.unstubAllGlobals(); }
});
it('preserves operator-only authority and refuses missing required checks', async () => {
  const { GET, POST } = await import('@/app/api/repos/[id]/integration-queue/route');
  const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
  for (const token of ['invalid', mintPacketWorkerToken('independent')]) {
    expect((await GET(request('GET', undefined, token), { params: Promise.resolve({ id: repoId }) })).status).toBe(403);
    expect((await POST(request('POST', {}, token), { params: Promise.resolve({ id: repoId }) })).status).toBe(403);
  }
  for (const body of [{ targetRef: 'main', changes: [{ id: 'independent' }], checks }, { targetRef: 'refs/heads/main', changes: [{ id: 'independent' }], checks: [] }]) {
    expect((await POST(request('POST', body), { params: Promise.resolve({ id: repoId }) })).status).toBe(400);
  }
});
it('detects a held ancestor even when it predates the recorded comparison base', async () => {
  const parent = lanes.get('parent')!; const dependent = lanes.get('dependent')!;
  const parentHead = git(parent.worktreePath!, 'rev-parse', 'HEAD');
  registry.appendEvent(dependent.id, 'review_risk_classified', 'system', { reviewedHeadSha: git(dependent.worktreePath!, 'rev-parse', 'HEAD'), tier: 'standard', reasons: [], responsibleFiles: [],
    diffBase: { comparisonRef: parentHead, mergeBase: parentHead, usedFallback: false, warning: false } });
  packets.find(p => p.id === 'parent')!.mergeHold = true; persist();
  try {
    const result = await prepare([{ id: 'dependent' }, { id: 'parent' }, { id: 'independent' }]);
    expect(result.plan.order).toEqual(['independent']);
    expect(result.plan.entries.find((e: { id: string }) => e.id === 'dependent').detectedDependencies).toContain('parent');
  } finally { packets.find(p => p.id === 'parent')!.mergeHold = false; persist(); approve('dependent'); }
});
it('accepts an unselected dependency only with a canonical release receipt on the target', async () => {
  const parent = lanes.get('parent')!;
  const head = git(parent.worktreePath!, 'rev-parse', 'HEAD');
  git(repoPath, 'merge', '--no-ff', '-qm', 'published parent fixture', head);
  const packet = packets.find(p => p.id === 'parent')!;
  packet.releaseState = 'released';
  packet.releaseStatePayload = { source: 'approve_and_merge', mergeCommit: git(repoPath, 'rev-parse', 'HEAD'), headSha: head, evidenceKind: 'ancestor', releasedAt: new Date().toISOString() };
  persist();
  const result = await prepare([{ id: 'dependent' }, { id: 'independent' }]);
  expect(result.attempt.status).toBe('passed');
  expect(result.plan.entries.find((e: { id: string }) => e.id === 'dependent').satisfiedDependencies).toEqual([expect.objectContaining({ id: 'parent', headSha: head })]);
  packet.releaseStatePayload = null; persist();
  const unproven = await prepare([{ id: 'dependent' }, { id: 'independent' }]);
  expect(unproven.plan.order).toEqual(['independent']);
});
it('preserves failed execution evidence when the target moves during the failed check', async () => {
  const checksModule = await import('@/lib/sandbox/run-confined');
  const original = checksModule.runConfinedProcess;
  const spy = vi.spyOn(checksModule, 'runConfinedProcess').mockImplementation(async (...args) => {
    try { return await original(...args); }
    finally {
      writeFileSync(join(repoPath, 'late-target.txt'), 'moved\n');
      git(repoPath, 'add', 'late-target.txt'); git(repoPath, 'commit', '-qm', 'late target movement');
    }
  });
  try {
    const result = await prepare([{ id: 'independent' }], [{ ...checks[0], args: ['-e', 'process.exit(1)'] }]);
    expect(result.attempt).toMatchObject({ status: 'stale', execution: { status: 'failed', reason: expect.stringContaining('combined-behavior') } });
    expect(result.attempt.checks[0].verdict).toBe('fail');
  } finally { spy.mockRestore(); }
});
it('preserves the readable record when a new attempt exceeds the storage bound', async () => {
  const { readQueueRecord, writeQueueRecord, hashInputs } = await import('@/lib/integration-queue/store');
  const file = join(root, 'integration-queue', `${hashInputs(repoId)}.json`);
  const before = readFileSync(file, 'utf8');
  const record = readQueueRecord(repoId)!;
  record.attempts.at(-1)!.reason = 'x'.repeat(8 * 1024 * 1024);
  expect(() => writeQueueRecord(record)).toThrow('storage bound');
  expect(readFileSync(file, 'utf8')).toBe(before);
});
it('does not execute source-configured Git helpers while ordering or checking', async () => {
  const hook = join(root, 'source-monitor.sh');
  writeFileSync(hook, '#!/bin/sh\ntouch "$0.ran"\nprintf "\\0"\n'); chmodSync(hook, 0o700);
  const lane = lanes.get('independent')!;
  git(lane.worktreePath!, 'config', 'core.fsmonitor', hook);
  try {
    expect((await prepare([{ id: 'independent' }])).attempt.status).toBe('passed');
    await read();
    expect(existsSync(`${hook}.ran`)).toBe(false);
  } finally { git(lane.worktreePath!, 'config', '--unset', 'core.fsmonitor'); }
});
it('does not silently replace unreadable durable queue state', async () => {
  const { hashInputs } = await import('@/lib/integration-queue/store');
  const file = join(root, 'integration-queue', `${hashInputs(repoId)}.json`);
  writeFileSync(file, '{broken');
  const { GET, POST } = await import('@/app/api/repos/[id]/integration-queue/route');
  expect((await GET(request('GET'), { params: Promise.resolve({ id: repoId }) })).status).toBe(503);
  expect((await POST(request('POST', { targetRef: 'refs/heads/main', changes: [{ id: 'independent' }], checks }), { params: Promise.resolve({ id: repoId }) })).status).toBe(503);
  expect(readFileSync(file, 'utf8')).toBe('{broken');
});
