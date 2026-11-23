import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApproval, getApproval, listApprovals, listUnsettledApprovalContinuations } from '@/lib/approvals/store';
import { claimApprovalResolution, finalizeApprovalContinuation } from '@/lib/approvals/resolution';
import { getSqlite } from '@/lib/db';
import { createLane, setLaneStatus } from '@/lib/lane/registry';
import type { ApprovalRecord } from '@/lib/approvals/types';

vi.mock('@/lib/repos/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/repos/projects')>(),
  getActiveProjectScopeForRepoSync: () => ({ projectId: 'query-project-a' }),
}));
vi.mock('@/lib/push/notify', () => ({ notifyApprovalCreated: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

let sequence = 0;
function fixture(projectId: string | null = 'query-project-a', sessionKey = 'query-session-a', args?: ApprovalRecord['args'], laneId = 'missing-query-lane') {
  const approval = createApproval({
    projectId, source: 'test', runtime: 'codex', agent: 'worker', sessionKey,
    title: 'Query fixture', description: 'Query fixture', summary: `query-${++sequence}`,
    risk: 'low', args, continuation: { kind: 'lane', laneId, verb: 'merge' },
  });
  getSqlite().prepare('UPDATE approvals SET created_at = ? WHERE id = ?').run(Date.now() + sequence, approval.id);
  return approval;
}

describe('idle approval queries retain scope and history', () => {
  it('returns only unfinished continuations without decoding settled history', () => {
    const settled = fixture();
    const historyJson = JSON.stringify({ largeHistoryMarker: 'x'.repeat(1024 * 1024) });
    getSqlite().prepare('UPDATE approvals SET args_json = ? WHERE id = ?').run(historyJson, settled.id);
    const pending = fixture();
    claimApprovalResolution(pending.id, 'approve', 'desktop');
    const unknown = fixture();
    const claim = claimApprovalResolution(unknown.id, 'approve', 'desktop');
    finalizeApprovalContinuation(unknown.id, claim.claimId!, 'outcome_unknown', 'Receipt missing');
    const hidden = fixture('query-project-a', 'query-session-a', { approvalRoute: 'dispatcher', dispatcherSurface: 'worker' });
    claimApprovalResolution(hidden.id, 'approve', 'desktop');
    const invalid = fixture();
    getSqlite().prepare('UPDATE approvals SET resolution_json = ? WHERE id = ?').run('{broken', invalid.id);
    const parse = vi.spyOn(JSON, 'parse');

    const results = listUnsettledApprovalContinuations();

    expect(new Set(results.map((row) => row.id))).toEqual(new Set([pending.id, unknown.id]));
    expect(parse.mock.calls.some(([value]) => value === historyJson)).toBe(false);
    expect(getApproval(settled.id)?.id).toBe(settled.id);
    expect(getApproval(invalid.id)?.resolution).toBeUndefined();
  });

  it('preserves active-project defaults, explicit all-project scope, and session filters', () => {
    const a = fixture();
    const b = fixture('query-project-b');
    const otherSession = fixture('query-project-a', 'query-session-b');
    for (const row of [a, b, otherSession]) claimApprovalResolution(row.id, 'approve', 'desktop');
    const all = listApprovals({ status: 'all', projectId: null });
    for (const projectId of [undefined, null, 'query-project-a', 'query-project-b', ' ']) {
      for (const sessionKey of [undefined, 'query-session-a', 'query-session-b']) {
        const expectedProject = projectId === undefined ? 'query-project-a' : projectId?.trim() || null;
        const expected = all.filter((row) => (!expectedProject || row.projectId === expectedProject)
          && (!sessionKey || row.sessionKey === sessionKey));
        for (const status of ['all', 'pending', 'approved', 'rejected'] as const) {
          expect(listApprovals({ status, projectId, sessionKey }))
            .toEqual(expected.filter((row) => status === 'all' || row.status === status));
        }
        expect(listUnsettledApprovalContinuations({ projectId, sessionKey }))
          .toEqual(expected.filter((row) => ['pending', 'outcome_unknown'].includes(row.resolution?.continuationStatus ?? '')));
      }
    }
  });

  it('does not decode an unsettled continuation whose lane already finished', () => {
    const finishedLane = createLane({ repoPath: '/tmp/query-repo', projectId: 'query-project-a', branch: 'query-finished', runtime: 'codex' });
    setLaneStatus(finishedLane.id, 'completed');
    const finished = fixture('query-project-a', 'query-session-a', undefined, finishedLane.id);
    claimApprovalResolution(finished.id, 'approve', 'desktop');
    const diffJson = JSON.stringify({ largeDiffMarker: 'x'.repeat(1024 * 1024) });
    getSqlite().prepare('UPDATE approvals SET diff_json = ? WHERE id = ?').run(diffJson, finished.id);
    const open = fixture();
    claimApprovalResolution(open.id, 'approve', 'desktop');
    const parse = vi.spyOn(JSON, 'parse');

    const results = listUnsettledApprovalContinuations();

    expect(results.map((row) => row.id)).toContain(open.id);
    expect(results.map((row) => row.id)).not.toContain(finished.id);
    expect(parse.mock.calls.some(([value]) => value === diffJson)).toBe(false);
  });

  it('finds unsettled continuations through an index instead of reading every approval', () => {
    const pending = fixture();
    claimApprovalResolution(pending.id, 'approve', 'desktop');
    const plans: string[] = [];
    const prepare = Database.prototype.prepare;
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, source: string) {
      if (/continuationStatus|"approvals"\.rowid IN/.test(source) && !source.startsWith('EXPLAIN')) {
        const plan = prepare.call(this, `EXPLAIN QUERY PLAN ${source}`) as unknown as { all: (...params: unknown[]) => unknown[] };
        const rows = plan.all(...Array<null>(source.split('?').length - 1).fill(null));
        plans.push((rows as Array<{ detail: string }>).map((row) => row.detail).join('; '));
      }
      return prepare.call(this, source);
    });

    expect(listUnsettledApprovalContinuations().map((row) => row.id)).toContain(pending.id);
    expect(plans.length).toBeGreaterThan(0);
    // The unsettled rows come from the expression index, then by rowid;
    // never a scan, and never every approval in the active project.
    for (const plan of plans) expect(plan).toMatch(/^SEARCH approvals USING (INDEX idx_approvals_continuation_status \(<expr>=\?\)|.*\browid=\?\))/);
  });

  it('still expires stale pending rows through the normal query entry point', () => {
    const stale = fixture();
    getSqlite().prepare('UPDATE approvals SET created_at = ? WHERE id = ?')
      .run(Date.now() - 31 * 60_000, stale.id);
    listUnsettledApprovalContinuations();
    expect(getApproval(stale.id)?.status).toBe('rejected');
    expect(getApproval(stale.id)?.resolution?.actor).toBe('system');
  });
});
