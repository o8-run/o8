/** Drives the auto-review route, durable queue, retry turn, and approval store. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';

const reviewer = vi.hoisted(() => ({ moveHead: false, turns: 0, headB: '', blockedRepos: new Set<string>() }));
vi.mock('@/lib/lane/orchestrator-backends/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/orchestrator-backends/registry')>();
  const backend = {
    id: 'codex' as const,
    label: 'Test reviewer',
    peekSession: () => ({ sessionName: 'retry-head', status: 'ready' as const }),
    ensureSession: (repoPath: string) => ({ sessionName: 'retry-head',
      status: reviewer.blockedRepos.has(repoPath) ? 'busy' as const : 'ready' as const }),
    async sendTurn(repoPath: string, prompt: string, onEvent: (event: { type: 'text'; text: string }) => void) {
      reviewer.turns += 1;
      if (!prompt.includes('Verdict format retry')) {
        onEvent({ type: 'text', text: 'Review complete.' });
        return;
      }
      if (reviewer.moveHead) {
        writeFileSync(join(repoPath, 'successor.txt'), 'unreviewed successor');
        execFileSync('git', ['add', 'successor.txt'], { cwd: repoPath });
        execFileSync('git', ['commit', '-qm', 'successor'], { cwd: repoPath });
        reviewer.blockedRepos.add(repoPath);
        reviewer.headB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim();
      }
      onEvent({ type: 'text', text: 'CODEX_AUTO_REVIEW: {"approved":true,"findings":[]}' });
    },
  };
  return { ...actual, getActiveReviewerBackend: () => backend, getOrchestratorBackend: () => backend };
});
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/command-center/snapshot', () => ({ invalidateCommandCenterSnapshotCaches: vi.fn() }));
vi.mock('@/lib/mobile/inbox', () => ({ invalidateInboxCache: vi.fn() }));
vi.mock('@/lib/push/review-ready-coalescer', () => ({ enqueueReviewReady: vi.fn() }));
vi.mock('@/lib/orchestrator/context-relay', () => ({
  readPacketCompletionContext: vi.fn(async () => null),
}));
const dataDir = mkdtempSync(join(tmpdir(), 'o8-retry-head-data-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const repos: string[] = [];
const { closeDb, getSqlite } = await import('@/lib/db');
const { listApprovalsForContext } = await import('@/lib/approvals/store');
const { createLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const { drainReviewQueue } = await import('@/lib/lane/auto-review');
const route = await import('@/app/api/review/auto-review/route');

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
async function review(moveHead: boolean) {
  reviewer.moveHead = moveHead;
  reviewer.turns = 0;
  reviewer.headB = '';
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
  const packetId = `pkt-retry-head-${moveHead}`;
  const lane = createLane({ repoPath, worktreePath: repoPath, branch: 'fix/retry-head',
    baseBranch: 'main', runtime: 'codex', label: 'Retry HEAD fixture', packetId });
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
  closeDb();
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});
describe('auto-review verdict retry commit lock (#3053)', () => {
  it('discards a verdict and queues the successor when HEAD moves DURING the retry', async () => {
    const { lane, headA, approvals, rows } = await review(true);
    expect(reviewer.turns).toBe(2);
    expect(reviewer.headB).not.toBe(headA);
    expect(approvals).toHaveLength(0);
    expect(rows).toContainEqual(expect.objectContaining({ status: 'completed', head_sha: headA }));
    expect(rows).toContainEqual(expect.objectContaining({ status: 'pending', head_sha: reviewer.headB }));
    const turns = getLaneEvents(lane.id, 100).filter((event) => event.verb === 'review_turn_started');
    expect(turns).toHaveLength(2);
    expect(turns.every((event) => event.payload.expectedHeadSha === headA)).toBe(true);
  });
  it('persists the original HEAD with retry turn correlation when HEAD stays unchanged', async () => {
    const { lane, headA, approvals, rows } = await review(false);
    expect(reviewer.turns).toBe(2);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe('approved');
    expect(approvals[0]?.args?.reviewedHeadSha).toBe(headA);
    const turns = getLaneEvents(lane.id, 100).filter((event) => event.verb === 'review_turn_started');
    expect(approvals[0]?.args?.reviewTurnId).toBe(turns.find((event) => String(event.payload.threadId).endsWith('-verdict-retry'))?.payload.reviewTurnId);
    expect(turns.every((event) => event.payload.expectedHeadSha === headA)).toBe(true);
    expect(rows).toEqual([expect.objectContaining({ status: 'completed', head_sha: headA })]);
  });
});
