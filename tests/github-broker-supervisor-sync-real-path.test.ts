import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

const installationFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/github-broker/auth', () => ({
  githubInstallationFetch: installationFetchMock,
  hasGitHubBrokerAccess: () => true,
}));

const previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
const previousO8DataDir = process.env.O8_DATA_DIR;
const previousAppKey = process.env.GITHUB_APP_PRIVATE_KEY;
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-github-supervisor-sync-'));
const repoPath = path.join(dataDir, 'widgets');
mkdirSync(repoPath, { recursive: true });
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
// #4754: anonymous reads are never fresh until public access is confirmed, so model a repo
// covered by a configured GitHub App. Auth is mocked, so this key is never used.
process.env.GITHUB_APP_PRIVATE_KEY = 'fixture-github-app-key';
writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({
  version: 1,
  repos: [{
    id: 'repo-widgets',
    name: 'widgets',
    localPath: repoPath,
    remoteUrl: 'https://github.com/example/widgets.git',
    defaultBranch: 'main',
    isGitRepo: true,
    addedAt: '2026-08-01T00:00:00.000Z',
    lastOpenedAt: null,
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'copy',
      envFiles: [],
      installCommand: null,
      installOnCreateWorkspace: false,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: null,
      defaultPort: null,
      workspaceIsolationPreference: 'auto',
    },
  }],
}));

const { closeDb, getSqlite } = await import('@/lib/db');
const {
  markGitHubSyncSuccess,
  upsertGitHubIssue,
  upsertGitHubPullRequest,
} = await import('@/lib/github-broker/store');
const { runHealBotTickOnce } = await import('@/lib/supervisor/heal-bot');

const issue = {
  issueId: 19_290,
  repoFullName: 'example/widgets',
  number: 1929,
  title: 'Keep the mirror current',
  state: 'open',
  author: { login: 'contributor' },
  assignees: [],
  labels: [],
  comments: 0,
  body: 'Issue body.',
  url: 'https://github.com/example/widgets/issues/1929',
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-27T10:00:00.000Z',
  closedAt: null,
};

const pullRequest = {
  pullRequestId: 19_291,
  repoFullName: 'example/widgets',
  number: 1930,
  title: 'Keep the pull request mirror current',
  state: 'open',
  author: { login: 'contributor' },
  body: 'Pull request body.',
  headRefName: 'contributor/change',
  baseRefName: 'main',
  additions: 2,
  deletions: 1,
  changedFiles: 1,
  reviewDecision: null,
  statusCheckRollup: [],
  url: 'https://github.com/example/widgets/pull/1930',
  createdAt: '2026-08-20T11:00:00.000Z',
  updatedAt: '2026-08-27T11:00:00.000Z',
  closedAt: null,
  mergedAt: null,
};

const installation = {
  id: 1929,
  account: { login: 'example', type: 'Organization' },
  target_type: 'Organization',
  permissions: { issues: 'read', pull_requests: 'read' },
};

function fetched(body: unknown) {
  return { response: Response.json(body), installation };
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
  if (previousO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = previousO8DataDir;
  if (previousAppKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
  else process.env.GITHUB_APP_PRIVATE_KEY = previousAppKey;
});

describe('supervisor GitHub broker sync cadence', () => {
  it('syncs a stale connected repo once and lets the TTL skip a fresh tick', async () => {
    upsertGitHubIssue(issue);
    upsertGitHubPullRequest(pullRequest);
    markGitHubSyncSuccess('example/widgets', 'issues');
    markGitHubSyncSuccess('example/widgets', 'pull_requests');
    getSqlite().prepare(`
      UPDATE github_sync_state
      SET last_successful_at = ?
      WHERE repo_full_name = 'example/widgets'
    `).run(new Date(Date.now() - 10 * 60_000).toISOString());

    installationFetchMock.mockImplementation(async (_repo: string, requestPath: string) => {
      if (requestPath.includes('/issues?state=open')) return fetched([{
        id: issue.issueId,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        body: issue.body,
        html_url: issue.url,
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
        user: { login: issue.author.login, type: 'User' },
        author_association: 'CONTRIBUTOR',
        assignees: [],
        labels: [],
        comments: 0,
      }]);
      if (requestPath.includes('/issues?state=closed')) return fetched([]);
      if (requestPath.includes('/pulls?state=open')) return fetched([{
        id: pullRequest.pullRequestId,
        number: pullRequest.number,
        title: pullRequest.title,
        state: pullRequest.state,
        body: pullRequest.body,
        html_url: pullRequest.url,
        created_at: pullRequest.createdAt,
        updated_at: pullRequest.updatedAt,
        user: { login: pullRequest.author.login, type: 'User' },
        author_association: 'CONTRIBUTOR',
        head: { ref: pullRequest.headRefName },
        base: { ref: pullRequest.baseRefName },
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
        changed_files: pullRequest.changedFiles,
        comments: 0,
      }]);
      if (requestPath.endsWith('/pulls/1930')) return fetched({
        id: pullRequest.pullRequestId,
        number: pullRequest.number,
        title: pullRequest.title,
        state: pullRequest.state,
        body: pullRequest.body,
        html_url: pullRequest.url,
        created_at: pullRequest.createdAt,
        updated_at: pullRequest.updatedAt,
        user: { login: pullRequest.author.login, type: 'User' },
        author_association: 'CONTRIBUTOR',
        head: { ref: pullRequest.headRefName },
        base: { ref: pullRequest.baseRefName },
        additions: pullRequest.additions,
        deletions: pullRequest.deletions,
        changed_files: pullRequest.changedFiles,
        comments: 0,
      });
      if (requestPath.includes('/pulls?state=closed')) return fetched([]);
      throw new Error(`Unexpected GitHub path: ${requestPath}`);
    });

    await runHealBotTickOnce();
    const staleTickCalls = installationFetchMock.mock.calls.length;
    expect(staleTickCalls).toBe(5);

    await runHealBotTickOnce();
    expect(installationFetchMock).toHaveBeenCalledTimes(staleTickCalls);
  });
});
