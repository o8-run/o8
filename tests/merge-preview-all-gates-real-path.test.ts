import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, expect, it, vi } from 'vitest';
import { runPacketReview } from '../cli/src/commands/packet/review';
import { runPacketMergePreview } from '../cli/src/commands/packet/recover';
import type { MergePreviewResult } from '@/lib/lane/preview-merge';
import type { PacketTaskContract } from '@/lib/orchestrator/types';
import type { ReviewCoverageEvidence } from '@/lib/orchestrator/task-contract-coverage';

vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
// The external AI is a fixture boundary. Its persisted required-pass gate and
// completion receipt remain real; this test never launches an account-backed reviewer.
vi.mock('@/lib/lane/blind-second-pass-review', async (original) => ({
  ...await original<typeof import('@/lib/lane/blind-second-pass-review')>(),
  rearmPendingSecondPassApproval: vi.fn(async () => ({ rearmed: false, reason: 'Fixture second pass is pending.' })),
}));
vi.mock('@/lib/worktree/storage-telemetry', async (original) => ({
  ...await original<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/',
    availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null })),
}));

const previewRoute = await import('@/app/api/orchestrator/merge-preview/route');
const reviewRoute = await import('@/app/api/orchestrator/review/route');
const mergeRoute = await import('@/app/api/orchestrator/merge/route');
const { recordMission } = await import('@/lib/db/missions-store');
const { addSessionRule, removeSessionRule } = await import('@/lib/db/session-rules-store');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { patchMissionPacket } = await import('@/lib/orchestrator/operator-mission-service/packet-patch');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { getOrCreateWsToken } = await import('@/lib/ws-auth');
const { recordOrchestratorReview, listApprovalsForContext, markSecondPassAgreed, getApproval, createApproval } = await import('@/lib/approvals/store');
const { claimApprovalResolution } = await import('@/lib/approvals/resolution');
const { approveAndMergePacket } = await import('@/lib/orchestrator/operator-mission-service');
const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(oversized = false, mergeHold = false) {
  vi.stubEnv('O8_SKIP_PRELAUNCH_TYPECHECK', '1');
  updateOperatorDefaults({ requireApproval: 'never' });
  const root = mkdtempSync(join(tmpdir(), 'o8-all-gates-'));
  roots.push(root);
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '--bare', origin], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'o8 test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-qu', 'origin', 'main');
  const packetId = `pkt-all-gates-${randomUUID()}`;
  const branch = `inline/${packetId}`;
  const worktree = await getWorktreeManager(repo).create({ agentType: 'codex', taskName: packetId,
    branchName: branch, baseBranch: 'main', packetId, skipSetup: true, isolationPreference: 'git-worktree' });
  const cwd = worktree.path;
  writeFileSync(join(cwd, 'change.txt'), 'packet change\n'.repeat(oversized ? 801 : 1));
  git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', 'packet change');
  const head = git(cwd, 'rev-parse', 'HEAD');
  const lane = createLane({ repoPath: repo, worktreePath: cwd, branch, baseBranch: 'main',
    runtime: 'codex', packetId, sessionKey: `codex:${packetId}` });
  const taskContract: PacketTaskContract = { version: 1, requirements: [
    { id: 'R1', source: 'Change a file.', expectedBehavior: 'The change is committed.', productionPath: 'change.txt', verification: 'git show HEAD' },
    { id: 'R2', source: 'Prepare a branch and pull request.', expectedBehavior: 'The branch and pull request are ready.',
      productionPath: 'branch and pull request', verification: 'Inspect the publication command receipt.' },
  ], processConstraints: [{ id: 'P1', source: 'Commit before review.', expectedBehavior: 'The reviewed HEAD is committed.', verification: 'git show HEAD' }],
  smallestRoute: [{ path: 'change.txt', requirements: ['R1'], reason: 'The file change.' },
    { path: 'branch and pull request', requirements: ['R2'], reason: 'The publication receipt.' }], exclusions: [] };
  const state = normalizeOrchestratorMissionState({ version: 2, missionId: `mission-${packetId}`,
    repoPath: repo, runtime: 'codex', prompt: 'Review and merge', summary: 'Review and merge', constraints: '',
    packets: [{ id: packetId, referenceLabel: 'P1', title: 'All gates', summary: 'All gates',
      workspaceTargetPath: repo, branchTarget: branch, runtime: 'codex', dependencyLabels: [], dependencyPacketIds: [],
      queueState: 'released', releaseState: 'pending', status: 'awaiting_review', blockedReason: null,
      lastEventAt: null, lastEventLabel: null, archivedAt: null, review: null, lane: null,
      taskContractRequired: true, taskContractSource: 'default', taskContract, mergeHold, orchestratorThreadId: `thread-${packetId}` }] });
  recordMission({ id: state.missionId!, repoPath: repo, runtime: 'codex', prompt: state.prompt, summary: state.summary,
    constraints: '', packetMeta: [{ id: packetId, title: 'All gates', referenceLabel: 'P1' }], missionState: state, totalWaves: 1 });
  writeOrchestratorControlPlaneState(state);
  return { repo, cwd, packetId, lane, head, taskContract, thread: `thread-${packetId}` };
}

function request(route: string, body?: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/${route}`, {
    method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${getOrCreateWsToken()}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function preview(packetId: string): Promise<MergePreviewResult> {
  const response = await previewRoute.GET(request(`orchestrator/merge-preview?packetId=${packetId}`));
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}
async function merge(packetId: string, head: string) {
  const response = await mergeRoute.POST(request('orchestrator/merge', { packetId, expectedHeadSha: head, idempotencyKey: randomUUID() }));
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).result;
}
function evidence(head: string): ReviewCoverageEvidence {
  return { contractVersion: 1, headSha: head, entries: [
    { requirementId: 'R1', productionPath: 'change.txt' },
    { requirementId: 'R2', productionPath: 'branch and pull request', source: 'command', reference: 'publication receipt: branch and PR prepared' },
  ], processEntries: [{ constraintId: 'P1', source: 'command', reference: 'git show HEAD confirms the commit' }] };
}

it('lists simultaneous gates, then merges after clearing exactly the reported gates', async () => {
  const f = await fixture(true);
  writeFileSync(join(f.cwd, 'scratch.txt'), 'uncommitted\n');
  recordOrchestratorReview(f.packetId, { approved: true, findings: [], reviewer: 'codex', reviewedHeadSha: f.head, requiresSecondPass: true });
  const blocked = await preview(f.packetId);
  expect(blocked.blockers).toEqual(expect.arrayContaining(['clean-worktree', 'contract-review', 'durable-review', 'file-size-approval']));
  expect(blocked.reviewRequirements).toMatchObject({ contractKind: 'default-captured', requirementIds: ['R1', 'R2'], processConstraintIds: ['P1'],
    review: { secondPassPending: true }, oversizedFiles: [{ path: 'change.txt', lineCount: 801 }] });
  for (const check of blocked.checks.filter(check => check.verdict === 'fail')) {
    expect(check).toHaveProperty('actions', expect.arrayContaining([expect.any(String)]));
  }
  expect(blocked.reviewRequirements?.actions.join('\n')).toContain(`o8 packet review ${f.packetId} --approve --expected-sha ${f.head}`);
  expect(blocked.reviewRequirements?.actions.join('\n')).toContain('--coverage R1=change.txt');
  expect(blocked.reviewRequirements?.actions.join('\n')).toContain("--requirement-evidence 'R2=");
  rmSync(join(f.cwd, 'scratch.txt'));
  const reviewed = await reviewRoute.POST(request('orchestrator/review', { packetId: f.packetId, approved: true, findings: [],
    reviewedHeadSha: f.head, contractCoverageEvidence: evidence(f.head), clientMutationId: randomUUID() }));
  expect(reviewed.status).toBe(200);
  expect((await reviewed.json()).result.contractCoverage.status).toBe('passed');
  const review = listApprovalsForContext({ packetId: f.packetId }).find(row => row.toolName === 'orchestrator_review')!;
  markSecondPassAgreed(review.id);
  const sizeOnly = await preview(f.packetId);
  expect(sizeOnly.blockers).toEqual(['file-size-approval']);
  const held = await merge(f.packetId, f.head);
  expect(held.merged).toBe(false);
  expect(getApproval(held.approvalId)).toMatchObject({ title: 'Override file size limit', status: 'pending' });
  const cardPreview = await preview(f.packetId);
  expect(cardPreview.checks.find(check => check.name === 'file-size-approval')).toHaveProperty('actions',
    expect.arrayContaining([expect.stringContaining(held.approvalId)]));
  claimApprovalResolution(held.approvalId, 'approve', 'desktop', 'Operator inspected the size override.');
  writeFileSync(join(f.repo, 'change.txt'), 'operator work must survive\n');
  expect(await preview(f.packetId)).toMatchObject({ wouldMerge: true, blockers: [] });
  rmSync(join(f.repo, 'change.txt'));
  const clear = await preview(f.packetId);
  expect(clear.blockers).toEqual([]);
  expect(clear.wouldMerge).toBe(true);
  expect(await merge(f.packetId, f.head)).toMatchObject({ merged: true });
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.head);
}, 60_000);

it('reports policy approval, mission hold and session restriction even while review is missing', async () => {
  const f = await fixture(false, true);
  updateOperatorDefaults({ requireApproval: 'always' });
  const rule = addSessionRule(f.thread, 'Hold publication for inspection.', 'no_merge')!;
  try {
    const result = await preview(f.packetId);
    expect(result.blockers).toEqual(expect.arrayContaining(['merge-policy', 'mission-merge-hold', 'session-merge-restriction', 'contract-review', 'durable-review']));
    expect(JSON.stringify(result.checks)).toContain(f.thread);
    expect(JSON.stringify(result.checks)).toContain(rule.id);
  } finally { removeSessionRule(rule.id); }
});

it('returns a structured 422 explaining that a captured contract cannot be waived, including replay', async () => {
  const f = await fixture();
  const body = { packetId: f.packetId, approved: true, findings: [], reviewedHeadSha: f.head,
    missingContractWaiverReason: 'Operator inspected the change.', clientMutationId: randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await reviewRoute.POST(request('orchestrator/review', body));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'invalid_missing_contract_waiver', message: expect.stringContaining('captured') } });
  }
});

it.each(['change.txt', 'change.txt -> committed file', 'change.txt->committed', 'missing.ts -> handler'])('keeps file coverage mandatory for %s when observations are supplied', async (productionPath) => {
  const f = await fixture();
  await patchMissionPacket(f.packetId, { taskContract: { ...f.taskContract,
    requirements: [{ ...f.taskContract.requirements[0], productionPath }, f.taskContract.requirements[1]] } });
  const coverage = evidence(f.head);
  coverage.entries[0] = { requirementId: 'R1', productionPath: '', source: 'command', reference: 'A command is not the changed file.' };
  const response = await reviewRoute.POST(request('orchestrator/review', { packetId: f.packetId, approved: true, findings: [],
    reviewedHeadSha: f.head, contractCoverageEvidence: coverage, clientMutationId: randomUUID() }));
  expect(response.status).toBe(200);
  expect((await response.json()).result.contractCoverage).toMatchObject({ status: 'failed', missingRequirementIds: ['R1'] });
  expect(await preview(f.packetId)).toMatchObject({ wouldMerge: false, blockers: expect.arrayContaining(['contract-review']) });
  expect(await merge(f.packetId, f.head)).toMatchObject({ merged: false });
});

it('reports a detached HEAD at the reviewed commit before merge', async () => {
  const f = await fixture();
  recordOrchestratorReview(f.packetId, { approved: true, findings: [], reviewer: 'codex', reviewedHeadSha: f.head,
    requiresSecondPass: false, contractCoverageEvidence: evidence(f.head) });
  git(f.cwd, 'checkout', '--detach', '-q', f.head);
  const blocked = await previewRoute.GET(request(`orchestrator/merge-preview?packetId=${f.packetId}`));
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({ error: { code: 'branch_unresolved', branch: f.lane.branch },
    blockers: ['worktree-branch'], checks: [expect.objectContaining({ name: 'worktree-branch', actions: [expect.stringContaining(f.lane.branch)] })] });
  git(f.cwd, 'checkout', '-q', f.lane.branch);
  expect(await preview(f.packetId)).toMatchObject({ wouldMerge: true, blockers: [] });
  expect(await merge(f.packetId, f.head)).toMatchObject({ merged: true });
}, 60_000);

it('accepts strict-mode null observation fields on changed-file evidence through review and merge', async () => {
  const f = await fixture();
  const coverage = evidence(f.head);
  const response = await reviewRoute.POST(request('orchestrator/review', { packetId: f.packetId, approved: true, findings: [],
    reviewedHeadSha: f.head, contractCoverageEvidence: { ...coverage,
      entries: [{ ...coverage.entries[0], source: null, reference: null }, coverage.entries[1]] }, clientMutationId: randomUUID() }));
  expect(response.status).toBe(200);
  expect((await response.json()).result.contractCoverage).toMatchObject({ status: 'passed' });
  expect(await merge(f.packetId, f.head)).toMatchObject({ merged: true });
}, 60_000);

it('reports a base branch checked out in another worktree before attempting merge', async () => {
  const f = await fixture();
  recordOrchestratorReview(f.packetId, { approved: true, findings: [], reviewer: 'codex', reviewedHeadSha: f.head,
    requiresSecondPass: false, contractCoverageEvidence: evidence(f.head) });
  git(f.repo, 'checkout', '-qb', 'operator-inspection');
  const baseCheckout = join(f.repo, '..', 'base-checkout');
  git(f.repo, 'worktree', 'add', '-q', baseCheckout, 'main');
  expect(await preview(f.packetId)).toMatchObject({ wouldMerge: false, blockers: expect.arrayContaining(['clean-worktree']) });
  git(f.repo, 'worktree', 'remove', baseCheckout);
  expect(await preview(f.packetId)).toMatchObject({ wouldMerge: true, blockers: [] });
  expect(await merge(f.packetId, f.head)).toMatchObject({ merged: true });
}, 60_000);

it('lets the operator clear a repaired gate card under always-approve policy', async () => {
  const f = await fixture();
  updateOperatorDefaults({ requireApproval: 'always' });
  recordOrchestratorReview(f.packetId, { approved: true, findings: [], reviewer: 'codex', reviewedHeadSha: f.head,
    requiresSecondPass: false, contractCoverageEvidence: evidence(f.head) });
  const card = createApproval({ source: 'runtime', runtime: 'codex', agent: 'fixture', sessionKey: f.lane.sessionKey!,
    title: 'Merge gate: repaired findings', description: 'Prior findings are now repaired.', summary: 'Merge gate card',
    risk: 'high', policyRuleId: 'merge-gate-violation', metadata: { Packet: f.packetId, Lane: f.lane.id },
    continuation: { kind: 'lane', laneId: f.lane.id, verb: 'merge' } });
  expect(await preview(f.packetId)).toMatchObject({ wouldMerge: false, blockers: expect.arrayContaining(['merge-approval']) });
  const result = await approveAndMergePacket({ packetId: f.packetId, expectedHeadSha: f.head, actor: 'user' });
  expect(result).toMatchObject({ merged: true });
  expect(getApproval(card.id)?.status).toBe('approved');
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.head);
}, 60_000);

it('reports gates on an overlapping sibling that the merge must release first', async () => {
  const f = await fixture();
  recordOrchestratorReview(f.packetId, { approved: true, findings: [], reviewer: 'codex', reviewedHeadSha: f.head,
    requiresSecondPass: false, contractCoverageEvidence: evidence(f.head) });
  const siblingId = `pkt-prerequisite-${randomUUID()}`;
  const branch = `inline/${siblingId}`;
  const worktree = await getWorktreeManager(f.repo).create({ agentType: 'codex', taskName: siblingId, branchName: branch,
    baseBranch: 'main', packetId: siblingId, skipSetup: true, isolationPreference: 'git-worktree' });
  writeFileSync(join(worktree.path, 'change.txt'), 'packet change\n');
  writeFileSync(join(worktree.path, 'foundation.txt'), 'foundation\n'.repeat(20));
  git(worktree.path, 'add', '-A'); git(worktree.path, 'commit', '-qm', 'sibling foundation');
  const siblingLane = createLane({ repoPath: f.repo, worktreePath: worktree.path, branch, baseBranch: 'main', runtime: 'codex',
    packetId: siblingId, sessionKey: `codex:${siblingId}` });
  setLaneStatus(f.lane.id, 'reviewing', 'system', 'review_ready');
  setLaneStatus(siblingLane.id, 'reviewing', 'system', 'review_ready');
  const state = readOrchestratorControlPlaneState();
  state.packets.push({ ...state.packets[0], id: siblingId, referenceLabel: 'P2', branchTarget: branch,
    taskContractRequired: false, taskContract: null, review: null });
  recordMission({ id: state.missionId!, repoPath: f.repo, runtime: 'codex', prompt: state.prompt, summary: state.summary,
    constraints: '', packetMeta: state.packets.map(packet => ({ id: packet.id, title: packet.title, referenceLabel: packet.referenceLabel })),
    missionState: state, totalWaves: 1 });
  writeOrchestratorControlPlaneState(state);
  const blocked = await preview(f.packetId);
  expect(blocked).toMatchObject({ wouldMerge: false, blockers: expect.arrayContaining(['merge-order']) });
  const order = blocked.checks.find(check => check.name === 'merge-order');
  expect(order?.detail).toContain(siblingId);
  expect(order?.detail).toContain('durable-review');
  expect(order?.actions?.join('\n')).toContain(`o8 packet review ${siblingId}`);
  expect(await merge(f.packetId, f.head)).toMatchObject({ merged: false, note: expect.stringContaining('before') });
}, 60_000);

it('accepts an all-non-file contract and prints gate actions in human CLI preview', async () => {
  const f = await fixture();
  await patchMissionPacket(f.packetId, { taskContract: { ...f.taskContract,
    requirements: [f.taskContract.requirements[1]], smallestRoute: [f.taskContract.smallestRoute[1]] } });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/lanes') return Response.json({ lanes: [f.lane] });
    const req = new NextRequest(url, { method: init?.method, headers: init?.headers, body: init?.body as string });
    if (url.pathname === '/api/orchestrator/merge-preview') return previewRoute.GET(req);
    if (url.pathname === '/api/orchestrator/review') return reviewRoute.POST(req);
    if (url.pathname === '/api/orchestrator/merge') return mergeRoute.POST(req);
    throw new Error(`Unexpected CLI route: ${url.pathname}`);
  }));
  await runPacketMergePreview({ human: true, verbose: false }, [f.packetId]);
  const rendered = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
  expect(rendered).toContain('default-captured');
  expect(rendered).toContain('--requirement-evidence');
  expect(rendered).toContain('R2=');
  expect(rendered).toContain('P1=');
  stdout.mockClear();
  await expect(runPacketReview({ human: false, verbose: false }, [f.packetId, '--approve', '--expected-sha', f.head,
    '--requirement-evidence', 'R2=command:publication receipt', '--process-evidence', 'P1=command:git show HEAD',
  ])).resolves.toBe(0);
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.head);
}, 60_000);

it.each(['transcript', 'lane-event', 'command'])('accepts non-file requirement %s evidence through CLI review and merge', async (source) => {
  const f = await fixture();
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/lanes') return Response.json({ lanes: [f.lane] });
    const req = new NextRequest(url, { method: init?.method, headers: init?.headers, body: init?.body as string });
    if (url.pathname === '/api/orchestrator/review') return reviewRoute.POST(req);
    if (url.pathname === '/api/orchestrator/merge') return mergeRoute.POST(req);
    throw new Error(`Unexpected CLI route: ${url.pathname}`);
  }));
  await expect(runPacketReview({ human: false, verbose: false }, [f.packetId, '--approve', '--expected-sha', f.head,
    '--coverage', 'R1=change.txt', '--requirement-evidence', `R2=${source}:publication receipt`,
    '--process-evidence', 'P1=command:git show HEAD',
  ])).resolves.toBe(0);
  expect(JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(''))).toMatchObject({ packet: { contractCoverage: { status: 'passed' }, merge: { merged: true } } });
  expect(git(f.repo, 'rev-parse', 'main')).toBe(f.head);
}, 60_000);
