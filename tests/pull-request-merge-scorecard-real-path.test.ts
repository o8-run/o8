import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { closeDb, getSqlite } from '@/lib/db';
import { createLane, getLane, updateLane } from '@/lib/lane/registry';
import { upsertGitHubPullRequest } from '@/lib/github-broker/store';
import { runWorktreeReaperTick } from '@/lib/lane/worktree-reaper';
import { reviewScorecard } from '@/app/api/panel/analytics/review-scorecard';

const transport = vi.hoisted(() => vi.fn());
vi.mock('@/lib/github-broker/auth', () => ({ githubInstallationFetch: transport }));
vi.mock('@/lib/github-broker/sync', () => ({ ensureGitHubPullRequest: vi.fn(async () => ({ pr: null })) }));
// Deliberately held: recording a host merge must not depend on release permission.
vi.mock('@/lib/orchestrator/automatic-release', () => ({ releaseMergedPullRequestPacket: vi.fn(async () => 'held') }));
const root = mkdtempSync(join(tmpdir(), 'o8-merge-receipt-'));
execFileSync('git', ['init', '-q', '-b', 'main', root]);
execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/example/receipt.git']);
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  getSqlite().exec('DELETE FROM lane_events; DELETE FROM approvals; DELETE FROM lanes; DELETE FROM missions;');
  transport.mockReset();
});
const head = 'a'.repeat(40), mergeSha = 'b'.repeat(40);
const now = Date.now(), verdictAt = now - 20000, mergedAt = new Date(now - 10000).toISOString();
interface FixtureOptions { actor?: string | null; newer?: boolean; closed?: boolean; requeue?: boolean; incomplete?: boolean; approval?: boolean; unsupported?: boolean; mismatch?: boolean }
function fixture(options: FixtureOptions = {}) {
  const lane = createLane({ repoPath: root, branch: 'change', baseBranch: 'main', runtime: 'codex', packetId: 'receipt-packet' });
  updateLane(lane.id, { status: 'reviewing', prNumber: 1 }, 'system');
  const db = getSqlite();
  db.prepare('UPDATE lanes SET created_at=? WHERE id=?').run(new Date(now - 30000).toISOString(), lane.id);
  db.prepare(`INSERT INTO approvals (id,source,runtime,agent,session_key,title,description,summary,tool_name,args_json,
    packet_id,lane_id,risk,status,created_at,updated_at,audit_json,fingerprint)
    VALUES ('review','runtime','codex','reviewer','fixture','Review','','','orchestrator_review',?, 'receipt-packet',?,'low','approved',?,?,?,'fixture')`)
    .run(JSON.stringify({ reviewTurnOutcome: 'completed' }), lane.id, verdictAt, verdictAt,
      JSON.stringify([{ type: 'orchestrator_review', actor: 'orchestrator', timestamp: verdictAt, approved: true, reviewedHeadSha: head }]));
  const mergedHead = options.newer ? 'c'.repeat(40) : head;
  upsertGitHubPullRequest({ pullRequestId: 1, repoFullName: 'example/receipt', number: 1, title: 'fixture', state: 'closed',
    author: null, body: '', headRefName: 'change', baseRefName: 'main', additions: 1, deletions: 0, changedFiles: 1,
    reviewDecision: null, statusCheckRollup: [], url: 'https://example.test/pull/1',
    createdAt: new Date(now - 30000).toISOString(), updatedAt: mergedAt, closedAt: mergedAt,
    mergedAt: options.closed ? null : mergedAt, headSha: mergedHead, mergeCommit: mergeSha });
  transport.mockImplementation(async (_repo, _path, init) => {
    const after = JSON.parse(init.body).variables.after;
    if (after && options.incomplete) throw new Error('fixture page unavailable');
    const nodes = after ? [{ __typename: 'MergedEvent', createdAt: mergedAt,
      actor: options.actor === null ? null : { __typename: options.actor ?? 'Bot' }, commit: { oid: mergeSha } }]
      : [{ __typename: 'AddedToMergeQueueEvent', createdAt: new Date(verdictAt + 1000).toISOString(),
        actor: { __typename: 'Bot' }, enqueuer: { __typename: options.requeue ? 'User' : 'Bot' } }];
    return { response: Response.json({ data: { repository: { pullRequest: {
      headRefOid: options.mismatch ? 'd'.repeat(40) : mergedHead, mergedAt, mergeCommit: { oid: mergeSha },
      timelineItems: { nodes: [...nodes, ...(options.approval ? [{ __typename: 'PullRequestReview',
        submittedAt: new Date(verdictAt + 2000).toISOString(), author: { __typename: 'User' } }] : []),
        ...(options.unsupported ? [{ __typename: 'UnsupportedEvent' }] : [])], pageInfo: { hasNextPage: !after, endCursor: after ? null : 'page2' } },
    } } } }) };
  });
  return lane.id;
}
async function observe(id: string) {
  for (let pass = 0; pass < 16; pass++) {
    await runWorktreeReaperTick();
    if (getSqlite().prepare("SELECT 1 FROM lane_events WHERE lane_id=? AND verb='pull_request_merged'").get(id)) return;
  }
}
function score() { return reviewScorecard('7', 'all', root, now); }
function metric(id: string) { return score().metrics.find(row => row.id === id)!; }
const scenarios: Array<{ label: string; options: FixtureOptions; autonomous: number; human: number }> = [
  { label: 'automatic reviewed head', options: {}, autonomous: 1, human: 0 },
  { label: 'newer head', options: { newer: true }, autonomous: 0, human: 0 },
  { label: 'manual merge', options: { actor: 'User' }, autonomous: 0, human: 1 },
  { label: 'manual requeue', options: { requeue: true }, autonomous: 0, human: 1 },
  { label: 'manual approval', options: { approval: true }, autonomous: 0, human: 1 },
  { label: 'unsupported activity', options: { unsupported: true }, autonomous: 0, human: 0 },
  { label: 'inconsistent host head', options: { mismatch: true }, autonomous: 0, human: 0 },
  { label: 'unknown actor', options: { actor: null }, autonomous: 0, human: 0 },
  { label: 'partial timeline', options: { incomplete: true }, autonomous: 0, human: 0 },
];
it.each(scenarios)('projects $label through reconciliation and reviewScorecard', async ({ options, autonomous, human }) => {
  const id = fixture(options);
  await observe(id);
  const first = getSqlite().prepare("SELECT * FROM lane_events WHERE lane_id=? AND verb='pull_request_merged'").all(id);
  expect(first).toHaveLength(1);
  expect(JSON.parse((first[0] as { payload_json: string }).payload_json)).toMatchObject({
    reviewedHeadSha: head, mergedHeadSha: options.newer ? 'c'.repeat(40) : head,
    mergeSha, approvalId: 'review', mergedAt, humanIntervention: human ? 'human' : autonomous || options.newer ? 'none' : 'unknown',
  });
  expect(metric('without-person')).toMatchObject({ value: autonomous, display: `${autonomous} / 1 (${autonomous * 100}%)` });
  expect(metric('verdict-merge').value).toBe(10000);
  expect(metric('needed-person').value).toBe(human);
  expect(getLane(id)?.status).toBe('reviewing');
  closeDb(); // A fresh connection must find the durable ID, with no process-local dedupe.
  await observe(id);
  expect(getSqlite().prepare("SELECT * FROM lane_events WHERE lane_id=? AND verb='pull_request_merged'").all(id)).toEqual(first);
  expect(transport).toHaveBeenCalledTimes(options.unsupported || options.mismatch ? 1 : 2);
});
it('does not count a pull request closed without merging', async () => {
  const id = fixture({ closed: true });
  await observe(id);
  expect(metric('without-person').value).toBeNull();
  expect(metric('verdict-merge').value).toBeNull();
  expect(getSqlite().prepare("SELECT 1 FROM lane_events WHERE verb='pull_request_merged'").get()).toBeUndefined();
});
