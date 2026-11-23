import 'server-only';

import { getSqlite } from '@/lib/db';
import { createRepoPathResolver } from '@/lib/intake/resolve-repo';
import type {
  OutsiderAttentionThread,
  OutsiderAttentionThreadKind,
} from '@/lib/supervisor/outsider-attention';

export type GitHubSyncResource = 'issues' | 'pull_requests';

export interface GitHubSyncState {
  key: string;
  repoFullName: string;
  resource: GitHubSyncResource;
  etag: string | null;
  lastSyncedAt: string | null;
  lastSuccessfulAt: string | null;
  lastError: string | null;
  staleAt: string | null;
  updatedAt: string;
}

export interface GitHubIssueSnapshot {
  issueId: number;
  repoFullName: string;
  number: number;
  title: string;
  state: string;
  author: { login: string } | null;
  assignees: Array<{ login: string }>;
  labels: Array<{ name: string; color: string }>;
  comments: number;
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface GitHubPullRequestSnapshot {
  pullRequestId: number;
  repositoryId?: number | null;
  repoFullName: string;
  number: number;
  title: string;
  state: string;
  author: { login: string } | null;
  body: string;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  statusCheckRollup: Array<{ name: string; status?: string | null; conclusion?: string | null }>;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  headSha?: string | null;
  mergeCommit?: string | null;
}

export interface GitHubThreadAttentionSnapshot {
  repoFullName: string;
  kind: OutsiderAttentionThreadKind;
  number: number;
  lastHumanCommentAuthorLogin: string | null;
  lastHumanCommentAuthorAssociation: string | null;
  lastHumanCommentAt: string | null;
  lastInsiderCommentAt: string | null;
}

type GitHubPullRequestRow = {
  pullRequestId: number;
  repositoryId: number | null;
  repoFullName: string;
  number: number;
  title: string;
  state: string;
  authorLogin: string | null;
  body: string | null;
  headRefName: string | null;
  baseRefName: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string | null;
  statusChecksJson: string;
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  headSha: string | null;
  mergeCommit: string | null;
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapPullRequestRow(row: GitHubPullRequestRow): GitHubPullRequestSnapshot {
  return {
    pullRequestId: row.pullRequestId,
    ...(row.repositoryId != null ? { repositoryId: row.repositoryId } : {}),
    repoFullName: row.repoFullName,
    number: row.number,
    title: row.title,
    state: row.state,
    author: row.authorLogin ? { login: row.authorLogin } : null,
    body: row.body ?? '',
    headRefName: row.headRefName ?? '',
    baseRefName: row.baseRefName ?? '',
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changedFiles,
    reviewDecision: row.reviewDecision,
    statusCheckRollup: parseJson<Array<{ name: string; status?: string | null; conclusion?: string | null }>>(row.statusChecksJson, []),
    url: row.url,
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? row.createdAt ?? '',
    closedAt: row.closedAt,
    mergedAt: row.mergedAt,
    headSha: row.headSha,
    mergeCommit: row.mergeCommit,
  };
}

export function readGitHubSyncState(repoFullName: string, resource: GitHubSyncResource): GitHubSyncState | null {
  const sqlite = getSqlite();
  return sqlite
    .prepare(`
      SELECT key, repo_full_name as repoFullName, resource, etag, last_synced_at as lastSyncedAt,
             last_successful_at as lastSuccessfulAt, last_error as lastError, stale_at as staleAt, updated_at as updatedAt
      FROM github_sync_state
      WHERE repo_full_name = ? AND resource = ?
      LIMIT 1
    `)
    .get(repoFullName, resource) as GitHubSyncState | undefined ?? null;
}

export function upsertGitHubInstallation(installation: {
  installationId: number;
  accountLogin: string;
  accountType?: string | null;
  targetType?: string | null;
  permissions?: Record<string, string> | null;
}) {
  const sqlite = getSqlite();
  sqlite.prepare(`
    INSERT INTO github_installations (
      installation_id, account_login, account_type, target_type, permissions_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(installation_id) DO UPDATE SET
      account_login = excluded.account_login,
      account_type = excluded.account_type,
      target_type = excluded.target_type,
      permissions_json = excluded.permissions_json,
      updated_at = datetime('now')
  `).run(
    installation.installationId,
    installation.accountLogin,
    installation.accountType ?? null,
    installation.targetType ?? null,
    JSON.stringify(installation.permissions ?? {}),
  );
}

export function upsertGitHubRepository(repo: {
  repoId: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch?: string | null;
  installationId?: number | null;
  lastWebhookAt?: string | null;
}) {
  const sqlite = getSqlite();
  sqlite.prepare(`
    INSERT INTO github_repositories (
      repo_id, full_name, owner, name, private, default_branch, installation_id, last_webhook_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(repo_id) DO UPDATE SET
      full_name = excluded.full_name,
      owner = excluded.owner,
      name = excluded.name,
      private = excluded.private,
      default_branch = excluded.default_branch,
      installation_id = excluded.installation_id,
      last_webhook_at = COALESCE(excluded.last_webhook_at, github_repositories.last_webhook_at),
      updated_at = datetime('now')
  `).run(
    repo.repoId,
    repo.fullName,
    repo.owner,
    repo.name,
    repo.private ? 1 : 0,
    repo.defaultBranch ?? null,
    repo.installationId ?? null,
    repo.lastWebhookAt ?? null,
  );
}

export function upsertGitHubIssue(issue: GitHubIssueSnapshot) {
  const sqlite = getSqlite();
  sqlite.prepare(`
    INSERT INTO github_issues (
      issue_id, repo_full_name, number, title, state, author_login, body, labels_json,
      assignees_json, comments_count, url, created_at, updated_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(issue_id) DO UPDATE SET
      repo_full_name = excluded.repo_full_name,
      number = excluded.number,
      title = excluded.title,
      state = excluded.state,
      author_login = excluded.author_login,
      body = excluded.body,
      labels_json = excluded.labels_json,
      assignees_json = excluded.assignees_json,
      comments_count = excluded.comments_count,
      url = excluded.url,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      closed_at = excluded.closed_at
  `).run(
    issue.issueId,
    issue.repoFullName,
    issue.number,
    issue.title,
    issue.state,
    issue.author?.login ?? null,
    issue.body,
    JSON.stringify(issue.labels),
    JSON.stringify(issue.assignees),
    issue.comments,
    issue.url,
    issue.createdAt,
    issue.updatedAt,
    issue.closedAt,
  );
}

export function upsertGitHubPullRequest(pull: GitHubPullRequestSnapshot) {
  const sqlite = getSqlite();
  sqlite.prepare(`
    INSERT INTO github_pull_requests (
      pull_request_id, repo_full_name, number, title, state, author_login, body, head_ref_name,
      base_ref_name, additions, deletions, changed_files, review_decision, status_checks_json,
      url, created_at, updated_at, closed_at, merged_at, head_sha, merge_commit, repository_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pull_request_id) DO UPDATE SET
      repo_full_name = excluded.repo_full_name,
      number = excluded.number,
      title = excluded.title,
      state = excluded.state,
      author_login = excluded.author_login,
      body = excluded.body,
      head_ref_name = excluded.head_ref_name,
      base_ref_name = excluded.base_ref_name,
      additions = excluded.additions,
      deletions = excluded.deletions,
      changed_files = excluded.changed_files,
      review_decision = excluded.review_decision,
      status_checks_json = excluded.status_checks_json,
      url = excluded.url,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      closed_at = excluded.closed_at,
      merged_at = excluded.merged_at,
      head_sha = excluded.head_sha,
      merge_commit = excluded.merge_commit,
      repository_id = COALESCE(excluded.repository_id, github_pull_requests.repository_id)
  `).run(
    pull.pullRequestId,
    pull.repoFullName,
    pull.number,
    pull.title,
    pull.state,
    pull.author?.login ?? null,
    pull.body,
    pull.headRefName,
    pull.baseRefName,
    pull.additions,
    pull.deletions,
    pull.changedFiles,
    pull.reviewDecision,
    JSON.stringify(pull.statusCheckRollup),
    pull.url,
    pull.createdAt,
    pull.updatedAt,
    pull.closedAt,
    pull.mergedAt,
    pull.headSha ?? null,
    pull.mergeCommit ?? null,
    Number.isSafeInteger(pull.repositoryId) && pull.repositoryId! > 0 ? pull.repositoryId! : null,
  );
}

export function markGitHubSyncSuccess(repoFullName: string, resource: GitHubSyncResource, etag?: string | null) {
  const sqlite = getSqlite();
  const key = `${repoFullName}:${resource}`;
  sqlite.prepare(`
    INSERT INTO github_sync_state (
      key, repo_full_name, resource, etag, last_synced_at, last_successful_at, last_error, updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), NULL, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      etag = excluded.etag,
      last_synced_at = datetime('now'),
      last_successful_at = datetime('now'),
      last_error = NULL,
      updated_at = datetime('now')
  `).run(key, repoFullName, resource, etag ?? null);
}

/**
 * Invalidate the sync cache for a resource — clears the ETag and
 * resets last_successful_at so the next ensureGitHub* call forces
 * a fresh fetch. Call after merge/approve/close actions.
 */
export function invalidateGitHubSync(repoFullName: string, resource: GitHubSyncResource) {
  const sqlite = getSqlite();
  const key = `${repoFullName}:${resource}`;
  sqlite.prepare(`
    UPDATE github_sync_state SET etag = '', last_successful_at = NULL, updated_at = datetime('now')
    WHERE key = ?
  `).run(key);
}

export function markGitHubSyncError(repoFullName: string, resource: GitHubSyncResource, error: string) {
  const sqlite = getSqlite();
  const key = `${repoFullName}:${resource}`;
  sqlite.prepare(`
    INSERT INTO github_sync_state (
      key, repo_full_name, resource, last_synced_at, last_error, updated_at
    ) VALUES (?, ?, ?, datetime('now'), ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      last_synced_at = datetime('now'),
      last_error = excluded.last_error,
      updated_at = datetime('now')
  `).run(key, repoFullName, resource, error);
}

export function replaceGitHubIssues(repoFullName: string, issues: GitHubIssueSnapshot[]) {
  const sqlite = getSqlite();
  const upsert = sqlite.prepare(`
    INSERT INTO github_issues (
      issue_id, repo_full_name, number, title, state, author_login, body, labels_json,
      assignees_json, comments_count, url, created_at, updated_at, closed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(issue_id) DO UPDATE SET
      repo_full_name = excluded.repo_full_name,
      number = excluded.number,
      title = excluded.title,
      state = excluded.state,
      author_login = excluded.author_login,
      body = excluded.body,
      labels_json = excluded.labels_json,
      assignees_json = excluded.assignees_json,
      comments_count = excluded.comments_count,
      url = excluded.url,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      closed_at = excluded.closed_at
  `);

  const transaction = sqlite.transaction((nextIssues: GitHubIssueSnapshot[]) => {
    // Upsert all fetched issues first
    for (const issue of nextIssues) {
      upsert.run(
        issue.issueId,
        repoFullName,
        issue.number,
        issue.title,
        issue.state,
        issue.author?.login ?? null,
        issue.body,
        JSON.stringify(issue.labels),
        JSON.stringify(issue.assignees),
        issue.comments,
        issue.url,
        issue.createdAt,
        issue.updatedAt,
        issue.closedAt,
      );
    }

    // Only close issues NOT in the fetched set (they were closed on GitHub)
    const fetchedIds = nextIssues.map((i) => i.issueId);
    if (fetchedIds.length > 0) {
      const placeholders = fetchedIds.map(() => '?').join(',');
      sqlite.prepare(`
        UPDATE github_issues
        SET state = 'closed', closed_at = COALESCE(closed_at, datetime('now'))
        WHERE repo_full_name = ? AND state = 'open' AND issue_id NOT IN (${placeholders})
      `).run(repoFullName, ...fetchedIds);
    }
  });

  transaction(issues);
}

export function replaceGitHubPullRequests(repoFullName: string, pulls: GitHubPullRequestSnapshot[]) {
  const sqlite = getSqlite();
  const upsert = sqlite.prepare(`
    INSERT INTO github_pull_requests (
      pull_request_id, repo_full_name, number, title, state, author_login, body, head_ref_name,
      base_ref_name, additions, deletions, changed_files, review_decision, status_checks_json,
      url, created_at, updated_at, closed_at, merged_at, head_sha, merge_commit, repository_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(pull_request_id) DO UPDATE SET
      repo_full_name = excluded.repo_full_name,
      number = excluded.number,
      title = excluded.title,
      state = excluded.state,
      author_login = excluded.author_login,
      body = excluded.body,
      head_ref_name = excluded.head_ref_name,
      base_ref_name = excluded.base_ref_name,
      additions = excluded.additions,
      deletions = excluded.deletions,
      changed_files = excluded.changed_files,
      review_decision = excluded.review_decision,
      status_checks_json = excluded.status_checks_json,
      url = excluded.url,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      closed_at = excluded.closed_at,
      merged_at = excluded.merged_at,
      head_sha = excluded.head_sha,
      merge_commit = excluded.merge_commit,
      repository_id = COALESCE(excluded.repository_id, github_pull_requests.repository_id)
  `);

  const closeMissing = sqlite.prepare(`
    UPDATE github_pull_requests
    SET state = 'closed', closed_at = COALESCE(closed_at, datetime('now'))
    WHERE repo_full_name = ?
  `);

  const transaction = sqlite.transaction((nextPulls: GitHubPullRequestSnapshot[]) => {
    closeMissing.run(repoFullName);
    for (const pull of nextPulls) {
      upsert.run(
        pull.pullRequestId,
        repoFullName,
        pull.number,
        pull.title,
        pull.state,
        pull.author?.login ?? null,
        pull.body,
        pull.headRefName,
        pull.baseRefName,
        pull.additions,
        pull.deletions,
        pull.changedFiles,
        pull.reviewDecision,
        JSON.stringify(pull.statusCheckRollup),
        pull.url,
        pull.createdAt,
        pull.updatedAt,
        pull.closedAt,
        pull.mergedAt,
        pull.headSha ?? null,
        pull.mergeCommit ?? null,
        Number.isSafeInteger(pull.repositoryId) && pull.repositoryId! > 0 ? pull.repositoryId! : null,
      );
    }
  });

  transaction(pulls);
}

export function pruneClosedGitHubThreads(
  repoFullName: string,
  kind: OutsiderAttentionThreadKind,
  cutoffIso: string,
  keepNumbers: number[],
): number {
  const table = kind === 'issue' ? 'github_issues' : 'github_pull_requests';
  const keepClause = keepNumbers.length > 0
    ? `AND number NOT IN (${keepNumbers.map(() => '?').join(', ')})`
    : '';
  const result = getSqlite().prepare(`
    DELETE FROM ${table}
    WHERE repo_full_name = ?
      AND state != 'open'
      AND datetime(closed_at) < datetime(?)
      ${keepClause}
  `).run(repoFullName, cutoffIso, ...keepNumbers);
  return result.changes;
}

export function listGitHubIssues(repoFullName: string): GitHubIssueSnapshot[] {
  const sqlite = getSqlite();
  const rows = sqlite.prepare(`
    SELECT issue_id as issueId, repo_full_name as repoFullName, number, title, state, author_login as authorLogin,
           body, labels_json as labelsJson, assignees_json as assigneesJson, comments_count as commentsCount,
           url, created_at as createdAt, updated_at as updatedAt, closed_at as closedAt
    FROM github_issues
    WHERE repo_full_name = ? AND state = 'open'
    ORDER BY datetime(COALESCE(updated_at, created_at)) DESC
    LIMIT 50
  `).all(repoFullName) as Array<{
    issueId: number;
    repoFullName: string;
    number: number;
    title: string;
    state: string;
    authorLogin: string | null;
    body: string | null;
    labelsJson: string;
    assigneesJson: string;
    commentsCount: number;
    url: string;
    createdAt: string | null;
    updatedAt: string | null;
    closedAt: string | null;
  }>;

  return rows.map((row) => ({
    issueId: row.issueId,
    repoFullName: row.repoFullName,
    number: row.number,
    title: row.title,
    state: row.state,
    author: row.authorLogin ? { login: row.authorLogin } : null,
    assignees: parseJson<Array<{ login: string }>>(row.assigneesJson, []),
    labels: parseJson<Array<{ name: string; color: string }>>(row.labelsJson, []),
    comments: row.commentsCount,
    body: row.body ?? '',
    url: row.url,
    createdAt: row.createdAt ?? '',
    updatedAt: row.updatedAt ?? row.createdAt ?? '',
    closedAt: row.closedAt,
  }));
}

export interface MirroredGitHubIssueRef {
  repoFullName: string;
  number: number;
  title: string;
  url: string;
}

/** Closed and open mirror rows used to resolve historical issue-backed packets. */
export function listMirroredGitHubIssuesByNumber(issueNumber: number): MirroredGitHubIssueRef[] {
  return getSqlite().prepare(`
    SELECT repo_full_name as repoFullName, number, title, url
    FROM github_issues
    WHERE number = ?
    ORDER BY repo_full_name ASC
  `).all(issueNumber) as MirroredGitHubIssueRef[];
}

export function listGitHubPullRequests(repoFullName: string): GitHubPullRequestSnapshot[] {
  const sqlite = getSqlite();
  const rows = sqlite.prepare(`
    SELECT pull_request_id as pullRequestId, repository_id as repositoryId, repo_full_name as repoFullName, number, title, state,
           author_login as authorLogin, body, head_ref_name as headRefName, base_ref_name as baseRefName,
           additions, deletions, changed_files as changedFiles, review_decision as reviewDecision,
           status_checks_json as statusChecksJson, url, created_at as createdAt, updated_at as updatedAt,
           closed_at as closedAt, merged_at as mergedAt, head_sha as headSha, merge_commit as mergeCommit
    FROM github_pull_requests
    WHERE repo_full_name = ? AND state = 'open'
    ORDER BY datetime(COALESCE(updated_at, created_at)) DESC
    LIMIT 500
  `).all(repoFullName) as GitHubPullRequestRow[];

  return rows.map(mapPullRequestRow);
}

export function getGitHubPullRequestByNumber(repoFullName: string, prNumber: number): GitHubPullRequestSnapshot | null {
  const sqlite = getSqlite();
  const row = sqlite.prepare(`
    SELECT pull_request_id as pullRequestId, repository_id as repositoryId, repo_full_name as repoFullName, number, title, state,
           author_login as authorLogin, body, head_ref_name as headRefName, base_ref_name as baseRefName,
           additions, deletions, changed_files as changedFiles, review_decision as reviewDecision,
           status_checks_json as statusChecksJson, url, created_at as createdAt, updated_at as updatedAt,
           closed_at as closedAt, merged_at as mergedAt, head_sha as headSha, merge_commit as mergeCommit
    FROM github_pull_requests
    WHERE repo_full_name = ? AND number = ?
    LIMIT 1
  `).get(repoFullName, prNumber) as GitHubPullRequestRow | undefined;
  return row ? mapPullRequestRow(row) : null;
}

export function getGitHubPullRequestByHead(repoFullName: string, headRefName: string): GitHubPullRequestSnapshot | null {
  const sqlite = getSqlite();
  const row = sqlite.prepare(`
    SELECT pull_request_id as pullRequestId, repository_id as repositoryId, repo_full_name as repoFullName, number, title, state,
           author_login as authorLogin, body, head_ref_name as headRefName, base_ref_name as baseRefName,
           additions, deletions, changed_files as changedFiles, review_decision as reviewDecision,
           status_checks_json as statusChecksJson, url, created_at as createdAt, updated_at as updatedAt,
           closed_at as closedAt, merged_at as mergedAt, head_sha as headSha, merge_commit as mergeCommit
    FROM github_pull_requests
    WHERE repo_full_name = ? AND head_ref_name = ?
    ORDER BY datetime(COALESCE(updated_at, created_at)) DESC
    LIMIT 1
  `).get(repoFullName, headRefName) as GitHubPullRequestRow | undefined;
  return row ? mapPullRequestRow(row) : null;
}

export interface GitHubThreadSyncState {
  updatedAt: string | null;
  attentionAssessed: boolean;
}

export function readGitHubThreadSyncState(
  repoFullName: string,
  kind: OutsiderAttentionThreadKind,
): Map<number, GitHubThreadSyncState> {
  const table = kind === 'issue' ? 'github_issues' : 'github_pull_requests';
  const rows = getSqlite().prepare(`
    SELECT number, updated_at as updatedAt,
           last_human_comment_at IS NOT NULL as attentionAssessed
    FROM ${table}
    WHERE repo_full_name = ?
  `).all(repoFullName) as Array<{
    number: number;
    updatedAt: string | null;
    attentionAssessed: number;
  }>;
  return new Map(rows.map((row) => [row.number, {
    updatedAt: row.updatedAt,
    attentionAssessed: Boolean(row.attentionAssessed),
  }]));
}

export function updateGitHubThreadAttention(attention: GitHubThreadAttentionSnapshot): boolean {
  const table = attention.kind === 'issue' ? 'github_issues' : 'github_pull_requests';
  const result = getSqlite().prepare(`
    UPDATE ${table}
    SET last_human_comment_author_login = ?,
        last_human_comment_author_association = ?,
        last_human_comment_at = ?,
        last_insider_comment_at = ?
    WHERE repo_full_name = ? AND number = ?
  `).run(
    attention.lastHumanCommentAuthorLogin,
    attention.lastHumanCommentAuthorAssociation,
    attention.lastHumanCommentAt,
    attention.lastInsiderCommentAt,
    attention.repoFullName,
    attention.number,
  );
  return result.changes > 0;
}

export function listGitHubAttentionThreads(): OutsiderAttentionThread[] {
  const sqlite = getSqlite();
  const repoRows = sqlite.prepare(`
    SELECT repo_full_name as repo FROM github_issues
    UNION
    SELECT repo_full_name as repo FROM github_pull_requests
  `).all() as Array<{ repo: string }>;
  const resolveRepoPath = createRepoPathResolver();
  const connectedRepos = repoRows
    .map((row) => row.repo)
    .filter((repo) => Boolean(resolveRepoPath(repo)));
  if (connectedRepos.length === 0) return [];

  const placeholders = connectedRepos.map(() => '?').join(', ');
  return sqlite.prepare(`
    SELECT repo_full_name as repo, 'issue' as kind, number, url, title, state,
           closed_at as closedAt,
           last_human_comment_author_login as lastHumanCommentAuthorLogin,
           last_human_comment_author_association as lastHumanCommentAuthorAssociation,
           last_human_comment_at as lastHumanCommentAt,
           last_insider_comment_at as lastInsiderCommentAt
    FROM github_issues
    WHERE repo_full_name IN (${placeholders})
    UNION ALL
    SELECT repo_full_name as repo, 'pr' as kind, number, url, title, state,
           closed_at as closedAt,
           last_human_comment_author_login as lastHumanCommentAuthorLogin,
           last_human_comment_author_association as lastHumanCommentAuthorAssociation,
           last_human_comment_at as lastHumanCommentAt,
           last_insider_comment_at as lastInsiderCommentAt
    FROM github_pull_requests
    WHERE repo_full_name IN (${placeholders})
  `).all(...connectedRepos, ...connectedRepos) as OutsiderAttentionThread[];
}
