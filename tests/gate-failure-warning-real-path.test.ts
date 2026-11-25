/**
 * #2437 — gate-failure early warning before the layer-1 automatic rerun.
 *
 * Real-path doctrine: a real git repo and worktree, a real lane, the real
 * merge entry point (`performWorktreeSideMerge`) reaching the real
 * `handlePostRebaseVerifyFailure`, the provider setting in the real
 * operator-defaults store, the key in the data-dir key file, and the referee
 * call over HTTP to the local systemone fixture. Stubbed: the verification
 * run (so the failure is deterministic) and the worker launch behind
 * `rerunWithFeedback`, which records the launch's `session_launched` status
 * exactly as the lane launch command does.
 *
 * The fixture drifts the base after the packet branch forks, so the lane's
 * persistent worktree and the detached integration worktree produce different
 * diff text for the same commit. That is what proves the referee read the tree
 * the verification actually failed in (#2437 ticket 3).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { startJudgmentEndpointFixture, type JudgmentEndpointFixture } from './fixtures/judgment-endpoint';

const h = vi.hoisted(() => ({
  verify: vi.fn(),
  rerunWithFeedback: vi.fn(),
  terminateManagedRuns: vi.fn(),
  /** Baseline switch: behave as if the handler never asked for a warning. */
  withoutWarning: false,
}));

vi.mock('@/lib/lane/rebase-verify', () => ({ runLaneRebaseVerify: h.verify }));
vi.mock('@/lib/orchestrator/operator-mission-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/operator-mission-service')>();
  return { ...actual, rerunWithFeedback: h.rerunWithFeedback };
});
vi.mock('@/lib/runtimes/managed-runs/packet-lifecycle', () => ({
  terminatePacketManagedRuns: h.terminateManagedRuns,
}));
vi.mock('@/lib/lane/gate-failure-warning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/gate-failure-warning')>();
  return {
    ...actual,
    assessGateFailureRisk: (...args: Parameters<typeof actual.assessGateFailureRisk>) => (
      h.withoutWarning ? Promise.resolve(null) : actual.assessGateFailureRisk(...args)
    ),
  };
});

const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  O8_SKIP_PRELAUNCH_TYPECHECK: process.env.O8_SKIP_PRELAUNCH_TYPECHECK,
};

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-gate-failure-warning-data-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { createLane, getLaneEvents, setLaneStatus, listLanes } = await import('@/lib/lane/registry');
const { performWorktreeSideMerge } = await import('@/lib/lane/worktree-side-merge');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { recordOrchestratorReview } = await import('@/lib/approvals/store');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { __resetIdempotencyStoreForTests } = await import('@/lib/orchestrator/idempotency-store');
const { getSqlite } = await import('@/lib/db');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { DIFF_QUESTIONS } = await import('@/lib/judgment/questions');
const { setGateFailureWarningTransportForTests } = await import('@/lib/lane/gate-failure-warning');

const KEY = 'ts-fixture-key-gate-failure-2437';
const FAILURE_OUTPUT = "src/broken.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.";
const PACKET_TITLE = 'Rewrite the auth middleware';
const TIMEOUT_MS = 150;
/** The surface's own single-attempt budget; the test transport does not override it. */
const MAX_ATTEMPTS = 1;
const RETRY_BASE_MS = 10;
const BASE_LINES = Array.from({ length: 12 }, (_, index) => `line ${String(index + 1).padStart(2, '0')}`);
const CHANGED_PATHS = ['broken.ts', 'file.txt'];

let fixture: JudgmentEndpointFixture;
const gitDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(cwd: string, message: string) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
}

function riskReply(delayMs?: number) {
  return {
    status: 200,
    delayMs,
    body: {
      model: 'jev-1.13.0',
      answers: {
        risk: {
          type: 'score',
          score: 2.71,
          confidence: 0.83,
          legend: Object.fromEntries(DIFF_QUESTIONS.risk.criteria.map((text, index) => [String(index), text])),
          probabilities: { 0: 0.01, 1: 0.05, 2: 0.2, 3: 0.7, 4: 0.04 },
        },
      },
      usage: { input_tokens: 412, output_tokens: 18 },
    },
  };
}

function packetFixture(id: string, repoPath: string): OrchestratorPacket {
  return {
    id,
    referenceLabel: id,
    title: PACKET_TITLE,
    summary: 'Worker-written summary that must never reach the referee.',
    status: 'running',
    queueState: 'queued',
    releaseState: 'pending',
    blockedReason: null,
    lane: null,
    review: null,
    runtime: 'codex',
    dependencyPacketIds: [],
    dependencyLabels: [],
    attemptCount: 0,
    lastEventAt: null,
    lastEventLabel: null,
    recoveryCount: 0,
    typecheckAutoRetries: 0,
    leaseWaitAutoRetries: 0,
    workspaceTargetPath: repoPath,
    branchTarget: `inline/${id}`,
  } as OrchestratorPacket;
}

async function setupPacket(packetId: string) {
  const root = mkdtempSync(join(os.tmpdir(), `${packetId}-root-`));
  gitDirs.push(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'file.txt'), `${BASE_LINES.join('\n')}\n`);
  commitAll(repo, 'base');
  git(repo, ['push', '-u', 'origin', 'main']);
  const repoPath = realpathSync(repo);

  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    repoPath,
    packets: [packetFixture(packetId, repoPath)],
  });
  const worktree = await getWorktreeManager(repoPath).create({
    agentType: 'codex',
    taskName: packetId,
    branchName: `inline/${packetId}`,
    baseBranch: 'main',
    packetId,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  });
  git(worktree.path, ['config', 'user.name', 'o8-test']);
  git(worktree.path, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(worktree.path, 'broken.ts'), 'export const broken: string = 123;\n');
  writeFileSync(join(worktree.path, 'file.txt'), `${[...BASE_LINES, 'packet tail'].join('\n')}\n`);
  commitAll(worktree.path, 'break typecheck');
  const packetSha = git(worktree.path, ['rev-parse', 'HEAD']);

  // Base drift AFTER the fork: two lines ahead of the packet's hunk, so the
  // rebase is clean but the post-rebase diff carries shifted hunk offsets.
  writeFileSync(join(repo, 'file.txt'), `${['drift one', 'drift two', ...BASE_LINES].join('\n')}\n`);
  commitAll(repo, 'base drift');
  git(repo, ['push', 'origin', 'main']);

  const lane = createLane({
    repoPath,
    worktreePath: worktree.path,
    branch: `inline/${packetId}`,
    baseBranch: 'main',
    runtime: 'codex',
    label: PACKET_TITLE,
    packetId,
  });
  recordOrchestratorReview(packetId, {
    approved: true,
    findings: [],
    reviewedHeadSha: git(worktree.path, ['rev-parse', 'HEAD']),
  });
  return { repoPath, worktree, lane, packetSha };
}

/**
 * The diff the detached integration worktree holds after its rebase, rebuilt
 * in a scratch clone: the packet commit replayed onto the drifted base.
 */
function integrationDiff(repoPath: string, packetSha: string): string {
  const scratch = mkdtempSync(join(os.tmpdir(), 'o8-gate-warning-scratch-'));
  gitDirs.push(scratch);
  const clone = join(scratch, 'clone');
  execFileSync('git', ['clone', '--quiet', repoPath, clone], { stdio: 'pipe' });
  git(clone, ['config', 'user.name', 'o8-test']);
  git(clone, ['config', 'user.email', 'o8@example.test']);
  git(clone, ['fetch', '--no-tags', '--quiet', repoPath, packetSha]);
  git(clone, ['checkout', '-q', '-b', 'integration', 'main']);
  git(clone, ['cherry-pick', packetSha]);
  return git(clone, ['diff', 'main...HEAD', '--no-color']);
}

function fingerprint(diffText: string, paths: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(diffText);
  for (const path of [...paths].sort()) hash.update(`\0${path}`);
  return hash.digest('hex');
}

async function mergeAndWaitForRerun(lane: ReturnType<typeof createLane>) {
  const startedAt = Date.now();
  const result = await performWorktreeSideMerge({
    lane,
    command: { verb: 'merge' as const, laneId: lane.id, actor: 'system' as const },
    actor: 'system' as const,
    gateResult: { passed: true, violations: [] },
    repoActionLeaseMaxWaitMs: 5_000,
    createLaneActionApproval: async (_lane: unknown, _actor: unknown, input: { note: string }) => (
      { ok: false as const, laneId: lane.id, note: input.note }
    ),
  });
  const deadline = Date.now() + 30_000;
  while (h.rerunWithFeedback.mock.calls.length === 0) {
    if (Date.now() > deadline) throw new Error('the automatic rerun never fired');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { result, rerunAfterMs: Date.now() - startedAt };
}

/** Lane events in insertion order (timestamps can tie within a millisecond). */
function orderedEvents(laneId: string) {
  return (getSqlite().prepare('SELECT verb, payload_json FROM lane_events WHERE lane_id = ? ORDER BY rowid')
    .all(laneId) as Array<{ verb: string; payload_json: string }>)
    .map((row) => ({ verb: row.verb, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
}

/** Verb sequence with status-change labels, the shape a timeline renders. */
function verbSequence(laneId: string): string[] {
  return orderedEvents(laneId).map((event) => (
    event.verb === 'status_change' ? `status_change:${String(event.payload.eventLabel ?? '')}` : event.verb
  ));
}

beforeAll(async () => {
  await updateOperatorDefaults({
    storageReserveRatio: 0.0001,
    storageReserveFloorGb: 0.001,
  });
  fixture = await startJudgmentEndpointFixture();
  setGateFailureWarningTransportForTests({
    endpoint: fixture.endpoint,
    timeoutMs: TIMEOUT_MS,
    retryBaseMs: RETRY_BASE_MS,
  });
  writeFileSync(judgmentKeyPath(), `${KEY}\n`);
  chmodSync(judgmentKeyPath(), 0o600);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

beforeEach(async () => {
  fixture.reset();
  h.withoutWarning = false;
  h.verify.mockReset();
  h.verify.mockResolvedValue({ ok: false, kind: 'typecheck', output: FAILURE_OUTPUT, checks: [] });
  h.terminateManagedRuns.mockReset();
  h.terminateManagedRuns.mockResolvedValue({ targeted: 0, confirmed: 0, failures: [] });
  h.rerunWithFeedback.mockReset();
  h.rerunWithFeedback.mockImplementation(async ({ packetId }: { packetId: string }) => {
    const lane = listLanes().find((candidate) => candidate.packetId === packetId);
    if (lane) setLaneStatus(lane.id, 'running', 'system', 'session_launched');
    return { packetId };
  });
  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
});

afterEach(() => {
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  __resetIdempotencyStoreForTests();
});

afterAll(async () => {
  setGateFailureWarningTransportForTests(undefined);
  vi.restoreAllMocks();
  await fixture.close();
  for (const dir of gitDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('gate-failure warning before the layer-1 automatic rerun', () => {
  it('records the referee risk before typecheck_auto_retry and the rerun launch, with the receipt linked', async () => {
    const { repoPath, worktree, lane, packetSha } = await setupPacket('pkt-gate-warning-on');
    fixture.replies.push(riskReply());

    const { result } = await mergeAndWaitForRerun(lane);

    expect(result.reason).toBe('typecheck_auto_retry');
    const sequence = verbSequence(lane.id);
    const warningAt = sequence.indexOf('gate_failure_warning');
    const retryAt = sequence.indexOf('typecheck_auto_retry');
    const launchAt = sequence.lastIndexOf('status_change:session_launched');
    expect(warningAt).toBeGreaterThanOrEqual(0);
    expect(warningAt).toBeLessThan(retryAt);
    expect(retryAt).toBeLessThan(launchAt);

    const events = orderedEvents(lane.id);
    const warning = events.find((event) => event.verb === 'gate_failure_warning')!.payload;
    const judgment = events.filter((event) => event.verb === 'judgment');
    expect(judgment).toHaveLength(1);
    expect(judgment[0].payload.surface).toBe('gate-failure-warning');
    expect(warning.receiptId).toBe(judgment[0].payload.receiptId);
    expect(warning).toMatchObject({
      packetId: 'pkt-gate-warning-on',
      risk: 2.71,
      confidence: 0.83,
      abstain: false,
      truncated: false,
      hiddenText: false,
    });
    expect((warning.legend as Record<string, string>)['3']).toBe(DIFF_QUESTIONS.risk.criteria[3]);

    // The state came from git, and from the tree the verification failed in:
    // the integration worktree's post-rebase diff, not the lane's stale one.
    const staleDiff = git(worktree.path, ['diff', 'main...HEAD', '--no-color']);
    const verifiedDiff = integrationDiff(repoPath, packetSha);
    expect(verifiedDiff).not.toBe(staleDiff);
    expect(warning.diffFingerprint).toBe(fingerprint(verifiedDiff, CHANGED_PATHS));
    expect(warning.diffFingerprint).not.toBe(fingerprint(staleDiff, CHANGED_PATHS));
    expect(fixture.seen).toHaveLength(1);
    const sent = JSON.stringify(fixture.seen[0].body);
    expect(sent).toContain('export const broken: string = 123;');
    expect(sent).not.toContain(PACKET_TITLE);
    expect(sent).not.toContain('Worker-written summary');
    expect(Object.keys(fixture.seen[0].body.questions as object)).toEqual(['risk']);
    expect(h.rerunWithFeedback).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('records the warning under the managed provider value (#2484)', async () => {
    await updateOperatorDefaults({ judgmentProvider: 'managed' });
    const { lane } = await setupPacket('pkt-gate-warning-managed');
    fixture.replies.push(riskReply());

    await mergeAndWaitForRerun(lane);

    expect(fixture.seen).toHaveLength(1);
    const events = orderedEvents(lane.id);
    expect(events.some((event) => event.verb === 'gate_failure_warning')).toBe(true);
    expect(events.find((event) => event.verb === 'judgment')!.payload).toMatchObject({ ok: true, provider: 'managed', surface: 'gate-failure-warning' });
  }, 60_000);

  it('leaves the event sequence unchanged and sends nothing when judgment.provider is off', async () => {
    await updateOperatorDefaults({ judgmentProvider: 'off' });
    h.withoutWarning = true;
    const baseline = await setupPacket('pkt-gate-warning-baseline');
    await mergeAndWaitForRerun(baseline.lane);
    const baselineSequence = verbSequence(baseline.lane.id);

    h.withoutWarning = false;
    h.rerunWithFeedback.mockClear();
    const off = await setupPacket('pkt-gate-warning-off');
    fixture.replies.push(riskReply());
    await mergeAndWaitForRerun(off.lane);

    expect(verbSequence(off.lane.id)).toEqual(baselineSequence);
    expect(baselineSequence).toContain('typecheck_auto_retry');
    expect(fixture.seen).toHaveLength(0);
    expect(h.rerunWithFeedback).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('still fires the rerun within the bounded budget and records no warning when the referee times out', async () => {
    const { lane } = await setupPacket('pkt-gate-warning-timeout');
    const heldPastTimeout = TIMEOUT_MS * 3;
    fixture.replies.push(riskReply(heldPastTimeout), riskReply(heldPastTimeout), riskReply(heldPastTimeout));
    // Extra replies stay queued: a retry would consume them and fail the attempt count below.

    const { result, rerunAfterMs } = await mergeAndWaitForRerun(lane);

    expect(result.reason).toBe('typecheck_auto_retry');
    expect(h.rerunWithFeedback).toHaveBeenCalledTimes(1);
    expect(fixture.seen).toHaveLength(MAX_ATTEMPTS);
    // Budget: every attempt's timeout plus the backoff between attempts, plus git and merge work.
    const refereeBudgetMs = MAX_ATTEMPTS * TIMEOUT_MS + RETRY_BASE_MS * (2 ** (MAX_ATTEMPTS - 1) - 1);
    expect(rerunAfterMs).toBeLessThan(refereeBudgetMs + 4_000);

    const sequence = verbSequence(lane.id);
    expect(sequence).not.toContain('gate_failure_warning');
    expect(sequence).toContain('typecheck_auto_retry');
    const judgment = orderedEvents(lane.id).filter((event) => event.verb === 'judgment');
    expect(judgment).toHaveLength(1);
    expect(judgment[0].payload).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(getLaneEvents(lane.id, 200).some((event) => event.verb === 'gate_failure_warning')).toBe(false);
    // Let the held fixture replies drain before the next case.
    await new Promise((resolve) => setTimeout(resolve, heldPastTimeout));
  }, 60_000);
});
