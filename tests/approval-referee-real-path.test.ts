/**
 * #2435 — the advisory referee row on approval cards, through the real path.
 *
 * Real-path doctrine: approvals are created by the real merge-card creation
 * path (`performWorktreeSideMerge` → `createLaneActionApproval`) against real
 * git repos, the setting is written through the operator-defaults store, the
 * key is read from the data-dir key file, the referee call goes over HTTP to
 * the local judgment endpoint fixture, and the answers are read back from the
 * persisted approval row and the approvals API route.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  startJudgmentEndpointFixture,
  writeJudgmentFixtureKey,
  type JudgmentEndpointFixture,
} from './fixtures/judgment-endpoint';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-referee-real-data-'));
const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  O8_SKIP_PRELAUNCH_TYPECHECK: process.env.O8_SKIP_PRELAUNCH_TYPECHECK,
};
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { appendEvent, createLane, getLaneEvents } = await import('@/lib/lane/registry');
const { performWorktreeSideMerge } = await import('@/lib/lane/worktree-side-merge');
const { createLaneActionApproval } = await import('@/lib/lane/commands-approval');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { getApproval } = await import('@/lib/approvals/store');
const { claimApprovalResolution } = await import('@/lib/approvals/resolution');
const { approvalDiffFingerprint, setApprovalRefereeOptionsForTests, waitForApprovalReferee } = await import('@/lib/approvals/referee');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { DIFF_QUESTIONS } = await import('@/lib/judgment/questions');
const { listJudgmentReceipts } = await import('@/lib/judgment/receipts');
const { getSqlite } = await import('@/lib/db');
const approvalsRoute = await import('@/app/api/panel/approvals/route');

const tempDirs: string[] = [];
let fixture: JudgmentEndpointFixture;

const legend = Object.fromEntries(DIFF_QUESTIONS.risk.criteria.map((text, index) => [String(index), text]));
const REFEREE_BODY = {
  model: 'jev-1.13.0',
  answers: {
    docsOnly: { type: 'noul', noul: 0.03 },
    touchesMiddlewareOrAuth: { type: 'noul', noul: 0.91 },
    containsPlaceholderOrMockData: { type: 'noul', noul: 0.07 },
    addsTests: { type: 'noul', noul: 0.12 },
    scopeCreepBeyondTitle: { type: 'noul', noul: 0.64 },
    testsReachRealEntryPoint: { type: 'noul', noul: 0.05 },
    risk: { type: 'score', score: 3.1, confidence: 0.88, legend, probabilities: { 0: 0, 1: 0.02, 2: 0.1, 3: 0.64, 4: 0.24 } },
    recommendedAction: { type: 'choice', choice: 'operatorCard', confidence: 0.7, probabilities: { autoApprove: 0.05, operatorCard: 0.8, reject: 0.15 } },
  },
  usage: { input_tokens: 812, output_tokens: 190 },
};
const PROVIDER_DOWN = { status: 529, body: { detail: { error_type: 'overloaded' } } };

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(cwd: string, message: string) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
}

function makeRepo(name: string) {
  const root = mkdtempSync(join(os.tmpdir(), `${name}-root-`));
  tempDirs.push(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);
  return { repo: realpathSync(repo) };
}

/** Worker changes `file.txt` and adds an auth file; main changes `file.txt` too, so the merge escalates. */
async function escalateConflictingMerge(name: string) {
  const { repo } = makeRepo(name);
  const packetId = `pkt-${name}`;
  const branch = `inline/${name}`;
  const worktree = await getWorktreeManager(repo).create({
    agentType: 'codex',
    taskName: packetId,
    branchName: branch,
    baseBranch: 'main',
    packetId,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  });
  git(worktree.path, ['config', 'user.name', 'o8-test']);
  git(worktree.path, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(worktree.path, 'file.txt'), 'worker\n');
  mkdirSync(join(worktree.path, 'src', 'auth'), { recursive: true });
  writeFileSync(join(worktree.path, 'src', 'auth', 'session.ts'), 'export const sessionTtlMs = 60_000;\n');
  commitAll(worktree.path, 'worker change');
  writeFileSync(join(repo, 'file.txt'), 'upstream\n');
  commitAll(repo, 'upstream change');
  git(repo, ['push', 'origin', 'main']);

  const lane = createLane({
    repoPath: repo,
    worktreePath: worktree.path,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
  });
  const result = await performWorktreeSideMerge({
    lane,
    command: { verb: 'merge', laneId: lane.id, actor: 'system', orchestratorReviewed: true },
    actor: 'system',
    gateResult: { passed: true, violations: [] },
    createLaneActionApproval,
  });
  expect(result.ok).toBe(false);
  expect(result.approvalId).toEqual(expect.any(String));
  return { lane, approvalId: result.approvalId! };
}

/** A lane whose branch sits in its own repo checkout, for repeated direct card creation. */
function makeDirectLane(name: string) {
  const { repo } = makeRepo(name);
  git(repo, ['checkout', '-b', `inline/${name}`]);
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'docs', 'notes.md'), '# Notes\n\nworker\n');
  writeFileSync(join(repo, 'src.ts'), 'export const value = 2;\n');
  commitAll(repo, 'worker change');
  return createLane({
    repoPath: repo,
    worktreePath: repo,
    branch: `inline/${name}`,
    baseBranch: 'main',
    runtime: 'codex',
    packetId: `pkt-${name}`,
    sessionKey: `codex:pkt-${name}`,
  });
}

function createMergeCard(lane: ReturnType<typeof createLane>) {
  return createLaneActionApproval(lane, 'system', {
    verb: 'merge',
    title: 'Merge blocked (base moved)',
    description: 'The final fast-forward failed.',
    summary: 'Fast-forward failed',
    risk: 'high',
    riskFromChangedPaths: true,
    policyRuleId: 'fast_forward_failure_escalation',
    metadata: { FailureCategory: 'non-fast-forward' },
    note: 'Approval required.',
  });
}

type ApprovalRow = Record<string, unknown>;
const approvalRow = (id: string) => getSqlite().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow;

function refereeReceipt(laneId: string, approvalId: string) {
  return getLaneEvents(laneId).find((event) => event.verb === 'judgment'
    && event.payload?.surface === 'approval-card'
    && event.payload?.approvalId === approvalId)?.payload;
}

/** Row with only the per-creation values (id, clock times) masked. */
function comparableRow(row: ApprovalRow) {
  const audit = (JSON.parse(String(row.audit_json)) as Array<Record<string, unknown>>)
    .map((event) => ({ ...event, timestamp: 0 }));
  return { ...row, id: '<id>', created_at: 0, updated_at: 0, audit_json: JSON.stringify(audit) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for the judgment fixture');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function getApprovals(query: string) {
  const response = await approvalsRoute.GET(new NextRequest(`http://127.0.0.1:47120/api/panel/approvals?${query}`));
  expect(response.status).toBe(200);
  return (await response.json() as { approvals: Array<Record<string, unknown>> }).approvals;
}

beforeAll(async () => {
  fixture = await startJudgmentEndpointFixture();
  setApprovalRefereeOptionsForTests({ endpoint: fixture.endpoint, retryBaseMs: 1, timeoutMs: 5_000 });
  await updateOperatorDefaults({
    storageReserveRatio: 0.0001,
    storageReserveFloorGb: 0.001,
  });
  writeJudgmentFixtureKey(judgmentKeyPath());
});

afterEach(async () => {
  vi.restoreAllMocks();
  fixture.reset();
  await updateOperatorDefaults({ judgmentProvider: 'off' });
});

afterAll(async () => {
  setApprovalRefereeOptionsForTests(undefined);
  await fixture.close();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('approval card referee through the merge-card creation path', () => {
  it('stores the receipt and card answers on the approval and returns them from the approvals API', async () => {
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
    const hold = deferred();
    fixture.replies.push({ status: 200, body: REFEREE_BODY, hold: hold.promise });

    const { lane, approvalId } = await escalateConflictingMerge('o8-referee-merge');

    // Created without waiting on the referee: the provider has not answered.
    const created = getApproval(approvalId)!;
    expect(fixture.responded()).toBe(0);
    expect(created.referee).toBeUndefined();
    expect(created.risk).toBe('high');

    hold.release();
    const referee = await waitForApprovalReferee(approvalId);
    expect(referee).not.toBeNull();

    // The request carried git facts and the diff, never the worker-written title or summary.
    expect(fixture.seen).toHaveLength(1);
    const sent = fixture.seen[0].body as { questions: unknown; state: { files: Array<{ path: string }>; diff: string } };
    expect(sent.questions).toEqual(DIFF_QUESTIONS);
    expect(sent.state.files.map((file) => file.path)).toEqual(expect.arrayContaining(['file.txt', 'src/auth/session.ts']));
    expect(JSON.stringify(sent.state)).not.toContain(created.title);

    const stored = getApproval(approvalId)!;
    const receiptPayload = refereeReceipt(lane.id, approvalId);
    expect(receiptPayload).toBeDefined();
    expect(stored.referee).toMatchObject({
      receiptId: receiptPayload!.receiptId,
      model: 'jev-1.13.0',
      truncated: false,
      hiddenText: false,
      filesAddedFromDiff: 0,
      pathTouchesMiddlewareOrAuth: true,
      answers: {
        docsOnly: { noul: 0.03 },
        addsTests: { noul: 0.12 },
        touchesMiddlewareOrAuth: { noul: 0.91 },
        containsPlaceholderOrMockData: { noul: 0.07 },
        risk: { score: 3.1, legend, abstain: false },
      },
    });
    expect(stored.referee!.receiptId).toMatch(/^jdg_/);
    expect(receiptPayload).toMatchObject({ ok: true, approvalId, surface: 'approval-card', packetId: lane.packetId });
    // Record-only answers stay on the receipt.
    expect(Object.keys(stored.referee!.answers).sort()).toEqual(['addsTests', 'containsPlaceholderOrMockData', 'docsOnly', 'risk', 'touchesMiddlewareOrAuth']);
    expect((receiptPayload!.answers as Record<string, unknown>).recommendedAction).toBeDefined();
    // Nothing in the decision path moved: rule risk, status, and the resolve CAS token are unchanged.
    expect(stored.risk).toBe(created.risk);
    expect(stored.status).toBe('pending');
    expect(stored.updatedAt).toBe(created.updatedAt);
    expect(stored.metadata).toEqual(created.metadata);

    for (const query of [`laneId=${lane.id}`, 'status=pending']) {
      const card = (await getApprovals(query)).find((approval) => approval.id === approvalId)!;
      expect(card.referee).toEqual(stored.referee);
      expect(card.risk).toBe('high');
    }
  }, 60_000);

  it('with the setting off produces the same approval bytes as a run whose referee returns null', async () => {
    const lane = makeDirectLane('o8-referee-off');

    const offResult = await createMergeCard(lane);
    await waitForApprovalReferee(offResult.approvalId!);
    const offRow = approvalRow(offResult.approvalId!);
    expect(fixture.seen).toHaveLength(0);
    expect(listJudgmentReceipts({ approvalId: offResult.approvalId! })).toEqual([]);
    expect(getLaneEvents(lane.id).some((event) => event.verb === 'judgment')).toBe(false);
    expect(JSON.parse(String(offRow.metadata_json))).not.toHaveProperty('referee');
    expect(getApproval(offResult.approvalId!)).not.toHaveProperty('referee');
    claimApprovalResolution(offResult.approvalId!, 'reject', 'test');

    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
    fixture.replies.push(PROVIDER_DOWN, PROVIDER_DOWN, PROVIDER_DOWN);
    const onResult = await createMergeCard(lane);
    expect(onResult.approvalId).not.toBe(offResult.approvalId);
    expect(await waitForApprovalReferee(onResult.approvalId!)).toBeNull();
    expect(fixture.seen).toHaveLength(3);
    const onRow = approvalRow(onResult.approvalId!);

    expect(comparableRow(onRow)).toEqual(comparableRow(offRow));
    expect(onRow.metadata_json).toBe(offRow.metadata_json);
    expect(onRow.diff_json).toBe(offRow.diff_json);
  }, 60_000);

  it('runs the referee on a new merge card under the managed provider value (#2484)', async () => {
    await updateOperatorDefaults({ judgmentProvider: 'managed' });
    const lane = makeDirectLane('o8-referee-managed');
    fixture.replies.push({ status: 200, body: REFEREE_BODY });

    const result = await createMergeCard(lane);
    const referee = await waitForApprovalReferee(result.approvalId!);

    expect(fixture.seen).toHaveLength(1);
    expect(referee).not.toBeNull();
    expect(getApproval(result.approvalId!)!.referee).toMatchObject({ model: 'jev-1.13.0' });
    expect(refereeReceipt(lane.id, result.approvalId!)).toMatchObject({ ok: true, provider: 'managed', surface: 'approval-card', approvalId: result.approvalId });
  }, 60_000);

  it('never holds approval creation on a failing referee and leaves the card as created', async () => {
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
    const lane = makeDirectLane('o8-referee-null');
    const hold = deferred();
    fixture.replies.push({ ...PROVIDER_DOWN, hold: hold.promise }, PROVIDER_DOWN, PROVIDER_DOWN);

    const result = await createMergeCard(lane);

    // The approval exists and is listed while the provider has not responded.
    expect(result.approvalId).toEqual(expect.any(String));
    const createdRow = approvalRow(result.approvalId!);
    expect(createdRow).toBeDefined();
    await waitFor(() => fixture.seen.length === 1);
    // Other judgment surfaces can finish first for the same approval.
    appendEvent(lane.id, 'judgment', 'system', {
      surface: 'approval-triage', approvalId: result.approvalId,
      ok: false, attempts: 1, error: { kind: 'http', status: 401 },
    });
    expect(fixture.responded()).toBe(0);
    expect((await getApprovals(`laneId=${lane.id}`)).map((approval) => approval.id)).toContain(result.approvalId);

    hold.release();
    expect(await waitForApprovalReferee(result.approvalId!)).toBeNull();
    expect(fixture.responded()).toBe(3);
    expect(approvalRow(result.approvalId!)).toEqual(createdRow);
    const card = (await getApprovals(`laneId=${lane.id}`)).find((approval) => approval.id === result.approvalId)!;
    expect(card).not.toHaveProperty('referee');

    expect(refereeReceipt(lane.id, result.approvalId!)).toMatchObject({ ok: false, attempts: 3, approvalId: result.approvalId, error: { kind: 'http', status: 529 } });
  }, 60_000);
  it('keeps the fresh referee when a reused approval\'s earlier call answers late', async () => {
    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
    const lane = makeDirectLane('o8-referee-reuse');
    const staleHold = deferred();
    fixture.replies.push({ status: 200, body: REFEREE_BODY, hold: staleHold.promise });

    const first = await createMergeCard(lane);
    await waitFor(() => fixture.seen.length === 1);
    const firstDiff = JSON.parse(String(approvalRow(first.approvalId!).diff_json)) as { after: string; files: Array<{ path: string }> };

    // The worker moves on: a new commit changes the diff, and the same card is reused.
    mkdirSync(join(lane.worktreePath!, 'src'), { recursive: true });
    writeFileSync(join(lane.worktreePath!, 'src', 'auth-guard.ts'), 'export const allow = false;\n');
    commitAll(lane.worktreePath!, 'worker follow-up');
    const freshBody = { ...REFEREE_BODY, model: 'jev-1.13.1', answers: { ...REFEREE_BODY.answers, docsOnly: { type: 'noul', noul: 0.5 } } };
    fixture.replies.push({ status: 200, body: freshBody });
    const sqlite = getSqlite();
    const prepare = vi.spyOn(sqlite, 'prepare');
    const info = vi.spyOn(console, 'info');
    const refereeWrites = () => prepare.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE approvals SET metadata_json')).length;

    const second = await createMergeCard(lane);
    expect(second.approvalId).toBe(first.approvalId);
    const reusedRow = approvalRow(second.approvalId!);
    const secondDiff = JSON.parse(String(reusedRow.diff_json)) as { after: string; files: Array<{ path: string }> };
    const secondFingerprint = approvalDiffFingerprint(secondDiff.after, secondDiff.files.map((file) => file.path));
    expect(secondFingerprint).not.toBe(approvalDiffFingerprint(firstDiff.after, firstDiff.files.map((file) => file.path)));

    const fresh = await waitForApprovalReferee(second.approvalId!);
    expect(fresh).toMatchObject({ model: 'jev-1.13.1', diffFingerprint: secondFingerprint });
    const freshMetadata = approvalRow(second.approvalId!).metadata_json;

    staleHold.release();
    await waitFor(() => fixture.responded() === 2);
    await waitFor(() => info.mock.calls.some(([line]) => String(line).startsWith('[approval-referee] skipped')));

    const stored = getApproval(second.approvalId!)!;
    expect(stored.referee).toMatchObject({ model: 'jev-1.13.1', diffFingerprint: secondFingerprint, answers: { docsOnly: { noul: 0.5 } } });
    expect(approvalRow(second.approvalId!).metadata_json).toBe(freshMetadata);
    expect(refereeWrites()).toBe(1);
  }, 60_000);
});
