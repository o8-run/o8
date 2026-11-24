/** Drives the auto-review route, durable queue, retry turn, and approval store. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

const reviewer = vi.hoisted(() => ({ turns: 0, mode: 'repair', prompts: [] as string[], primaryText: '', packetId: '', toolResult: '' }));
vi.mock('@/lib/lane/orchestrator-backends/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/orchestrator-backends/registry')>();
  const backend = {
    id: 'codex' as const,
    label: 'Test reviewer',
    peekSession: () => ({ sessionName: 'retry-head', status: 'ready' as const }),
    ensureSession: () => ({ sessionName: 'retry-format', status: 'ready' as const }),
    async sendTurn(_repoPath: string, prompt: string, onEvent: (event: { type: 'text'; text: string }) => void) {
      reviewer.turns += 1;
      reviewer.prompts.push(prompt);
      const transcriptRoute = await import('@/app/api/orchestrator/packet-transcript/route');
      const response = await transcriptRoute.GET(new NextRequest(
        `http://localhost/api/orchestrator/packet-transcript?packetId=${reviewer.packetId}&tail=true&limit=20`,
        { headers: { host: 'localhost' } },
      ));
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).toContain('Process evidence: verification was skipped.');
      const retry = prompt.includes('Verdict format retry');
      if (retry && reviewer.mode === 'tool-contradict') {
        const { handleSubmitReview } = await import('@/lib/mcp/operator-handlers/mission');
        reviewer.toolResult = JSON.stringify(await handleSubmitReview({
          packetId: reviewer.packetId, approved: true, findings: [],
          formatRetryRejecting: false,
        }));
      }
      const text = !retry ? reviewer.primaryText
        : ['contradict', 'tool-contradict'].includes(reviewer.mode) ? 'CODEX_AUTO_REVIEW: {"approved":true,"findings":[]}'
          : reviewer.mode === 'malformed' ? reviewer.primaryText
            : 'CODEX_AUTO_REVIEW: {"approved":false,"findings":[{"file":"result.txt","severity":"rule_violation","description":"Required verification was skipped.","status":"deferred"}]}';
      onEvent({ type: 'text', text });
    },
  };
  return { ...actual, getActiveReviewerBackend: () => backend, getOrchestratorBackend: () => backend };
});
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
vi.mock('@/lib/push/review-ready-coalescer', () => ({ enqueueReviewReady: vi.fn() }));
const dataDir = mkdtempSync(join(tmpdir(), 'o8-retry-head-data-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const repos: string[] = [];
writeFileSync(join(dataDir, 'ws-token'), 'test-review-format-token-0123456789abcdef');
process.env.O8_OWNED_OPENCODE_ROOT = join(dataDir, 'owned-opencode');
const { closeDb, getSqlite } = await import('@/lib/db');
const { listApprovalsForContext } = await import('@/lib/approvals/store');
const { createLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { drainReviewQueue } = await import('@/lib/lane/auto-review');
const route = await import('@/app/api/review/auto-review/route');
const submitRoute = await import('@/app/api/orchestrator/review/route');
vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.pathname !== '/api/orchestrator/review') throw new Error(`Unexpected fetch: ${url.pathname}`);
  return submitRoute.POST(new NextRequest(url, { method: init?.method, headers: init?.headers, body: init?.body }));
});

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
async function review(mode: string) {
  reviewer.mode = mode;
  reviewer.turns = 0;
  reviewer.prompts = [];
  reviewer.primaryText = mode === 'optimistic'
    ? 'CODEX_AUTO_REVIEW: {"approved":true,"findings":[{"severity":"note","description":"Required verification was skipped.","status":"deferred"}]}'
    : mode === 'valid' ? 'CODEX_AUTO_REVIEW: {"approved":true,"findings":[]}'
    : 'CODEX_AUTO_REVIEW: {"approved":false,"findings":[{"severity":"rule_violation","description":"Required verification was skipped.","status":"deferred"}]}';
  const repoPath = mkdtempSync(join(tmpdir(), 'o8-retry-head-repo-'));
  repos.push(repoPath);
  git(repoPath, ['init', '-qb', 'main']);
  git(repoPath, ['config', 'user.name', 'test']);
  git(repoPath, ['config', 'user.email', 'test@example.test']);
  writeFileSync(join(repoPath, 'README.md'), 'base');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-qm', 'base']);
  git(repoPath, ['checkout', '-qb', 'fix/retry-head']);
  writeFileSync(join(repoPath, 'result.txt'), 'reviewed result');
  git(repoPath, ['add', 'result.txt']);
  git(repoPath, ['commit', '-qm', 'result']);
  const headA = git(repoPath, ['rev-parse', 'HEAD']);
  const packetId = `pkt-retry-format-${mode}`;
  reviewer.packetId = packetId;
  const sessionId = `session-${mode}`;
  const sessionKey = `opencode-owned:${sessionId}`;
  const sessionDir = join(process.env.O8_OWNED_OPENCODE_ROOT!, sessionId);
  const runsDir = join(sessionDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  const stdoutPath = join(runsDir, 'run.stdout.jsonl');
  const stderrPath = join(runsDir, 'run.stderr.log');
  const startedAt = '2026-10-01T00:00:00.000Z';
  const contract = { version: 1, requirements: [{ id: 'R1', source: 'Write result.',
    expectedBehavior: 'Result exists.', productionPath: 'result.txt', verification: 'read result' }],
    smallestRoute: [{ path: 'result.txt', requirements: ['R1'], reason: 'Deliver result.' }],
    processConstraints: [{ id: 'P1', source: 'Run verification.', expectedBehavior: 'Verification ran.',
      verification: 'transcript command evidence' }], exclusions: [] };
  writeFileSync(stdoutPath, [
    { type: 'text', timestamp: startedAt, part: { type: 'text', text: `<task-contract>${JSON.stringify(contract)}</task-contract>` } },
    { type: 'text', timestamp: startedAt, part: { type: 'text', text: 'Process evidence: verification was skipped.' } },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');
  writeFileSync(stderrPath, '');
  const run = { id: 'run', mode: 'launch', prompt: 'Write result and verify.', startedAt,
    pid: 2147483647, stdoutPath, stderrPath, outcome: 'completed' };
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ surfaceId: sessionKey, sessionDir,
    cwd: repoPath, repoPath, title: 'Review evidence fixture', createdAt: startedAt, updatedAt: startedAt,
    latestPrompt: run.prompt, latestSummary: 'completed', activeRun: null, recentRuns: [run] }));
  const lane = createLane({ repoPath, worktreePath: repoPath, branch: 'fix/retry-head',
    baseBranch: 'main', runtime: 'opencode', label: 'Retry format fixture', packetId, sessionKey });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  const response = await route.POST(new NextRequest('http://localhost/api/review/auto-review', {
    method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'enqueue', laneId: lane.id }),
  }));
  expect(response.status).toBe(200);
  await drainReviewQueue();
  const approvals = listApprovalsForContext({ packetId, laneId: lane.id })
    .filter((approval) => approval.toolName === 'orchestrator_review');
  const rows = getSqlite().prepare('SELECT status, head_sha, last_error FROM review_queue WHERE lane_id = ? ORDER BY rowid')
    .all(lane.id) as Array<{ status: string; head_sha: string; last_error: string | null }>;
  return { lane, headA, approvals, rows };
}
afterAll(() => {
  vi.restoreAllMocks();
  closeDb();
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});
describe('auto-review verdict format recovery (#3057)', () => {
  it('repairs malformed rejecting findings with exact diagnostic and transcript evidence context', async () => {
    const { lane, headA, approvals } = await review('repair');
    expect(reviewer.turns).toBe(2);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.args?.approved).toBe(false);
    expect(approvals[0]?.args?.reviewedHeadSha).toBe(headA);
    const turns = getLaneEvents(lane.id, 100).filter((event) => event.verb === 'review_turn_started');
    expect(approvals[0]?.args?.reviewTurnId).toBe(turns.find((event) => String(event.payload.threadId).endsWith('-verdict-retry'))?.payload.reviewTurnId);
    expect(turns.every((event) => event.payload.expectedHeadSha === headA)).toBe(true);
    for (const prompt of reviewer.prompts) {
      expect(prompt).toContain(`o8_packet_transcript({"packetId":"${reviewer.packetId}","tail":true,"limit":50})`);
    }
    expect(reviewer.prompts[1]).toContain('findings[0] must include file and description');
    expect(reviewer.prompts[1]).toContain('UNTRUSTED');
    expect(reviewer.prompts[1]).toContain(JSON.stringify(reviewer.primaryText));
    expect(reviewer.prompts[1]).toContain('"file":"<verified repo-relative file>"');
  });
  it('refuses a contradictory approval during a rejection format retry', async () => {
    const { lane, approvals } = await review('contradict');
    expect(reviewer.turns).toBe(2);
    expect(approvals).toHaveLength(0);
    expect(getLaneEvents(lane.id, 100).some((event) => event.verb === 'review_unavailable')).toBe(true);
  });
  it('refuses an approval through the actual submit_review tool during rejection format repair', async () => {
    const { lane, approvals } = await review('tool-contradict');
    expect(reviewer.turns).toBe(2);
    expect(reviewer.toolResult).toContain('review_format_decision_conflict');
    expect(approvals).toHaveLength(0);
    expect(getLaneEvents(lane.id, 100).some((event) => event.verb === 'review_format_decision_rejected')).toBe(true);
    const { handleSubmitReview } = await import('@/lib/mcp/operator-handlers/mission');
    const standalone = await handleSubmitReview({ packetId: reviewer.packetId, approved: true, findings: [] });
    expect(JSON.parse(standalone.content.find((entry) => entry.type === 'text')!.text!).recorded).toBe(true);
    expect(listApprovalsForContext({ packetId: reviewer.packetId, laneId: lane.id })
      .filter((approval) => approval.toolName === 'orchestrator_review')).toHaveLength(1);
  });
  it('keeps a second malformed verdict unavailable without persisting approval', async () => {
    const { lane, approvals } = await review('malformed');
    expect(reviewer.turns).toBe(2);
    expect(approvals).toHaveLength(0);
    const unavailable = getLaneEvents(lane.id, 100).find((event) => event.verb === 'review_unavailable');
    expect(unavailable?.payload.reason).toContain('findings[0] must include file and description');
  });
  it('allows a safe downgrade of a malformed optimistic decision', async () => {
    const { approvals } = await review('optimistic');
    expect(reviewer.turns).toBe(2);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.args?.approved).toBe(false);
  });
  it('keeps valid primary approvals unchanged without a format retry', async () => {
    const { headA, approvals } = await review('valid');
    expect(reviewer.turns).toBe(1);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.args).toMatchObject({ approved: true, reviewedHeadSha: headA });
  });
});
