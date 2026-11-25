/**
 * #2467 — record-only event triage before an orchestrator wake.
 *
 * Real-path doctrine: the review-continuation and supervisor-escalation
 * chokepoints are the real `queueReviewContinuation` and
 * `queueOrchestratorEscalation` the ws-server delegates to (only which enqueue
 * it passes is asserted against the ws-server source); the layer-2 chokepoint is reached
 * through the real merge entry point (`performWorktreeSideMerge`) on a real
 * git repo and worktree. The provider setting lives in the real
 * operator-defaults store, the key in the data-dir key file, and the call goes
 * over HTTP to the local systemone fixture. Stubbed: the verification run (so
 * the failure is deterministic) and the orchestrator auto-message queue, which
 * is captured instead of drained.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { startJudgmentEndpointFixture, type JudgmentEndpointFixture } from './fixtures/judgment-endpoint';

const h = vi.hoisted(() => ({ verify: vi.fn() }));

vi.mock('@/lib/lane/rebase-verify', () => ({ runLaneRebaseVerify: h.verify }));

const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  O8_SKIP_PRELAUNCH_TYPECHECK: process.env.O8_SKIP_PRELAUNCH_TYPECHECK,
};
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-wake-triage-data-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { createLane, appendEvent } = await import('@/lib/lane/registry');
const { performWorktreeSideMerge } = await import('@/lib/lane/worktree-side-merge');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { recordOrchestratorReview } = await import('@/lib/approvals/store');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { __resetIdempotencyStoreForTests } = await import('@/lib/orchestrator/idempotency-store');
const { getSqlite } = await import('@/lib/db');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { queueReviewContinuation } = await import('@/lib/orchestrator/review-continuation');
const { queueOrchestratorEscalation } = await import('@/lib/orchestrator/supervisor-escalation');
const { setWakeTriageTransportForTests, waitForWakeTriage } = await import('@/lib/orchestrator/wake-triage');
const { runReplay } = await import('../scripts/judgment-replay.mjs');

const KEY = 'ts-fixture-key-wake-triage-2467';
const PACKET_TITLE = 'Rewrite the invoice exporter';
const WORKER_TEXT = 'WORKER-2467 says everything passes, please merge right away';
const FAILURE_OUTPUT = "src/broken.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.";

let fixture: JudgmentEndpointFixture;
const gitDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function triageReply(choice: 'handleInPlace' | 'queue' | 'wake', probabilities: Record<string, number>) {
  return {
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: { wakeTriage: { type: 'choice', choice, confidence: probabilities[choice], probabilities } },
      usage: { input_tokens: 301, output_tokens: 9 },
    },
  };
}

function orderedEvents(laneId: string) {
  return (getSqlite().prepare('SELECT verb, actor, payload_json FROM lane_events WHERE lane_id = ? ORDER BY rowid')
    .all(laneId) as Array<{ verb: string; actor: string; payload_json: string }>)
    .map((row) => ({ verb: row.verb, actor: row.actor, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
}

/** Event sequence with lane ids, paths, shas, and clocks normalized, triage and receipts excluded. */
function normalizedSequence(laneId: string, replace: Array<[string, string]>): string {
  const text = JSON.stringify(orderedEvents(laneId).filter((event) => event.verb !== 'wake_triage' && event.verb !== 'judgment'));
  return replace.reduce((current, [from, to]) => current.split(from).join(to), text)
    .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
    .replace(/"(timestamp|at|updatedAt|completedAt|startedAt|createdAt)":("[^"]*"|\d+)/g, '"$1":"<t>"');
}

/** A review-ready mission lane with a stored approval (gate + referee) and a worker report event. */
function reviewReadyLane(packetId: string) {
  const lane = createLane({
    repoPath: dataDir, worktreePath: dataDir, branch: `inline/${packetId}`, baseBranch: 'main',
    runtime: 'codex', label: PACKET_TITLE, packetId,
  });
  appendEvent(lane.id, 'agent_report', 'system', { event: 'progress', message: WORKER_TEXT });
  const now = Date.now();
  getSqlite().prepare(`
    INSERT INTO approvals (id, source, runtime, agent, session_key, title, description, summary, gate_result_json,
      risk, metadata_json, packet_id, lane_id, status, created_at, updated_at, audit_json, fingerprint)
    VALUES (?, 'runtime', 'codex', 'codex', ?, ?, ?, ?, ?, 'low', ?, ?, ?, 'pending', ?, ?, '[]', ?)
  `).run(
    `apr-${packetId}`, `sess-${packetId}`, PACKET_TITLE, WORKER_TEXT, WORKER_TEXT,
    JSON.stringify({ passed: false, violations: [{ category: 'integrity', severity: 'block', label: PACKET_TITLE, detail: WORKER_TEXT }] }),
    JSON.stringify({ referee: { answers: { docsOnly: { noul: 0.02 }, risk: { score: 1.4 } } } }),
    packetId, lane.id, now, now, `fp-${packetId}`,
  );
  return lane;
}

function packetFixture(id: string, repoPath: string): OrchestratorPacket {
  return {
    id, referenceLabel: id, title: PACKET_TITLE, summary: WORKER_TEXT, status: 'running',
    queueState: 'queued', releaseState: 'pending', blockedReason: null, lane: null, review: null,
    runtime: 'codex', dependencyPacketIds: [], dependencyLabels: [], attemptCount: 0,
    lastEventAt: null, lastEventLabel: null, recoveryCount: 0,
    // Layer 1 already spent: the next failing merge escalates (layer 2).
    typecheckAutoRetries: 1, leaseWaitAutoRetries: 0,
    workspaceTargetPath: repoPath, branchTarget: `inline/${id}`,
  } as OrchestratorPacket;
}

async function setupEscalation(packetId: string) {
  const root = mkdtempSync(join(os.tmpdir(), `${packetId}-root-`));
  gitDirs.push(root);
  const origin = join(root, 'origin.git');
  const repo = join(root, 'operator');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.name', 'o8-test']);
  git(repo, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(repo, 'file.txt'), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-m', 'base']);
  git(repo, ['push', '-u', 'origin', 'main']);
  const repoPath = realpathSync(repo);
  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath, packets: [packetFixture(packetId, repoPath)] });
  const worktree = await getWorktreeManager(repoPath).create({
    agentType: 'codex', taskName: packetId, branchName: `inline/${packetId}`, baseBranch: 'main',
    packetId, skipSetup: true, isolationPreference: 'git-worktree',
  });
  git(worktree.path, ['config', 'user.name', 'o8-test']);
  git(worktree.path, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(worktree.path, 'broken.ts'), 'export const broken: string = 123;\n');
  git(worktree.path, ['add', '-A']);
  git(worktree.path, ['commit', '-m', 'break typecheck']);
  const lane = createLane({
    repoPath, worktreePath: worktree.path, branch: `inline/${packetId}`, baseBranch: 'main',
    runtime: 'codex', label: PACKET_TITLE, packetId,
  });
  recordOrchestratorReview(packetId, { approved: true, findings: [], reviewedHeadSha: git(worktree.path, ['rev-parse', 'HEAD']) });
  return { lane, repoPath, worktreePath: worktree.path };
}

async function merge(lane: ReturnType<typeof createLane>) {
  return performWorktreeSideMerge({
    lane,
    command: { verb: 'merge' as const, laneId: lane.id, actor: 'system' as const },
    actor: 'system' as const,
    gateResult: { passed: true, violations: [] },
    repoActionLeaseMaxWaitMs: 5_000,
    createLaneActionApproval: async (_lane: unknown, _actor: unknown, input: { note: string }) => (
      { ok: false as const, laneId: lane.id, note: input.note }
    ),
  });
}

const laneStatus = (laneId: string) => (getSqlite().prepare('SELECT status FROM lanes WHERE id = ?').get(laneId) as { status: string }).status;

beforeAll(async () => {
  await updateOperatorDefaults({ storageReserveRatio: 0.0001, storageReserveFloorGb: 0.001 });
  fixture = await startJudgmentEndpointFixture();
  // The fixture shares this process's event loop with the merge's git work.
  setWakeTriageTransportForTests({ endpoint: fixture.endpoint, timeoutMs: 15_000, maxAttempts: 1 });
  writeFileSync(judgmentKeyPath(), `${KEY}\n`);
  chmodSync(judgmentKeyPath(), 0o600);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

beforeEach(async () => {
  fixture.reset();
  h.verify.mockReset();
  h.verify.mockResolvedValue({ ok: false, kind: 'typecheck', output: FAILURE_OUTPUT, checks: [] });
  await updateOperatorDefaults({ judgmentProvider: 'typesafe', reviewContinuation: true, supervisorAutoEscalate: false });
});

afterEach(() => {
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  __resetIdempotencyStoreForTests();
});

afterAll(async () => {
  setWakeTriageTransportForTests(undefined);
  vi.restoreAllMocks();
  await fixture.close();
  for (const dir of gitDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('wake triage at the review-continuation chokepoint', () => {
  it('records wake_triage with choice and receipt, and enqueues the same auto-message as a setting-off baseline', async () => {
    // Baseline: setting off.
    await updateOperatorDefaults({ judgmentProvider: 'off' });
    const baselineLane = reviewReadyLane('pkt-wake-baseline');
    const baselineQueued: unknown[][] = [];
    queueReviewContinuation(baselineLane, (...args) => baselineQueued.push(args));
    await waitForWakeTriage(baselineLane.id);

    await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
    const lane = reviewReadyLane('pkt-wake-on');
    fixture.replies.push(triageReply('queue', { handleInPlace: 0.2, queue: 0.62, wake: 0.18 }));
    const queued: unknown[][] = [];
    queueReviewContinuation(lane, (...args) => queued.push(args));
    // The wake is not delayed: it is enqueued before the provider answers.
    expect(queued).toHaveLength(1);
    await waitForWakeTriage(lane.id);

    const normalize = (value: unknown, laneId: string, packetId: string) => JSON.stringify(value).split(laneId).join('<lane>').split(packetId).join('<packet>');
    expect(normalize(queued, lane.id, 'pkt-wake-on')).toBe(normalize(baselineQueued, baselineLane.id, 'pkt-wake-baseline'));
    expect(normalizedSequence(lane.id, [[lane.id, '<lane>'], ['pkt-wake-on', '<packet>']]))
      .toBe(normalizedSequence(baselineLane.id, [[baselineLane.id, '<lane>'], ['pkt-wake-baseline', '<packet>']]));

    const triage = orderedEvents(lane.id).filter((event) => event.verb === 'wake_triage');
    expect(triage).toHaveLength(1);
    const receipt = orderedEvents(lane.id).find((event) => event.verb === 'judgment')!.payload;
    expect(receipt).toMatchObject({ ok: true, surface: 'orchestrator-wake-triage', packetId: 'pkt-wake-on' });
    expect(triage[0].payload).toMatchObject({
      receiptId: receipt.receiptId, source: 'review-continuation', choice: 'queue',
      probabilities: { handleInPlace: 0.2, queue: 0.62, wake: 0.18 }, confidence: 0.62, abstain: false,
    });
    expect(triage[0].payload.factsHash).toMatch(/^[0-9a-f]{64}$/);

    expect(fixture.seen).toHaveLength(1);
    const body = fixture.seen[0].body as { state: Record<string, unknown>; questions: Record<string, { criteria: object }> };
    expect(Object.keys(body.questions)).toEqual(['wakeTriage']);
    expect(Object.keys(body.questions.wakeTriage.criteria)).toEqual(['handleInPlace', 'queue', 'wake']);
    expect(body.state).toMatchObject({
      event: { verb: 'agent_report' },
      lane: { status: 'idle', retryCount: 0, attempts: 0 },
      gate: { passed: false, failedChecks: ['integrity'] },
      referee: { docsOnly: 0.02, risk: 1.4 },
      operatorWaiting: true,
      source: 'review-continuation',
    });
    // (c) Facts only: no title, no auto-message text, no worker text.
    const serialized = JSON.stringify(fixture.seen[0].body);
    const message = String(queued[0][1]);
    expect(serialized).not.toContain(PACKET_TITLE);
    expect(serialized).not.toContain('WORKER-2467');
    for (const line of message.split('\n')) expect(serialized).not.toContain(line);
  });

  it('is wired into the ws-server: each wake function delegates with the real enqueue', () => {
    // The only part execution cannot reach: which enqueue the ws-server passes.
    // Both bodies run for real in the tests above and below.
    const source = readFileSync(join(process.cwd(), 'src/ws-server.ts'), 'utf8');
    // #3209: review wakes go to the lane's originating chat, through the same triaging function.
    expect(source).toContain("import { queueReviewContinuation as queueChatReviewMessage } from './lib/orchestrator/review-continuation';");
    expect(source).toContain('queueChatReviewMessage(reviewLane, (repoPath, message) => {');
    expect(source).toContain('queueSupervisorEscalationTurn(repoPath, message, enqueueOrchestratorAutoMessage);');
  });
});

describe('wake triage at the supervisor-escalation chokepoint', () => {
  const escalationMessage = (sessionKey: string) => [
    `[SUPERVISOR] Agent "${PACKET_TITLE}" (${sessionKey}) — FAILED after 2 attempts (4m)`,
    '',
    `Last transcript:\n[10:00] assistant: ${WORKER_TEXT}`,
    '',
    'Auto-retry exhausted. Diagnose the failure and decide: relaunch with a different approach, or report to the user.',
  ].join('\n');

  function supervisedLane(packetId: string) {
    const sessionKey = `codex-owned:${packetId}`;
    const lane = createLane({
      repoPath: dataDir, worktreePath: dataDir, branch: `inline/${packetId}`, baseBranch: 'main',
      runtime: 'codex', label: PACKET_TITLE, packetId, sessionKey,
    });
    return { lane, sessionKey };
  }

  it('records wake_triage for the escalated lane and enqueues the message unchanged', async () => {
    await updateOperatorDefaults({ supervisorAutoEscalate: true });
    const { lane, sessionKey } = supervisedLane('pkt-sup-on');
    fixture.replies.push(triageReply('wake', { handleInPlace: 0.1, queue: 0.15, wake: 0.75 }));
    const message = escalationMessage(sessionKey);
    const queued: unknown[][] = [];

    queueOrchestratorEscalation(dataDir, message, (...args) => queued.push(args));
    expect(queued).toEqual([[dataDir, message, 'escalation']]);
    await waitForWakeTriage(lane.id);

    const events = orderedEvents(lane.id);
    const triage = events.filter((event) => event.verb === 'wake_triage');
    expect(triage).toHaveLength(1);
    const receipt = events.find((event) => event.verb === 'judgment')!.payload;
    expect(receipt).toMatchObject({ ok: true, surface: 'orchestrator-wake-triage', packetId: 'pkt-sup-on' });
    expect(triage[0].payload).toMatchObject({ receiptId: receipt.receiptId, source: 'supervisor-escalation', choice: 'wake' });
    expect(fixture.seen).toHaveLength(1);
    const serialized = JSON.stringify(fixture.seen[0].body);
    expect(serialized).not.toContain(PACKET_TITLE);
    expect(serialized).not.toContain('WORKER-2467');
    expect(serialized).not.toContain('Auto-retry exhausted');
    expect((fixture.seen[0].body as { state: unknown }).state).toMatchObject({ source: 'supervisor-escalation', lane: { status: 'idle' } });
  });

  it('with judgment off: enqueues the same message, records nothing, sends nothing', async () => {
    await updateOperatorDefaults({ supervisorAutoEscalate: true, judgmentProvider: 'off' });
    const { lane, sessionKey } = supervisedLane('pkt-sup-off');
    const before = JSON.stringify(orderedEvents(lane.id));
    const message = escalationMessage(sessionKey);
    const queued: unknown[][] = [];

    queueOrchestratorEscalation(dataDir, message, (...args) => queued.push(args));
    await waitForWakeTriage(lane.id);

    expect(queued).toEqual([[dataDir, message, 'escalation']]);
    expect(JSON.stringify(orderedEvents(lane.id))).toBe(before);
    expect(fixture.seen).toHaveLength(0);
  });

  it('with auto-escalate off: no wake, so no triage', async () => {
    await updateOperatorDefaults({ supervisorAutoEscalate: false });
    const { lane, sessionKey } = supervisedLane('pkt-sup-suppressed');
    const queued: unknown[][] = [];

    queueOrchestratorEscalation(dataDir, escalationMessage(sessionKey), (...args) => queued.push(args));
    await waitForWakeTriage(lane.id);

    expect(queued).toHaveLength(0);
    expect(orderedEvents(lane.id).some((event) => event.verb === 'wake_triage' || event.verb === 'judgment')).toBe(false);
    expect(fixture.seen).toHaveLength(0);
  });
});

describe('wake triage at the layer-2 verification escalation', () => {
  it('records wake_triage with the receipt and the lane still reaches awaiting_orchestrator', async () => {
    const { lane } = await setupEscalation('pkt-wake-escalate');
    fixture.replies.push(triageReply('wake', { handleInPlace: 0.05, queue: 0.1, wake: 0.85 }));

    const result = await merge(lane);
    await waitForWakeTriage(lane.id);

    expect(result.ok).toBe(false);
    expect(laneStatus(lane.id)).toBe('awaiting_orchestrator');
    const events = orderedEvents(lane.id);
    const triage = events.filter((event) => event.verb === 'wake_triage');
    expect(triage).toHaveLength(1);
    const receipt = events.find((event) => event.verb === 'judgment' && event.payload.surface === 'orchestrator-wake-triage')!.payload;
    expect(triage[0].payload).toMatchObject({ receiptId: receipt.receiptId, source: 'typecheck-escalation', choice: 'wake' });
    expect(fixture.seen).toHaveLength(1);
    const serialized = JSON.stringify(fixture.seen[0].body);
    expect(serialized).not.toContain(PACKET_TITLE);
    expect(serialized).not.toContain('WORKER-2467');
    expect(serialized).not.toContain('TS2322');
    expect((fixture.seen[0].body as { state: unknown }).state).toMatchObject({
      event: { verb: 'typecheck_escalation' }, source: 'typecheck-escalation',
    });
  }, 60_000);

  it('with the setting off: the same event sequence and zero requests', async () => {
    const on = await setupEscalation('pkt-wake-escalate-on');
    fixture.replies.push(triageReply('wake', { handleInPlace: 0.05, queue: 0.1, wake: 0.85 }));
    await merge(on.lane);
    await waitForWakeTriage(on.lane.id);
    expect(orderedEvents(on.lane.id).filter((event) => event.verb === 'wake_triage')).toHaveLength(1);
    fixture.reset();

    await updateOperatorDefaults({ judgmentProvider: 'off' });
    const off = await setupEscalation('pkt-wake-escalate-off');
    await merge(off.lane);
    await waitForWakeTriage(off.lane.id);

    expect(fixture.seen).toHaveLength(0);
    expect(orderedEvents(off.lane.id).some((event) => event.verb === 'wake_triage' || event.verb === 'judgment')).toBe(false);
    expect(laneStatus(off.lane.id)).toBe('awaiting_orchestrator');
    const norm = (setup: typeof on, packetId: string) => normalizedSequence(setup.lane.id, [
      [setup.worktreePath, '<wt>'], [setup.repoPath, '<repo>'], [setup.lane.id, '<lane>'], [packetId, '<packet>'],
    ]);
    expect(norm(off, 'pkt-wake-escalate-off')).toBe(norm(on, 'pkt-wake-escalate-on'));
  }, 60_000);
});

describe('wakeTriage replay label', () => {
  it('scores recorded triage events against the next outcome on the lane and sends nothing', async () => {
    fixture.reset();
    const seed = (packetId: string, probabilities: Record<string, number>, next: Array<[string, Record<string, unknown>]>) => {
      const lane = createLane({ repoPath: dataDir, worktreePath: dataDir, branch: `inline/${packetId}`, baseBranch: 'main', runtime: 'codex', label: packetId, packetId });
      appendEvent(lane.id, 'wake_triage', 'system', { receiptId: null, source: 'review-continuation', choice: 'wake', probabilities, confidence: 0.6, abstain: false, factsHash: 'x' });
      for (const [verb, payload] of next) appendEvent(lane.id, verb as never, 'system', payload);
    };
    seed('pkt-replay-merged', { handleInPlace: 0.7, queue: 0.2, wake: 0.1 }, [['merge', {}]]);
    seed('pkt-replay-steered', { handleInPlace: 0.1, queue: 0.2, wake: 0.7 }, [['steered_packet', { packetId: 'p' }]]);
    seed('pkt-replay-nothing', { handleInPlace: 0.2, queue: 0.6, wake: 0.2 }, []);
    seed('pkt-replay-asked', { handleInPlace: 0.3, queue: 0.3, wake: 0.4 }, [['status_change', { status: 'awaiting_human' }]]);

    const stdout: string[] = [];
    const code = await runReplay(['--label', 'wakeTriage'], { stdout: (text: string) => stdout.push(text), stderr: () => undefined });
    const text = stdout.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('mapping: merged -> handleInPlace, nothing -> queue, steered -> wake, redispatched -> wake, operatorAsked -> wake');
    expect(text).toMatch(/outcomes within 20 events: merged 1, nothing \d+, steered 1, redispatched 0, operatorAsked 1/);
    expect(text).toMatch(/wakeTriage wake: n=\d+ \(positives \d+, negatives \d+\)  AUC [\d.]+ \(n=\d+\)  Brier [\d.]+ \(n=\d+\)/);
    expect(fixture.seen).toHaveLength(0);
  });
});
