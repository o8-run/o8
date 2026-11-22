import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-outsider-waiting-'));
const repoDir = join(dataDir, 'widgets');
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

execFileSync('git', ['init', '--quiet', '--initial-branch=main', repoDir]);
const repoPath = realpathSync(repoDir);
execFileSync(
  'git',
  ['remote', 'add', 'origin', 'https://github.com/example/widgets.git'],
  { cwd: repoPath },
);

const { addRepo } = await import('@/lib/repos/registry');
await addRepo(repoPath);
const { closeDb, getSqlite } = await import('@/lib/db');
const {
  updateGitHubThreadAttention,
  upsertGitHubIssue,
  upsertGitHubPullRequest,
} = await import('@/lib/github-broker/store');
const { getActiveProjectScopeForRepoSync } = await import('@/lib/repos/projects');
const { buildOutsideHumanWaitingInbox, listInboxItems } = await import('@/lib/supervisor/inbox');

const NOW = new Date('2026-08-27T16:00:00.000Z');
const WAITING_SINCE = '2026-08-26T10:00:00.000Z';
const INSIDER_REPLY_AT = '2026-08-27T12:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  buildOutsideHumanWaitingInbox(NOW, 24 * 60 * 60_000);
  const sqlite = getSqlite();
  sqlite.prepare("DELETE FROM supervisor_inbox WHERE kind = 'outside_human_waiting'").run();
  sqlite.prepare('DELETE FROM github_issues').run();
  sqlite.prepare('DELETE FROM github_pull_requests').run();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

function persistIssue(): void {
  upsertGitHubIssue({
    issueId: 18_810,
    repoFullName: 'example/widgets',
    number: 41,
    title: 'Clarify the extension contract',
    state: 'open',
    author: { login: 'issue-author' },
    assignees: [],
    labels: [],
    comments: 1,
    body: 'Could a maintainer confirm this behavior?',
    url: 'https://github.com/example/widgets/issues/41',
    createdAt: '2026-08-25T09:00:00.000Z',
    updatedAt: WAITING_SINCE,
    closedAt: null,
  });
  updateGitHubThreadAttention({
    repoFullName: 'example/widgets',
    kind: 'issue',
    number: 41,
    lastHumanCommentAuthorLogin: 'outside-issue-author',
    lastHumanCommentAuthorAssociation: 'CONTRIBUTOR',
    lastHumanCommentAt: WAITING_SINCE,
    lastInsiderCommentAt: null,
  });
}

function persistPullRequest(): void {
  upsertGitHubPullRequest({
    pullRequestId: 18_811,
    repoFullName: 'example/widgets',
    number: 42,
    title: 'Add a bounded retry guard',
    state: 'open',
    author: { login: 'pr-author' },
    body: 'This is ready for a maintainer response.',
    headRefName: 'contributor/retry-guard',
    baseRefName: 'main',
    additions: 12,
    deletions: 2,
    changedFiles: 1,
    reviewDecision: null,
    statusCheckRollup: [],
    url: 'https://github.com/example/widgets/pull/42',
    createdAt: '2026-08-25T10:00:00.000Z',
    updatedAt: WAITING_SINCE,
    closedAt: null,
    mergedAt: null,
  });
  updateGitHubThreadAttention({
    repoFullName: 'example/widgets',
    kind: 'pr',
    number: 42,
    lastHumanCommentAuthorLogin: 'outside-pr-author',
    lastHumanCommentAuthorAssociation: 'FIRST_TIME_CONTRIBUTOR',
    lastHumanCommentAt: WAITING_SINCE,
    lastInsiderCommentAt: null,
  });
}

function persistUnconnectedIssue(): void {
  upsertGitHubIssue({
    issueId: 18_812,
    repoFullName: 'unconnected/tools',
    number: 43,
    title: 'This repository is not connected',
    state: 'open',
    author: { login: 'outside-unconnected-author' },
    assignees: [],
    labels: [],
    comments: 1,
    body: 'This thread must not enter a local project inbox.',
    url: 'https://github.com/unconnected/tools/issues/43',
    createdAt: '2026-08-25T11:00:00.000Z',
    updatedAt: WAITING_SINCE,
    closedAt: null,
  });
  updateGitHubThreadAttention({
    repoFullName: 'unconnected/tools',
    kind: 'issue',
    number: 43,
    lastHumanCommentAuthorLogin: 'outside-unconnected-author',
    lastHumanCommentAuthorAssociation: 'CONTRIBUTOR',
    lastHumanCommentAt: WAITING_SINCE,
    lastInsiderCommentAt: null,
  });
}

describe('outside human waiting inbox real path', () => {
  it('builds issue and PR cards from persisted mirror rows and resolves them after an insider reply', () => {
    persistIssue();
    persistPullRequest();
    persistUnconnectedIssue();

    expect(buildOutsideHumanWaitingInbox(NOW, 24 * 60 * 60_000)).toEqual({
      created: 2,
      resolved: 0,
    });

    const activeProject = getActiveProjectScopeForRepoSync();
    expect(activeProject.projectId).toBe(getActiveProjectScopeForRepoSync(repoPath).projectId);
    const activeRows = listInboxItems()
      .filter((row) => row.kind === 'outside_human_waiting')
      .sort((left, right) => (
        Number(left.payload.threadNumber) - Number(right.payload.threadNumber)
      ));
    expect(activeRows.map((row) => ({
      payload: row.payload,
      projectId: row.projectId,
      repoPath: row.repoPath,
      status: row.status,
    }))).toEqual([
      {
        payload: expect.objectContaining({
          title: 'outside-issue-author is waiting on example/widgets#41',
          body: 'Clarify the extension contract · waiting 30h',
          url: 'https://github.com/example/widgets/issues/41',
        }),
        projectId: activeProject.projectId,
        repoPath,
        status: 'human_required',
      },
      {
        payload: expect.objectContaining({
          title: 'outside-pr-author is waiting on example/widgets#42',
          body: 'Add a bounded retry guard · waiting 30h',
          url: 'https://github.com/example/widgets/pull/42',
        }),
        projectId: activeProject.projectId,
        repoPath,
        status: 'human_required',
      },
    ]);
    expect(getSqlite().prepare(`
      SELECT COUNT(*) as count
      FROM supervisor_inbox
      WHERE kind = 'outside_human_waiting'
        AND json_extract(payload, '$.threadRepo') = 'unconnected/tools'
    `).get()).toEqual({ count: 0 });

    for (const kind of ['issue', 'pr'] as const) {
      updateGitHubThreadAttention({
        repoFullName: 'example/widgets',
        kind,
        number: kind === 'issue' ? 41 : 42,
        lastHumanCommentAuthorLogin: kind === 'issue' ? 'outside-issue-author' : 'outside-pr-author',
        lastHumanCommentAuthorAssociation: 'CONTRIBUTOR',
        lastHumanCommentAt: WAITING_SINCE,
        lastInsiderCommentAt: INSIDER_REPLY_AT,
      });
    }

    expect(buildOutsideHumanWaitingInbox(NOW, 24 * 60 * 60_000)).toEqual({
      created: 0,
      resolved: 2,
    });
    expect(listInboxItems()
      .filter((row) => row.kind === 'outside_human_waiting')
      .map((row) => row.status)).toEqual(['resolved', 'resolved']);
  });

  it('reruns the default reconcile only when a mirrored thread or the inbox changes, or a waiting hour ticks over', () => {
    persistIssue();
    const prepare = vi.spyOn(getSqlite(), 'prepare');
    const threadReads = () => prepare.mock.calls.filter(([sql]) => String(sql).includes('UNION ALL')).length;
    const cards = () => (getSqlite().prepare(
      "SELECT payload FROM supervisor_inbox WHERE kind = 'outside_human_waiting' AND status = 'human_required'",
    ).all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload).body);
    try {
      buildOutsideHumanWaitingInbox();
      expect(cards()).toEqual(['Clarify the extension contract · waiting 30h']);
      expect(threadReads()).toBe(1);

      // Same mirror, same inbox, same whole hour: the mirror is not read again.
      vi.setSystemTime(NOW.getTime() + 30 * 60_000);
      buildOutsideHumanWaitingInbox();
      expect(threadReads()).toBe(1);

      // The thread's next whole hour of waiting falls due.
      vi.setSystemTime(NOW.getTime() + 60 * 60_000);
      buildOutsideHumanWaitingInbox();
      expect(threadReads()).toBe(2);
      expect(cards()).toEqual(['Clarify the extension contract · waiting 31h']);
      buildOutsideHumanWaitingInbox();
      expect(threadReads()).toBe(2);

      // An insider reply reaches the mirror: the next call clears the card.
      updateGitHubThreadAttention({
        repoFullName: 'example/widgets',
        kind: 'issue',
        number: 41,
        lastHumanCommentAuthorLogin: 'outside-issue-author',
        lastHumanCommentAuthorAssociation: 'CONTRIBUTOR',
        lastHumanCommentAt: WAITING_SINCE,
        lastInsiderCommentAt: INSIDER_REPLY_AT,
      });
      buildOutsideHumanWaitingInbox();
      expect(threadReads()).toBe(3);
      expect(cards()).toEqual([]);
    } finally {
      prepare.mockRestore();
    }
  });
});
