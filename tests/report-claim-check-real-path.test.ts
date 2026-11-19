/**
 * #2447 — claim versus evidence on the worker's final report, record-only.
 *
 * Real-path doctrine: the real completion entry point (`handleAgentCompletion`)
 * moves the lane to reviewing and reaches the real
 * `capturePacketCompletionContext`, whose new `session_outcomes` row starts
 * the check. The diff comes from a real git worktree, the provider setting
 * from the real operator-defaults store, the key from the data-dir key file,
 * and the call goes over HTTP to the local systemone fixture. Stubbed: the
 * completion typecheck, the liveness probe, the cost write, the machine
 * capacity snapshot, and the runtime transcript (a registered runtime returns
 * a fixed transcript), except in the Codex adapter case, which reads a real
 * Codex rollout JSONL through the real codex runtime's readTranscript.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { AgentRuntime, RuntimeTranscriptEntry } from '@/lib/runtimes/types';
import { startJudgmentEndpointFixture, type JudgmentEndpointFixture } from './fixtures/judgment-endpoint';

const h = vi.hoisted(() => ({
  transcripts: new Map<string, RuntimeTranscriptEntry[]>(),
  /** Baseline switch: behave as if the completion path never started a check. */
  withoutCheck: false,
}));

vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [] }) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/supervisor/completion-liveness', () => ({ shouldDeferCompletionForLiveRuntime: vi.fn(async () => false) }));
vi.mock('@/lib/orchestrator/cost-persistence', () => ({ persistRuntimeSessionCost: vi.fn(async () => {}) }));
vi.mock('@/lib/lane/no-changes-produced', () => ({ probeNoChangesProduced: vi.fn(async () => ({ noChangesProduced: false })) }));
vi.mock('@/lib/supervisor/completion-verification', () => ({
  runCompletionVerification: vi.fn(async () => ({ ok: true, kind: 'typecheck', output: '' })),
  autoCommitCompletionWorktree: vi.fn(async () => false),
}));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/search/transcripts', () => ({ syncTranscriptSearchDocument: () => undefined }));
vi.mock('@/lib/cortex/qa/ask', () => ({ invalidateAnswerCache: () => undefined }));
vi.mock('@/lib/lane/report-claim-check', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/report-claim-check')>();
  return {
    ...actual,
    startReportClaimCheck: (...args: Parameters<typeof actual.startReportClaimCheck>) => (
      h.withoutCheck ? undefined : actual.startReportClaimCheck(...args)
    ),
  };
});

const originalEnv = {
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
};
const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-report-claim-check-data-'));
const codexHome = join(dataDir, 'codex-home');
const WORKER_TOKEN = 'local-worker-token-report-claim-2447-0123456789';
const WS_TOKEN = 'operator-ws-token-report-claim-2447-abcdef';
writeFileSync(join(dataDir, 'worker-token'), `${WORKER_TOKEN}\n`, 'utf-8');
writeFileSync(join(dataDir, 'ws-token'), `${WS_TOKEN}\n`, 'utf-8');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.CODEX_HOME = codexHome;

const { getSqlite } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { handleAgentCompletion } = await import('@/lib/supervisor/agent-completion');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { judgmentKeyPath } = await import('@/lib/judgment/key');
const { registerRuntime } = await import('@/lib/runtimes/registry');
const { setReportClaimCheckTransportForTests, waitForReportClaimCheck, readLatestClaimUnbacked } = await import('@/lib/lane/report-claim-check');
const { codexRuntime } = await import('@/lib/runtimes/codex');
const { getPacketTailBatch } = await import('@/lib/lane/packet-tail');

const KEY = 'ts-fixture-key-report-claim-2447';
const PACKET_TITLE = 'Rewrite the billing reconciler';
const REPORT_CLAIMING_TESTS = `Done with ${PACKET_TITLE}. Updated src/feature.ts. Ran npm test: all 42 tests pass, and npx tsc is clean.`;
const TEST_OUTPUT = '$ npm test\n Test Files  3 passed (3)\n      Tests  42 passed (42)';

const dependencies = {
  enqueueAutoReview: vi.fn(async () => {}),
  triggerHeadlessSprintTick: vi.fn(async () => {}),
  queueReviewContinuation: vi.fn(),
  enqueueVerificationFailureInboxItem: vi.fn(async () => 'test-inbox'),
};

let fixture: JudgmentEndpointFixture;
const gitDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function reportReply(answers: { claimsTestsRun: number; evidenceShowsTestsRun: number; claimsFilesNotInDiff: number; claimsVerifiedRealPath: number }) {
  return {
    status: 200,
    body: {
      model: 'jev-1.13.0',
      answers: Object.fromEntries(Object.entries(answers).map(([id, noul]) => [id, { type: 'noul', noul }])),
      usage: { input_tokens: 388, output_tokens: 16 },
    },
  };
}

function transcriptFor(packetId: string, withTestOutput: boolean): RuntimeTranscriptEntry[] {
  const at = (second: number) => new Date(`2026-09-18T10:00:${String(second).padStart(2, '0')}.000Z`);
  return [
    { id: `${packetId}:prompt`, role: 'user', text: `Packet: ${PACKET_TITLE}. Implement the feature.`, timestamp: at(0) },
    ...(withTestOutput ? [{ id: `${packetId}:tool`, role: 'tool' as const, toolName: 'exec', text: TEST_OUTPUT, timestamp: at(1) }] : []),
    { id: `${packetId}:report`, role: 'assistant', text: REPORT_CLAIMING_TESTS, timestamp: at(2) },
  ];
}

function packetFixture(id: string, repoPath: string): OrchestratorPacket {
  return {
    id, referenceLabel: id, title: PACKET_TITLE, summary: 'Worker-written summary.', runtime: 'codex',
    workspaceTargetPath: repoPath, branchTarget: `inline/${id}`,
    dependencyLabels: [], dependencyPacketIds: [], queueState: 'queued',
    releaseState: 'pending', status: 'running', blockedReason: null,
    lastEventAt: null, lastEventLabel: null, lane: null, review: null,
  } as OrchestratorPacket;
}

/** A real repo whose packet branch changes src/feature.ts against main, and a running lane on it. */
function setupPacket(packetId: string, withTestOutput: boolean, sessionKey = `codex-owned:${packetId}`) {
  const root = mkdtempSync(join(os.tmpdir(), `${packetId}-`));
  gitDirs.push(root);
  git(root, ['init', '--initial-branch=main']);
  git(root, ['config', 'user.name', 'o8-test']);
  git(root, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(root, 'README.md'), 'report claim check\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'base']);
  git(root, ['checkout', '-b', `inline/${packetId}`]);
  execFileSync('mkdir', ['-p', join(root, 'src')]);
  writeFileSync(join(root, 'src', 'feature.ts'), 'export const feature = true;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'feature']);
  const repoPath = realpathSync(root);

  writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(), repoPath, packets: [packetFixture(packetId, repoPath)] });
  h.transcripts.set(sessionKey, transcriptFor(packetId, withTestOutput));
  const lane = createLane({
    repoPath, worktreePath: repoPath, branch: `inline/${packetId}`, baseBranch: 'main',
    runtime: 'codex', label: PACKET_TITLE, packetId, sessionKey,
  });
  return { lane, sessionKey, repoPath };
}

const BRIEF_TEXT = `BRIEF-2447 Packet: ${PACKET_TITLE}. Implement the feature and keep this brief private.`;
const PROGRESS_TEXT = 'Reading the module before editing.';
const FINAL_REPORT = 'Updated src/feature.ts. Ran npm test: all 42 tests pass.';
const STEER_TEXT = 'STEER-2447 from the orchestrator: also run lint before you stop.';

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A real Codex home: `state_5.sqlite` with the thread row and the rollout
 * JSONL the codex runtime parses. The window ends on an orchestrator steer
 * (a user message) AFTER the worker's final assistant message.
 */
function writeCodexSession(threadId: string, cwd: string): void {
  const rolloutDir = join(codexHome, 'sessions', '2026', '09', '18');
  mkdirSync(rolloutDir, { recursive: true });
  const rolloutPath = join(rolloutDir, `rollout-${threadId}.jsonl`);
  const at = (second: number) => `2026-09-18T10:00:${String(second).padStart(2, '0')}.000Z`;
  const message = (role: 'user' | 'assistant', text: string, second: number) => ({
    timestamp: at(second),
    type: 'response_item',
    payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
  });
  const lines = [
    { timestamp: at(0), type: 'session_meta', payload: { id: threadId, cwd } },
    message('user', BRIEF_TEXT, 1),
    message('assistant', PROGRESS_TEXT, 2),
    { timestamp: at(3), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}', call_id: 'call-1' } },
    { timestamp: at(4), type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: TEST_OUTPUT } },
    message('assistant', FINAL_REPORT, 5),
    message('user', STEER_TEXT, 6),
  ];
  writeFileSync(rolloutPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  const db = join(codexHome, 'state_5.sqlite');
  execFileSync('sqlite3', [db, [
    'create table if not exists threads (',
    'id text primary key, title text, cwd text, updated_at integer, rollout_path text,',
    'git_branch text, git_sha text, git_origin_url text, first_user_message text, model text, archived integer',
    ');',
    'create table if not exists logs (thread_id text, process_uuid text, ts integer);',
    `insert into threads values (${sqlString(threadId)}, 'fixture', ${sqlString(cwd)}, ${Math.floor(Date.now() / 1_000)}, ${sqlString(rolloutPath)}, 'main', 'abc123', '', 'fixture task', 'fixture-model', 0);`,
  ].join(' ')]);
}

async function complete(packetId: string, sessionKey: string) {
  await handleAgentCompletion(sessionKey, 'completed', dependencies);
  await vi.waitFor(() => {
    expect(getSqlite().prepare('SELECT 1 AS ok FROM session_outcomes WHERE packet_id = ?').get(packetId)).toEqual({ ok: 1 });
  }, { timeout: 10_000 });
}

/** Wait for the detached check: its receipt, then its settle (event written or not). */
async function settleCheck(laneId: string, packetId: string) {
  await vi.waitFor(() => {
    expect(judgmentEvents(laneId)).toHaveLength(1);
  }, { timeout: 10_000 });
  await waitForReportClaimCheck(packetId);
}

function orderedEvents(laneId: string) {
  return (getSqlite().prepare('SELECT verb, actor, payload_json FROM lane_events WHERE lane_id = ? ORDER BY rowid')
    .all(laneId) as Array<{ verb: string; actor: string; payload_json: string }>)
    .map((row) => ({ verb: row.verb, actor: row.actor, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
}

const judgmentEvents = (laneId: string) => orderedEvents(laneId).filter((event) => event.verb === 'judgment');
const claimEvents = (laneId: string) => orderedEvents(laneId).filter((event) => event.verb === 'claim_unbacked');

/** Persisted rows the completion path wrote, with per-packet ids, paths, and clocks normalized. */
function persistedRows(setup: ReturnType<typeof setupPacket>, packetId: string): string {
  const outcome = getSqlite().prepare(`
    SELECT project_id, repo_path, branch, runtime, session_key, lane_id, packet_id, outcome, summary,
      changed_files_json, model, total_tokens, cost_usd, attempts, review_approved, review_findings_count, merged_clean
    FROM session_outcomes WHERE packet_id = ?
  `).all(packetId);
  const text = JSON.stringify({ events: orderedEvents(setup.lane.id), outcome });
  return text
    .split(setup.repoPath).join('<repo>')
    .split(setup.lane.id).join('<lane>')
    .split(packetId).join('<packet>')
    .replace(/"baseCommit":"[0-9a-f]+"/g, '"baseCommit":"<sha>"')
    .replace(/"(timestamp|at|updatedAt|completedAt|startedAt)":"[^"]*"/g, '"$1":"<t>"');
}

beforeAll(async () => {
  await updateOperatorDefaults({ productTelemetryEnabled: false });
  fixture = await startJudgmentEndpointFixture();
  setReportClaimCheckTransportForTests({ endpoint: fixture.endpoint, timeoutMs: 2_000, maxAttempts: 1 });
  writeFileSync(judgmentKeyPath(), `${KEY}\n`);
  chmodSync(judgmentKeyPath(), 0o600);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

beforeEach(async () => {
  // Re-register each case: a lazy runtime-index import in the completion path
  // registers the real codex adapter over this one.
  const runtime: AgentRuntime = {
    id: 'codex',
    displayName: 'Report claim check test runtime',
    capabilities: {
      discover: false, readTranscript: true, launch: false, resume: false,
      interrupt: false, reviewDiffs: true, costTelemetry: false, streaming: false,
    },
    discoverSessions: async () => [],
    readTranscript: async (sessionKey) => h.transcripts.get(sessionKey) ?? [],
    launch: async () => ({ ok: false, note: 'not supported' }),
    resume: async () => ({ ok: false, note: 'not supported' }),
    interrupt: async () => ({ ok: false, note: 'not supported' }),
    getChangedFiles: async () => [],
  };
  registerRuntime(runtime);
  fixture.reset();
  h.withoutCheck = false;
  await updateOperatorDefaults({ judgmentProvider: 'typesafe' });
});

afterAll(async () => {
  setReportClaimCheckTransportForTests(undefined);
  vi.restoreAllMocks();
  await fixture.close();
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  for (const dir of gitDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe('claim-versus-evidence check at packet completion', () => {
  it('records claim_unbacked naming tests and the receipt id when the report claims a test run the transcript does not show', async () => {
    const setup = setupPacket('pkt-claim-unbacked', false);
    fixture.replies.push(reportReply({ claimsTestsRun: 0.94, evidenceShowsTestsRun: 0.03, claimsFilesNotInDiff: 0.06, claimsVerifiedRealPath: 0.21 }));

    await complete('pkt-claim-unbacked', setup.sessionKey);
    await settleCheck(setup.lane.id, 'pkt-claim-unbacked');

    const receipt = judgmentEvents(setup.lane.id)[0].payload;
    expect(receipt).toMatchObject({ ok: true, surface: 'report-claim-check', packetId: 'pkt-claim-unbacked' });
    const claims = claimEvents(setup.lane.id);
    expect(claims).toHaveLength(1);
    expect(claims[0].payload).toMatchObject({
      receiptId: receipt.receiptId,
      packetId: 'pkt-claim-unbacked',
      claims: ['tests'],
      verificationOutputPresent: false,
      changedFileCount: 1,
      answers: { claimsTestsRun: 0.94, evidenceShowsTestsRun: 0.03, claimsFilesNotInDiff: 0.06, claimsVerifiedRealPath: 0.21 },
    });
    // Recorded after the outcome row and the reviewing transition, never before.
    const verbs = orderedEvents(setup.lane.id).map((event) => event.verb);
    expect(verbs.indexOf('claim_unbacked')).toBeGreaterThan(verbs.lastIndexOf('status_change'));

    expect(fixture.seen).toHaveLength(1);
    const body = fixture.seen[0].body as { state: { report: { text: string }; changedFiles: string[]; verification: { outputPresent: boolean; tail: string | null } }; questions: object };
    expect(Object.keys(body.questions)).toEqual(['claimsTestsRun', 'evidenceShowsTestsRun', 'claimsFilesNotInDiff', 'claimsVerifiedRealPath']);
    expect(body.state.changedFiles).toEqual(['src/feature.ts']);
    expect(body.state.verification).toEqual({ outputPresent: false, tail: null, truncated: false });
    expect(body.state.report.text).toContain('Ran npm test: all 42 tests pass');
  }, 30_000);

  it('writes a receipt and no claim_unbacked event when the recorded output backs the claim', async () => {
    const setup = setupPacket('pkt-claim-backed', true);
    fixture.replies.push(reportReply({ claimsTestsRun: 0.95, evidenceShowsTestsRun: 0.92, claimsFilesNotInDiff: 0.04, claimsVerifiedRealPath: 0.3 }));

    await complete('pkt-claim-backed', setup.sessionKey);
    await settleCheck(setup.lane.id, 'pkt-claim-backed');

    expect(judgmentEvents(setup.lane.id)[0].payload).toMatchObject({ ok: true, surface: 'report-claim-check' });
    expect(claimEvents(setup.lane.id)).toHaveLength(0);
    const body = fixture.seen[0].body as { state: { verification: { outputPresent: boolean; tail: string | null } } };
    expect(body.state.verification.outputPresent).toBe(true);
    expect(body.state.verification.tail).toContain('Tests  42 passed');
  }, 30_000);

  it('never sends the packet title to the provider', async () => {
    const setup = setupPacket('pkt-claim-title', true);
    fixture.replies.push(reportReply({ claimsTestsRun: 0.9, evidenceShowsTestsRun: 0.9, claimsFilesNotInDiff: 0.1, claimsVerifiedRealPath: 0.1 }));

    await complete('pkt-claim-title', setup.sessionKey);
    await settleCheck(setup.lane.id, 'pkt-claim-title');

    expect(fixture.seen).toHaveLength(1);
    const sent = JSON.stringify(fixture.seen[0].body);
    expect(sent).not.toContain(PACKET_TITLE);
    expect(sent).not.toContain('Implement the feature');
    expect(sent).not.toContain('Worker-written summary');
  }, 30_000);

  it('leaves the completion path persisted rows identical and sends nothing when judgment.provider is off', async () => {
    await updateOperatorDefaults({ judgmentProvider: 'off' });
    h.withoutCheck = true;
    const baseline = setupPacket('pkt-claim-baseline', false);
    await complete('pkt-claim-baseline', baseline.sessionKey);
    const baselineRows = persistedRows(baseline, 'pkt-claim-baseline');

    h.withoutCheck = false;
    const off = setupPacket('pkt-claim-off', false);
    fixture.replies.push(reportReply({ claimsTestsRun: 0.94, evidenceShowsTestsRun: 0.03, claimsFilesNotInDiff: 0.06, claimsVerifiedRealPath: 0.2 }));
    await complete('pkt-claim-off', off.sessionKey);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(persistedRows(off, 'pkt-claim-off')).toBe(baselineRows);
    expect(baselineRows).toContain('agent_completed');
    expect(fixture.seen).toHaveLength(0);
    expect(judgmentEvents(off.lane.id)).toHaveLength(0);
  }, 30_000);

  it('reads the report through the real Codex adapter: a trailing orchestrator steer is never sent as the report', async () => {
    const threadId = 'thread-report-claim-2447';
    const setup = setupPacket('pkt-claim-codex', false, `codex:${threadId}`);
    writeCodexSession(threadId, setup.repoPath);
    registerRuntime(codexRuntime);
    fixture.replies.push(reportReply({ claimsTestsRun: 0.93, evidenceShowsTestsRun: 0.91, claimsFilesNotInDiff: 0.05, claimsVerifiedRealPath: 0.2 }));

    await complete('pkt-claim-codex', setup.sessionKey);
    await settleCheck(setup.lane.id, 'pkt-claim-codex');

    expect(fixture.seen).toHaveLength(1);
    const body = fixture.seen[0].body as { state: { report: { text: string }; verification: { outputPresent: boolean; tail: string | null } } };
    expect(body.state.report.text).toBe(FINAL_REPORT);
    expect(body.state.verification.outputPresent).toBe(true);
    // The codex parser collapses whitespace in tool output.
    expect(body.state.verification.tail).toContain('Tests 42 passed (42)');
    const sent = JSON.stringify(fixture.seen[0].body);
    expect(sent).not.toContain('STEER-2447');
    expect(sent).not.toContain('BRIEF-2447');
    expect(sent).not.toContain(PACKET_TITLE);
  }, 30_000);

  it('keeps the latest advisory readable from lane data and the live packet-tail path', async () => {
    const unbacked = setupPacket('pkt-claim-route-unbacked', false);
    fixture.replies.push(reportReply({ claimsTestsRun: 0.94, evidenceShowsTestsRun: 0.03, claimsFilesNotInDiff: 0.06, claimsVerifiedRealPath: 0.2 }));
    await complete('pkt-claim-route-unbacked', unbacked.sessionKey);
    await settleCheck(unbacked.lane.id, 'pkt-claim-route-unbacked');
    const clean = setupPacket('pkt-claim-route-clean', true);
    fixture.replies.push(reportReply({ claimsTestsRun: 0.95, evidenceShowsTestsRun: 0.92, claimsFilesNotInDiff: 0.04, claimsVerifiedRealPath: 0.3 }));
    await complete('pkt-claim-route-clean', clean.sessionKey);
    await settleCheck(clean.lane.id, 'pkt-claim-route-clean');

    const recorded = claimEvents(unbacked.lane.id)[0].payload;
    expect(readLatestClaimUnbacked(unbacked.lane.id)).toEqual(recorded);
    expect(readLatestClaimUnbacked(clean.lane.id)).toBeNull();
    expect(readLatestClaimUnbacked('missing-lane')).toBeNull();
    const tail = await getPacketTailBatch({ packetId: 'pkt-claim-route-unbacked', since: 0 });
    expect(tail.events).toContainEqual(expect.objectContaining({
      verb: 'claim_unbacked', laneId: unbacked.lane.id, payload: recorded,
    }));
  }, 60_000);
});
