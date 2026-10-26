import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { GitHubRequestDeferredError, type GitHubReadPriority } from './request-budget';
import { githubQuotaDeadline } from '@/lib/github-client/quota-deadline';

import {
  getGitHubPullRequestByHead,
  getGitHubPullRequestByNumber,
  listGitHubIssues,
  listGitHubPullRequests,
  markGitHubSyncError,
  markGitHubSyncSuccess,
  pruneClosedGitHubThreads,
  readGitHubSyncState,
  replaceGitHubIssues,
  replaceGitHubPullRequests,
  readGitHubThreadSyncState,
  updateGitHubThreadAttention,
  upsertGitHubIssue,
  upsertGitHubPullRequest,
  upsertGitHubInstallation,
  type GitHubIssueSnapshot,
  type GitHubPullRequestSnapshot,
  type GitHubSyncResource,
  type GitHubThreadSyncState,
  type GitHubThreadAttentionSnapshot,
} from './store';
import { githubInstallationFetch as installationFetch } from './auth';
import { hasGitHubBrokerAccess } from './auth';
import { canReadGitHubSnapshot, githubOrgAccessCode, PUBLIC_GITHUB_REFRESH_MS, usesAnonymousGitHubReads } from './repo-access';
import {
  isGitHubBotLogin,
  isGitHubInsiderAssociation,
  OUTSIDER_ATTENTION_RECENTLY_CLOSED_MS,
  type OutsiderAttentionThreadKind,
} from '@/lib/supervisor/outsider-attention';
import {
  listActiveOutsideHumanWaitingThreadNumbers,
  resolveInboxItem,
} from '@/lib/supervisor/inbox';
import { resolveVerifiedClosedOutsideHumanWaitingThread } from '@/lib/supervisor/outsider-inbox-builder';

const GITHUB_SNAPSHOT_TTL_MS = 120_000; // 2 min — balance freshness with rate limit budget
const syncPriority = new AsyncLocalStorage<GitHubReadPriority>();
const githubInstallationFetch: typeof installationFetch = (repo, endpoint, init) => installationFetch(repo, endpoint,
  syncPriority.getStore() === 'interactive' ? { ...init, cache: 'reload' } : init, { priority: syncPriority.getStore() ?? 'background' });

const MAX_PULL_REQUEST_PAGES = 5;
const MAX_ISSUE_PAGES = 5; // 5 pages * 100 = 500 issues max
const MAX_ATTENTION_COMMENT_PAGES = 5;
const MAX_RECENTLY_CLOSED_PAGES = 5;

function resourcePath(repoFullName: string, resource: GitHubSyncResource, page = 1) {
  if (resource === 'issues') {
    return `/repos/${repoFullName}/issues?state=open&per_page=100&sort=updated&direction=desc&page=${page}`;
  }
  return `/repos/${repoFullName}/pulls?state=open&per_page=100&sort=updated&direction=desc&page=${page}`;
}

function recentlyClosedPath(
  repoFullName: string,
  resource: GitHubSyncResource,
  cutoffIso: string,
  page: number,
): string {
  if (resource === 'issues') {
    return `/repos/${repoFullName}/issues?state=closed&since=${encodeURIComponent(cutoffIso)}&per_page=100&sort=updated&direction=desc&page=${page}`;
  }
  return `/repos/${repoFullName}/pulls?state=closed&per_page=100&sort=updated&direction=desc&page=${page}`;
}

function isFresh(lastSuccessfulAt?: string | null, repoFullName?: string) {
  if (!lastSuccessfulAt) return false;
  if (repoFullName && !canReadGitHubSnapshot(repoFullName)) return false;
  return (Date.now() - new Date(lastSuccessfulAt).getTime()) < (repoFullName && usesAnonymousGitHubReads(repoFullName) ? PUBLIC_GITHUB_REFRESH_MS : GITHUB_SNAPSHOT_TTL_MS);
}

function buildGitHubError(response: Response, bodyText: string) {
  const deadline = githubQuotaDeadline(response);
  if (deadline !== null) return new GitHubRequestDeferredError(deadline, 'rate-limit');
  const reset = response.headers.get('x-ratelimit-reset');
  const retryAfter = response.headers.get('retry-after');
  const remaining = response.headers.get('x-ratelimit-remaining');
  const parts = [`GitHub request failed (${response.status})`];
  if (bodyText) parts.push(bodyText.trim());
  if (remaining) parts.push(`remaining=${remaining}`);
  if (retryAfter) parts.push(`retryAfter=${retryAfter}s`);
  if (reset) parts.push(`resetAt=${new Date(Number(reset) * 1000).toISOString()}`);
  return new Error(parts.join(' · '));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type GitHubIssuePayloadItem = {
  id: number;
  number: number;
  title: string;
  state: string;
  body?: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  user?: { login?: string | null; type?: string | null } | null;
  author_association?: string | null;
  assignees?: Array<{ login?: string | null }>;
  labels?: Array<{ name?: string | null; color?: string | null }>;
  comments?: number;
  pull_request?: unknown;
  repository_url?: string;
};

type GitHubPullRequestPayload = {
  id: number;
  number: number;
  title: string;
  state: string;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  user?: { login?: string | null; type?: string | null } | null;
  author_association?: string | null;
  head?: { ref?: string | null; sha?: string | null };
  base?: { ref?: string | null; repo?: { id?: number } | null };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  comments?: number;
};

type GitHubCommentPayload = {
  user?: { login?: string | null; type?: string | null } | null;
  author_association?: string | null;
  created_at?: string | null;
};

type AttentionSyncSource = {
  repoFullName: string;
  kind: OutsiderAttentionThreadKind;
  number: number;
  updatedAt: string;
  commentsCount: number;
  bodyAuthorLogin: string | null;
  bodyAuthorType: string | null;
  bodyAuthorAssociation: string | null;
  bodyCreatedAt: string;
};

function isHumanActor(user: { login?: string | null; type?: string | null } | null | undefined): user is { login: string; type?: string | null } {
  const login = user?.login?.trim() ?? '';
  return Boolean(login) && user?.type?.toLowerCase() !== 'bot' && !isGitHubBotLogin(login);
}

function bodyFallbackAttention(source: AttentionSyncSource): GitHubThreadAttentionSnapshot {
  const bodyIsHuman = source.bodyAuthorLogin
    && source.bodyAuthorType?.toLowerCase() !== 'bot'
    && !isGitHubBotLogin(source.bodyAuthorLogin);
  return {
    repoFullName: source.repoFullName,
    kind: source.kind,
    number: source.number,
    lastHumanCommentAuthorLogin: bodyIsHuman ? source.bodyAuthorLogin : null,
    lastHumanCommentAuthorAssociation: bodyIsHuman ? source.bodyAuthorAssociation : null,
    lastHumanCommentAt: bodyIsHuman ? source.bodyCreatedAt : null,
    lastInsiderCommentAt: null,
  };
}

async function fetchThreadAttention(source: AttentionSyncSource): Promise<GitHubThreadAttentionSnapshot> {
  if (source.commentsCount <= 0) return bodyFallbackAttention(source);

  let lastHumanComment: GitHubCommentPayload | null = null;
  let lastInsiderCommentAt: string | null = null;
  const lastPage = Math.max(1, Math.ceil(source.commentsCount / 100));
  const firstPage = Math.max(1, lastPage - MAX_ATTENTION_COMMENT_PAGES + 1);
  for (let page = lastPage; page >= firstPage; page -= 1) {
    const { response } = await githubInstallationFetch(
      source.repoFullName,
      `/repos/${source.repoFullName}/issues/${source.number}/comments?per_page=100&page=${page}`,
    );
    const bodyText = await response.text();
    if (!response.ok) throw buildGitHubError(response, bodyText);
    const comments = JSON.parse(bodyText) as GitHubCommentPayload[];

    for (const comment of comments) {
      if (!isHumanActor(comment.user) || !comment.created_at) continue;
      if (!lastHumanComment || Date.parse(comment.created_at) > Date.parse(lastHumanComment.created_at!)) {
        lastHumanComment = comment;
      }
      if (
        isGitHubInsiderAssociation(comment.author_association)
        && (!lastInsiderCommentAt || Date.parse(comment.created_at) > Date.parse(lastInsiderCommentAt))
      ) {
        lastInsiderCommentAt = comment.created_at;
      }
    }

    if (lastHumanComment && lastInsiderCommentAt) break;
  }

  if (!lastHumanComment || !isHumanActor(lastHumanComment.user) || !lastHumanComment.created_at) {
    return bodyFallbackAttention(source);
  }
  return {
    repoFullName: source.repoFullName,
    kind: source.kind,
    number: source.number,
    lastHumanCommentAuthorLogin: lastHumanComment.user.login,
    lastHumanCommentAuthorAssociation: lastHumanComment.author_association ?? null,
    lastHumanCommentAt: lastHumanComment.created_at,
    lastInsiderCommentAt,
  };
}

async function fetchMovedThreadAttention(
  sources: AttentionSyncSource[],
  previousState: Map<number, GitHubThreadSyncState>,
): Promise<GitHubThreadAttentionSnapshot[]> {
  const attention: GitHubThreadAttentionSnapshot[] = [];
  for (const source of sources) {
    const stored = previousState.get(source.number);
    if (stored?.updatedAt === source.updatedAt && stored.attentionAssessed) continue;
    try {
      attention.push(await fetchThreadAttention(source));
    } catch (error) {
      console.warn(
        `[github-broker] Attention sync skipped for ${source.repoFullName}#${source.number}: ${errorMessage(error)}`,
      );
    }
  }
  return attention;
}

function attentionSource(
  repoFullName: string,
  kind: OutsiderAttentionThreadKind,
  item: GitHubIssuePayloadItem | GitHubPullRequestPayload,
  commentsCount: number,
): AttentionSyncSource {
  return {
    repoFullName,
    kind,
    number: item.number,
    updatedAt: item.updated_at ?? item.created_at ?? '',
    commentsCount,
    bodyAuthorLogin: item.user?.login?.trim() || null,
    bodyAuthorType: item.user?.type ?? null,
    bodyAuthorAssociation: item.author_association ?? null,
    bodyCreatedAt: item.created_at ?? '',
  };
}

function mapPullRequestSnapshot(
  repoFullName: string,
  item: GitHubPullRequestPayload,
  detail: GitHubPullRequestPayload,
): GitHubPullRequestSnapshot {
  return {
    pullRequestId: item.id,
    repositoryId: item.base?.repo?.id ?? (detail.id === item.id ? detail.base?.repo?.id : null) ?? null,
    repoFullName,
    number: item.number,
    title: item.title,
    state: item.state,
    author: item.user?.login ? { login: item.user.login } : null,
    body: item.body ?? '',
    headRefName: item.head?.ref ?? '',
    baseRefName: item.base?.ref ?? '',
    additions: detail.additions ?? 0,
    deletions: detail.deletions ?? 0,
    changedFiles: detail.changed_files ?? 0,
    reviewDecision: null,
    statusCheckRollup: [],
    url: detail.html_url ?? item.html_url ?? '',
    createdAt: detail.created_at ?? item.created_at ?? '',
    updatedAt: detail.updated_at ?? item.updated_at ?? item.created_at ?? '',
    closedAt: detail.closed_at ?? item.closed_at ?? null,
    mergedAt: detail.merged_at ?? item.merged_at ?? null,
    headSha: detail.head?.sha ?? item.head?.sha ?? null,
    mergeCommit: detail.merge_commit_sha ?? item.merge_commit_sha ?? null,
  };
}

function mapIssueSnapshot(repoFullName: string, issue: GitHubIssuePayloadItem): GitHubIssueSnapshot {
  return {
    issueId: issue.id,
    repoFullName,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.user?.login ? { login: issue.user.login } : null,
    assignees: (issue.assignees ?? [])
      .map((assignee) => assignee.login ? { login: assignee.login } : null)
      .filter((assignee): assignee is { login: string } => Boolean(assignee)),
    labels: (issue.labels ?? [])
      .map((label) => label.name ? { name: label.name, color: label.color ?? '000000' } : null)
      .filter((label): label is { name: string; color: string } => Boolean(label)),
    comments: issue.comments ?? 0,
    body: issue.body ?? '',
    url: issue.html_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at ?? null,
  };
}

function isRecentlyClosed(closedAt: string | null | undefined, cutoffMs: number): boolean {
  const closedAtMs = closedAt ? Date.parse(closedAt) : Number.NaN;
  return Number.isFinite(closedAtMs) && closedAtMs >= cutoffMs;
}

async function fetchRecentlyClosedIssues(
  repoFullName: string,
  cutoffIso: string,
  cutoffMs: number,
): Promise<GitHubIssuePayloadItem[]> {
  const issues: GitHubIssuePayloadItem[] = [];
  for (let page = 1; page <= MAX_RECENTLY_CLOSED_PAGES; page += 1) {
    try {
      const { response } = await githubInstallationFetch(
        repoFullName,
        recentlyClosedPath(repoFullName, 'issues', cutoffIso, page),
      );
      const bodyText = await response.text();
      if (!response.ok) throw buildGitHubError(response, bodyText);
      const pageItems = JSON.parse(bodyText) as GitHubIssuePayloadItem[];
      issues.push(...pageItems.filter((item) => (
        !item.pull_request && isRecentlyClosed(item.closed_at, cutoffMs)
      )));
      if (pageItems.length < 100) break;
    } catch (error) {
      console.warn(
        `[github-broker] Recently closed issue sync stopped for ${repoFullName} at page ${page}: ${errorMessage(error)}`,
      );
      break;
    }
  }
  return issues;
}

async function fetchRecentlyClosedPullRequests(
  repoFullName: string,
  cutoffIso: string,
  cutoffMs: number,
): Promise<GitHubPullRequestPayload[]> {
  const pulls: GitHubPullRequestPayload[] = [];
  for (let page = 1; page <= MAX_RECENTLY_CLOSED_PAGES; page += 1) {
    try {
      const { response } = await githubInstallationFetch(
        repoFullName,
        recentlyClosedPath(repoFullName, 'pull_requests', cutoffIso, page),
      );
      const bodyText = await response.text();
      if (!response.ok) throw buildGitHubError(response, bodyText);
      const pageItems = JSON.parse(bodyText) as GitHubPullRequestPayload[];
      pulls.push(...pageItems.filter((item) => isRecentlyClosed(item.closed_at, cutoffMs)));
      const oldestUpdatedAt = pageItems.at(-1)?.updated_at;
      if (pageItems.length < 100 || (oldestUpdatedAt && Date.parse(oldestUpdatedAt) < cutoffMs)) break;
    } catch (error) {
      console.warn(
        `[github-broker] Recently closed pull request sync stopped for ${repoFullName} at page ${page}: ${errorMessage(error)}`,
      );
      break;
    }
  }
  return pulls;
}

async function fetchPullRequestDetail(
  repoFullName: string,
  item: GitHubPullRequestPayload,
): Promise<GitHubPullRequestPayload> {
  const { response } = await githubInstallationFetch(
    repoFullName,
    `/repos/${repoFullName}/pulls/${item.number}`,
  );
  const detailText = await response.text();
  if (!response.ok) throw buildGitHubError(response, detailText);
  return JSON.parse(detailText) as GitHubPullRequestPayload;
}

function applyThreadAttention(attention: GitHubThreadAttentionSnapshot[]): void {
  for (const item of attention) updateGitHubThreadAttention(item);
}

async function verifyActiveWaitingClosures(repoFullName: string, kind: OutsiderAttentionThreadKind): Promise<void> {
  const numbers = listActiveOutsideHumanWaitingThreadNumbers(repoFullName, kind);
  for (const number of numbers) {
    try {
      const endpoint = kind === 'issue' ? 'issues' : 'pulls';
      const { response } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/${endpoint}/${number}`);
      const bodyText = await response.text();
      if (!response.ok) throw buildGitHubError(response, bodyText);
      const detail = JSON.parse(bodyText) as GitHubIssuePayloadItem & GitHubPullRequestPayload;
      if (detail.number !== number) throw new Error('GitHub returned a different thread number');
      if (kind === 'issue') upsertGitHubIssue(mapIssueSnapshot(repoFullName, detail));
      else upsertGitHubPullRequest(mapPullRequestSnapshot(repoFullName, detail, detail));
      if (detail.state !== 'closed' || !detail.closed_at) continue;
      const closedAt = detail.closed_at;
      const verifiedAt = new Date().toISOString();
      resolveVerifiedClosedOutsideHumanWaitingThread({
        repoFullName,
        kind,
        number,
        closedAt,
        verifiedAt,
        resolve: (id, payload) => resolveInboxItem(id, null, {
          note: 'Direct GitHub thread response confirmed that the thread is closed.',
          packetId: null,
          laneId: null,
          event: 'outside_human_waiting_thread_closed',
          evidence: {
            url: payload.url,
            waitingSince: payload.waitingSince,
            closedAt,
            verifiedAt,
          },
          resolvedAt: verifiedAt,
        }),
      });
    } catch (error) {
      console.warn(`[github-broker] Waiting thread verification failed for ${repoFullName}#${number}: ${errorMessage(error)}`);
    }
  }
}

async function syncIssues(repoFullName: string) {
  const syncState = readGitHubSyncState(repoFullName, 'issues');
  const etag = syncState?.etag ?? null;
  const previousState = readGitHubThreadSyncState(repoFullName, 'issue');
  const cutoffMs = Date.now() - OUTSIDER_ATTENTION_RECENTLY_CLOSED_MS;
  const cutoffIso = new Date(cutoffMs).toISOString();
  // Skip ETag when TTL has expired — forces a fresh fetch so pagination runs
  const useEtag = etag && isFresh(syncState?.lastSuccessfulAt);

  // Fetch page 1 (with ETag for cache validation)
  const { response, installation } = await githubInstallationFetch(repoFullName, resourcePath(repoFullName, 'issues', 1), {
    headers: useEtag ? { 'If-None-Match': etag } : undefined,
  });

  if (installation.id) upsertGitHubInstallation({
    installationId: installation.id,
    accountLogin: installation.account?.login ?? repoFullName.split('/')[0],
    accountType: installation.account?.type ?? null,
    targetType: installation.target_type ?? null,
    permissions: installation.permissions ?? null,
  });

  let openItems: GitHubIssuePayloadItem[] | null = null;
  const lastEtag = response.headers.get('etag');

  if (response.status !== 304) {
    const bodyText = await response.text();
    if (!response.ok) throw buildGitHubError(response, bodyText);

    const firstPage = JSON.parse(bodyText) as GitHubIssuePayloadItem[];
    openItems = [...firstPage];
    if (firstPage.length >= 100) {
      for (let page = 2; page <= MAX_ISSUE_PAGES; page += 1) {
        const { response: pageResponse } = await githubInstallationFetch(
          repoFullName,
          resourcePath(repoFullName, 'issues', page),
        );
        const pageText = await pageResponse.text();
        if (!pageResponse.ok) {
          console.warn(`[github-broker] Issues page ${page} failed (${pageResponse.status}), stopping pagination`);
          break;
        }
        const pageItems = JSON.parse(pageText) as GitHubIssuePayloadItem[];
        openItems.push(...pageItems);
        if (pageItems.length < 100) break;
      }
    }
  }

  const closedItems = await fetchRecentlyClosedIssues(repoFullName, cutoffIso, cutoffMs);
  const threadItems = [
    ...(openItems ?? []).filter((item) => !item.pull_request),
    ...closedItems,
  ];
  const attention = await fetchMovedThreadAttention(
    threadItems.map((item) => attentionSource(repoFullName, 'issue', item, item.comments ?? 0)),
    previousState,
  );
  const closedIssues = closedItems.map((issue) => mapIssueSnapshot(repoFullName, issue));

  if (openItems) {
    replaceGitHubIssues(repoFullName, [
      ...openItems.filter((item) => !item.pull_request).map((issue) => mapIssueSnapshot(repoFullName, issue)),
      ...closedIssues,
    ]);
  } else {
    for (const issue of closedIssues) upsertGitHubIssue(issue);
  }
  applyThreadAttention(attention);
  pruneClosedGitHubThreads(
    repoFullName,
    'issue',
    cutoffIso,
    listActiveOutsideHumanWaitingThreadNumbers(repoFullName, 'issue'),
  );
  markGitHubSyncSuccess(repoFullName, 'issues', response.status === 304 ? etag : lastEtag);
  await verifyActiveWaitingClosures(repoFullName, 'issue');
}

async function syncPullRequests(repoFullName: string) {
  const syncState = readGitHubSyncState(repoFullName, 'pull_requests');
  const etag = syncState?.etag ?? null;
  const previousState = readGitHubThreadSyncState(repoFullName, 'pr');
  const cutoffMs = Date.now() - OUTSIDER_ATTENTION_RECENTLY_CLOSED_MS;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const useEtag = etag && isFresh(syncState?.lastSuccessfulAt);
  const { response, installation } = await githubInstallationFetch(repoFullName, resourcePath(repoFullName, 'pull_requests'), {
    headers: useEtag ? { 'If-None-Match': etag } : undefined,
  });

  if (installation.id) upsertGitHubInstallation({
    installationId: installation.id,
    accountLogin: installation.account?.login ?? repoFullName.split('/')[0],
    accountType: installation.account?.type ?? null,
    targetType: installation.target_type ?? null,
    permissions: installation.permissions ?? null,
  });

  let openPulls: GitHubPullRequestSnapshot[] | null = null;
  const openPairs: Array<{ item: GitHubPullRequestPayload; detail: GitHubPullRequestPayload }> = [];
  if (response.status !== 304) {
    // Finish the bounded listing before detail calls or replacing any stored PRs.
    // A partial listing must never close rows that merely fell on a later page.
    const items = new Map<number, GitHubPullRequestPayload>();
    for (let page = 1; page <= MAX_PULL_REQUEST_PAGES; page += 1) {
      const pageResponse = page === 1 ? response : (await githubInstallationFetch(
        repoFullName, resourcePath(repoFullName, 'pull_requests', page),
      )).response;
      const bodyText = await pageResponse.text();
      if (!pageResponse.ok) throw buildGitHubError(pageResponse, bodyText);
      const pageItems = JSON.parse(bodyText) as GitHubPullRequestPayload[];
      if (!Array.isArray(pageItems)) throw new Error('GitHub returned an invalid pull request listing.');
      // Updated-desc pages can overlap while GitHub changes; keep the first copy.
      for (const item of pageItems) if (!items.has(item.number)) items.set(item.number, item);
      const hasNext = /;\s*rel="next"/.test(pageResponse.headers.get('link') ?? '');
      if (page === MAX_PULL_REQUEST_PAGES && hasNext) {
        throw new Error('GitHub pull request sync exceeded the 500-PR (5-page) limit; previous snapshot retained.');
      }
      if (pageItems.length < 100 && !hasNext) break;
    }
    openPulls = [];
    for (const item of items.values()) {
      const stored = getGitHubPullRequestByNumber(repoFullName, item.number);
      // Retry unassessed attention using the detail's authoritative comment count.
      if (item.updated_at && stored?.state === 'open' && stored.pullRequestId === item.id && stored.updatedAt === item.updated_at
        && previousState.get(item.number)?.attentionAssessed) {
        openPulls.push({ ...stored, repositoryId: item.base?.repo?.id ?? stored.repositoryId,
          url: item.html_url ?? (item.base?.repo?.id != null ? '' : stored.url) });
        continue;
      }
      const detail = await fetchPullRequestDetail(repoFullName, item);
      openPairs.push({ item, detail });
      openPulls.push(mapPullRequestSnapshot(repoFullName, item, detail));
    }
  }

  const closedItems = await fetchRecentlyClosedPullRequests(repoFullName, cutoffIso, cutoffMs);
  const closedPairs: Array<{ item: GitHubPullRequestPayload; detail: GitHubPullRequestPayload }> = [];
  const unchangedClosed: GitHubPullRequestSnapshot[] = [];
  for (const item of closedItems) {
    const stored = previousState.get(item.number);
    const cached = getGitHubPullRequestByNumber(repoFullName, item.number);
    if (
      stored?.updatedAt === (item.updated_at ?? item.created_at ?? '')
      && stored.attentionAssessed && cached?.pullRequestId === item.id
    ) {
      unchangedClosed.push({ ...cached, repositoryId: item.base?.repo?.id ?? cached.repositoryId,
        url: item.html_url ?? (item.base?.repo?.id != null ? '' : cached.url) });
      continue;
    }
    try {
      closedPairs.push({ item, detail: await fetchPullRequestDetail(repoFullName, item) });
    } catch (error) {
      console.warn(
        `[github-broker] Recently closed pull request sync skipped for ${repoFullName}#${item.number}: ${errorMessage(error)}`,
      );
    }
  }

  const changedPairs = [...openPairs, ...closedPairs];
  const attention = await fetchMovedThreadAttention(
    changedPairs.map(({ detail }) => attentionSource(
      repoFullName,
      'pr',
      detail,
      detail.comments ?? 0,
    )),
    previousState,
  );
  const closedPulls = [...unchangedClosed, ...closedPairs.map(({ item, detail }) => mapPullRequestSnapshot(repoFullName, item, detail))];

  if (openPulls) {
    replaceGitHubPullRequests(repoFullName, [...openPulls, ...closedPulls]);
  } else {
    for (const pull of closedPulls) upsertGitHubPullRequest(pull);
  }
  applyThreadAttention(attention);
  pruneClosedGitHubThreads(
    repoFullName,
    'pr',
    cutoffIso,
    listActiveOutsideHumanWaitingThreadNumbers(repoFullName, 'pr'),
  );
  markGitHubSyncSuccess(
    repoFullName,
    'pull_requests',
    response.status === 304 ? etag : response.headers.get('etag'),
  );
  await verifyActiveWaitingClosures(repoFullName, 'pr');
}

async function syncPullRequest(repoFullName: string, prNumber: number) {
  const { response, installation } = await githubInstallationFetch(repoFullName, `/repos/${repoFullName}/pulls/${prNumber}`);

  if (installation.id) upsertGitHubInstallation({
    installationId: installation.id,
    accountLogin: installation.account?.login ?? repoFullName.split('/')[0],
    accountType: installation.account?.type ?? null,
    targetType: installation.target_type ?? null,
    permissions: installation.permissions ?? null,
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw buildGitHubError(response, bodyText);
  }

  const detail = JSON.parse(bodyText) as GitHubPullRequestPayload;
  const pull = mapPullRequestSnapshot(repoFullName, detail, detail);
  upsertGitHubPullRequest(pull);
  return pull;
}

async function syncPullRequestByHead(repoFullName: string, headRefName: string) {
  const owner = repoFullName.split('/')[0] ?? '';
  const head = encodeURIComponent(`${owner}:${headRefName}`);
  const { response, installation } = await githubInstallationFetch(
    repoFullName,
    `/repos/${repoFullName}/pulls?state=all&head=${head}&per_page=1&sort=updated&direction=desc`,
  );

  if (installation.id) upsertGitHubInstallation({
    installationId: installation.id,
    accountLogin: installation.account?.login ?? owner,
    accountType: installation.account?.type ?? null,
    targetType: installation.target_type ?? null,
    permissions: installation.permissions ?? null,
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw buildGitHubError(response, bodyText);
  }

  const pulls = JSON.parse(bodyText) as GitHubPullRequestPayload[];
  const match = pulls[0];
  if (!match) return null;

  const pull = mapPullRequestSnapshot(repoFullName, match, match);
  upsertGitHubPullRequest(pull);
  return pull;
}

export async function ensureGitHubIssues(repoFullName: string, options?: { fresh?: boolean }) {
  const current = canReadGitHubSnapshot(repoFullName) ? listGitHubIssues(repoFullName) : [];
  const syncState = readGitHubSyncState(repoFullName, 'issues');

  if (!hasGitHubBrokerAccess()) {
    return {
      issues: current,
      error: current.length > 0 ? null : 'GitHub App is not configured.',
      stale: true, lastSuccessfulAt: syncState?.lastSuccessfulAt ?? null,
    };
  }

  if (!options?.fresh && isFresh(syncState?.lastSuccessfulAt, repoFullName)) {
    return { issues: current, code: githubOrgAccessCode(syncState?.lastError), error: syncState?.lastError ?? null, stale: Boolean(syncState?.lastError), lastSuccessfulAt: syncState?.lastSuccessfulAt ?? null };
  }

  let retryAt: number | null = null;
  try {
    await syncPriority.run(options?.fresh ? 'interactive' : 'background', () => syncIssues(repoFullName));
  } catch (error) {
    retryAt = error instanceof GitHubRequestDeferredError ? error.retryAt : null;
    markGitHubSyncError(repoFullName, 'issues', error instanceof Error ? error.message : 'Unable to sync GitHub issues');
  }

  const refreshed = canReadGitHubSnapshot(repoFullName) ? listGitHubIssues(repoFullName) : [];
  const nextState = readGitHubSyncState(repoFullName, 'issues');
  return {
    issues: refreshed,
    error: nextState?.lastError ?? null,
    code: githubOrgAccessCode(nextState?.lastError),
    stale: Boolean(nextState?.lastError) || !isFresh(nextState?.lastSuccessfulAt, repoFullName), lastSuccessfulAt: nextState?.lastSuccessfulAt ?? null, retryAt,
  };
}

export async function ensureGitHubPullRequests(repoFullName: string, options?: { fresh?: boolean }) {
  const current = canReadGitHubSnapshot(repoFullName) ? listGitHubPullRequests(repoFullName) : [];
  const syncState = readGitHubSyncState(repoFullName, 'pull_requests');

  if (!hasGitHubBrokerAccess()) {
    return {
      prs: current,
      error: current.length > 0 ? null : 'GitHub App is not configured.',
      stale: true, lastSuccessfulAt: syncState?.lastSuccessfulAt ?? null,
    };
  }

  if (!options?.fresh && isFresh(syncState?.lastSuccessfulAt, repoFullName)) {
    return { prs: current, code: githubOrgAccessCode(syncState?.lastError), error: syncState?.lastError ?? null, stale: Boolean(syncState?.lastError), lastSuccessfulAt: syncState?.lastSuccessfulAt ?? null };
  }

  let retryAt: number | null = null;
  try {
    await syncPriority.run(options?.fresh ? 'interactive' : 'background', () => syncPullRequests(repoFullName));
  } catch (error) {
    retryAt = error instanceof GitHubRequestDeferredError ? error.retryAt : null;
    markGitHubSyncError(repoFullName, 'pull_requests', error instanceof Error ? error.message : 'Unable to sync GitHub pull requests');
  }

  const refreshed = canReadGitHubSnapshot(repoFullName) ? listGitHubPullRequests(repoFullName) : [];
  const nextState = readGitHubSyncState(repoFullName, 'pull_requests');
  return {
    prs: refreshed,
    error: nextState?.lastError ?? null,
    code: githubOrgAccessCode(nextState?.lastError),
    stale: Boolean(nextState?.lastError) || !isFresh(nextState?.lastSuccessfulAt, repoFullName), lastSuccessfulAt: nextState?.lastSuccessfulAt ?? null, retryAt,
  };
}

export async function ensureGitHubPullRequest(repoFullName: string, prNumber: number) {
  const current = canReadGitHubSnapshot(repoFullName) ? getGitHubPullRequestByNumber(repoFullName, prNumber) : null;

  if (!hasGitHubBrokerAccess()) {
    return {
      pr: current,
      error: current ? null : 'GitHub App is not configured.',
      stale: true,
    };
  }

  try {
    const pr = await syncPullRequest(repoFullName, prNumber);
    return { pr, error: null, stale: false };
  } catch (error) {
    // A single-PR failure is returned to its caller; it must not mark the
    // complete open-PR listing stale or errored.
    const message = error instanceof Error ? error.message : 'Unable to sync GitHub pull request';
    return { pr: current, error: message, stale: true };
  }
}

export async function ensureGitHubPullRequestByHead(repoFullName: string, headRefName: string) {
  const current = canReadGitHubSnapshot(repoFullName) ? getGitHubPullRequestByHead(repoFullName, headRefName) : null;

  if (!hasGitHubBrokerAccess()) {
    return {
      pr: current,
      error: current ? null : 'GitHub App is not configured.',
      stale: true,
    };
  }

  try {
    const pr = await syncPullRequestByHead(repoFullName, headRefName);
    return { pr: pr ?? current, error: null, stale: false };
  } catch (error) {
    // A single-PR failure is returned to its caller; it must not mark the
    // complete open-PR listing stale or errored.
    const message = error instanceof Error ? error.message : 'Unable to sync GitHub pull request by head branch';
    return { pr: current, error: message, stale: true };
  }
}
