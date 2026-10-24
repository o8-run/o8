'use client';
import { assertGithubScope, githubSnapshotTime } from '@/lib/github-client/refresh-policy';

/**
 * o8-activity-helpers — Icons, data-fetching, and render helpers for O8ActivityPane.
 * Extracted to keep the main component under 800 lines.
 */

import type { CIRun } from '@/lib/github-client/ci-runs';
import type React from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { activityPrHoverQuery } from './agent-panel/useActivityPrHoverDetail';
import { getQueryClient } from '@/lib/query/client';
import { activityListQuery, type ActivityListKind } from '@/lib/github-client/activity-queries';
import { refreshGithubList } from '@/lib/github-client';
import { useCallback, useState } from 'react';
import type { ActivityItem, FeedFilter, GHIssue, GHPullRequest } from './agent-panel/types';
import { relativeAge } from './agent-panel/shared';
import { O8ActivityCIDetail } from './O8ActivityCIDetail';

// ── Phosphor-style SVG icons (raw, per CLAUDE.md) ──

export function IconZap({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

export function IconAlertCircle({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

export function IconGitPullRequest({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  );
}

export function IconGitCommit({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="4" />
      <line x1="1.05" y1="12" x2="7" y2="12" />
      <line x1="17.01" y1="12" x2="22.96" y2="12" />
    </svg>
  );
}

export function IconCheckCircle({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

export function IconXCircle({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

export function IconClock({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function IconFolder({ size = 11, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function IconChevronDown({ size = 10, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ── Constants ──

export type O8FeedFilter = FeedFilter;

export const ALL_REPOS_KEY = '__all__';

export const ACTIVITY_COLORS = {
  add: '#91c99d',
  success: '#70b57f',
  successBg: 'rgba(112, 181, 127, 0.08)',
  delete: '#d99a9a',
  danger: '#c97878',
  dangerBg: 'rgba(201, 120, 120, 0.08)',
  accent: '#8d9fbd',
  accentBg: 'rgba(141, 159, 189, 0.08)',
  accentBorder: 'rgba(141, 159, 189, 0.16)',
  merge: '#aaa0c7',
  mergeBg: 'rgba(170, 160, 199, 0.08)',
  attention: '#cf9d60',
  attentionBg: 'rgba(207, 157, 96, 0.08)',
};

export const FILTER_TABS: { key: O8FeedFilter; label: string; icon: (color: string) => React.ReactNode }[] = [
  { key: 'all', label: 'All', icon: (c) => <IconZap size={11} color={c} /> },
  { key: 'commit', label: 'Commits', icon: (c) => <IconGitCommit size={11} color={c} /> },
  { key: 'pr', label: 'PRs', icon: (c) => <IconGitPullRequest size={11} color={c} /> },
  { key: 'issue', label: 'Issues', icon: (c) => <IconAlertCircle size={11} color={c} /> },
  { key: 'ci', label: 'CI', icon: (c) => <IconCheckCircle size={11} color={c} /> },
];

const FEED_ICON_MAP: Record<string, { bg: string; color: string; icon: React.ReactNode }> = {
  commit: { bg: ACTIVITY_COLORS.successBg, color: ACTIVITY_COLORS.success, icon: <IconGitCommit size={11} color={ACTIVITY_COLORS.success} /> },
  issue: { bg: `var(--o8-activity-issue-bg, ${ACTIVITY_COLORS.mergeBg})`, color: `var(--o8-activity-issue-fg, ${ACTIVITY_COLORS.merge})`, icon: <IconAlertCircle size={11} color={`var(--o8-activity-issue-fg, ${ACTIVITY_COLORS.merge})`} /> },
  pr: { bg: ACTIVITY_COLORS.accentBg, color: ACTIVITY_COLORS.accent, icon: <IconGitPullRequest size={11} color={ACTIVITY_COLORS.accent} /> },
  ci_success: { bg: ACTIVITY_COLORS.successBg, color: ACTIVITY_COLORS.success, icon: <IconCheckCircle size={11} color={ACTIVITY_COLORS.success} /> },
  ci_failure: { bg: ACTIVITY_COLORS.dangerBg, color: ACTIVITY_COLORS.danger, icon: <IconXCircle size={11} color={ACTIVITY_COLORS.danger} /> },
  ci_pending: { bg: ACTIVITY_COLORS.attentionBg, color: ACTIVITY_COLORS.attention, icon: <IconClock size={11} color={ACTIVITY_COLORS.attention} /> },
};

export function feedIconForItem(item: ActivityItem) {
  if (item.kind === 'ci') {
    if (item.conclusion === 'success') return FEED_ICON_MAP.ci_success;
    if (item.conclusion === 'failure') return FEED_ICON_MAP.ci_failure;
    return FEED_ICON_MAP.ci_pending;
  }
  return FEED_ICON_MAP[item.kind] ?? FEED_ICON_MAP.commit;
}

// ── Data Fetching ──

export interface RepoActivityData {
  commits: ActivityItem[];
  prs: ActivityItem[];
  issues: ActivityItem[];
  ciRuns: ActivityItem[];
  workspaceError?: string;
  remoteError?: string;
  remoteUpdatedAt?: number;
  /** Remote-only history: local fallback rows must never survive failed folder validation. */
  remoteCommits?: ActivityItem[];
}

export const EMPTY_DATA: RepoActivityData = { commits: [], prs: [], issues: [], ciRuns: [] };

/** Commit row shape from /api/panel/commits — GitHub mirror rows carry
 *  `hash`/`message`, the local-git (`?workspace=`) branch carries
 *  `shortSha`/`subject`. Normalize both into one ActivityItem. */
interface CommitRow {
  hash?: string;
  shortSha?: string;
  message?: string;
  subject?: string;
  date?: string;
}

function mapCommitRow(c: CommitRow, repoSlug: string): ActivityItem {
  const ts = c.date ? new Date(c.date).getTime() : 0;
  return {
    kind: 'commit',
    hash: c.hash ?? c.shortSha ?? '',
    message: c.message ?? c.subject ?? '',
    age: c.date ? relativeAge(c.date) : '',
    ts,
    repo: repoSlug,
  };
}

export const REMOTE_ACTIVITY_DELAYED = 'GitHub sync delayed. Showing last successful activity where available.';

export async function fetchRepoActivity(repoSlug: string | null, repoPath?: string | null, options?: {
  client?: QueryClient;
  fresh?: boolean;
  manual?: boolean;
  previous?: RepoActivityData;
  signal?: AbortSignal;
}): Promise<RepoActivityData> {
  const localLabel = repoSlug ?? repoPath ?? 'local';
  type Payload = { commits?: CommitRow[]; prs?: GHPullRequest[]; issues?: GHIssue[]; runs?: CIRun[] };
  async function readRemote(endpoint: ActivityListKind, field: string): Promise<{ data: Payload | null; failed: boolean }> {
    if (!repoSlug) return { data: { [field]: [] }, failed: false };
    try {
      const client = options?.client ?? getQueryClient();
      assertGithubScope(client, repoSlug, options?.manual);
      const config = activityListQuery(repoSlug || '', endpoint as ActivityListKind, { manual: options?.fresh });
      const data = options?.fresh && (endpoint === 'issues' || endpoint === 'prs')
        ? await refreshGithubList(client, repoSlug || '', endpoint)
        : await client.fetchQuery({ ...config, ...(options?.fresh || client.getQueryState(config.queryKey)?.error ? { staleTime: 0 } : {}) });
      return { data: data as Payload, failed: false };
    } catch {
      return { data: null, failed: true };
    }
  }
  const [commitsRead, prsRead, issuesRead, ciRead] = await Promise.all([
    readRemote('commits', 'commits'), readRemote('prs', 'prs'),
    readRemote('issues', 'issues'), readRemote('ci', 'runs'),
  ]);
  let remoteError: string | undefined;
  function retainOnFailure(failed: boolean, previous: ActivityItem[] | undefined, map: () => ActivityItem[]) {
    if (!failed) {
      try { return map(); } catch { /* Treat malformed rows as a failed stream, too. */ }
    }
    remoteError = REMOTE_ACTIVITY_DELAYED;
    return previous ?? [];
  }
  const remoteCommits = retainOnFailure(commitsRead.failed, options?.previous?.remoteCommits,
    () => (commitsRead.data!.commits as CommitRow[]).slice(0, 12).map((c) => mapCommitRow(c, localLabel)));
  let commits = remoteCommits;
  let workspaceError: string | undefined;
  // Validate the selected on-disk folder even when remote history exists.
  // A confirmed local read can also supply history without a GitHub remote.
  if (repoPath) {
    const localRes = await fetch(`/api/panel/commits?workspace=${encodeURIComponent(repoPath)}&limit=50`, { signal: options?.signal }).catch(() => null);
    try {
      const data = localRes ? await localRes.json() : null;
      if (localRes?.ok && !data?.error && Array.isArray(data?.commits)) {
        if (commits.length === 0) commits = ((data?.commits ?? []) as CommitRow[]).slice(0, 50).map((c) => mapCommitRow(c, localLabel));
      } else {
        workspaceError = typeof data?.error === 'string' ? data.error : 'Could not load local commit activity. Retry to check this folder again.';
      }
    } catch {
      workspaceError = 'Could not load local commit activity. Retry to check this folder again.';
    }
  }

  const prs = retainOnFailure(prsRead.failed, options?.previous?.prs, () => {
    const prs: ActivityItem[] = [];
    const data = prsRead.data!;
    for (const pr of (data.prs ?? []).slice(0, 8)) {
      const ts = pr.createdAt ? new Date(pr.createdAt).getTime() : 0;
      const checks = pr.statusCheckRollup ?? [];
      prs.push({
        kind: 'pr',
        number: pr.number,
        title: pr.title,
        state: (pr.state ?? '').toLowerCase(),
        author: pr.author?.login ?? '',
        branch: pr.headRefName ?? '',
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        changedFiles: pr.changedFiles ?? 0,
        reviewDecision: pr.reviewDecision ?? '',
        checkSummary: {
          passed: checks.filter((ch: { conclusion?: string | null }) => ch.conclusion?.toLowerCase() === 'success').length,
          failed: checks.filter((ch: { conclusion?: string | null }) => ch.conclusion?.toLowerCase() === 'failure').length,
          pending: checks.filter((ch: { conclusion?: string | null; status?: string | null }) => !ch.conclusion || ch.status?.toLowerCase() !== 'completed').length,
        },
        age: pr.createdAt ? relativeAge(pr.createdAt) : '',
        ts,
        repo: localLabel,
      });
    }
    return prs;
  });

  const issues = retainOnFailure(issuesRead.failed, options?.previous?.issues, () => {
    const issues: ActivityItem[] = [];
    const data = issuesRead.data!;
    for (const issue of (data.issues ?? []).slice(0, 8)) {
      const ts = issue.createdAt ? new Date(issue.createdAt).getTime() : 0;
      issues.push({
        kind: 'issue',
        number: issue.number,
        title: issue.title,
        state: (issue.state ?? '').toLowerCase(),
        labels: issue.labels ?? [],
        age: issue.createdAt ? relativeAge(issue.createdAt) : '',
        ts,
        repo: localLabel,
        author: issue.author?.login ?? 'unknown',
        assignees: (issue.assignees ?? []).map((a: { login?: string | null }) => a.login ?? '').filter(Boolean),
        comments: typeof issue.comments === 'number' ? issue.comments : 0,
        body: (issue.body ?? '').trim(),
      });
    }
    return issues;
  });

  const ciRuns = retainOnFailure(ciRead.failed, options?.previous?.ciRuns, () => {
    const ciRuns: ActivityItem[] = [];
    const data = ciRead.data!;
    for (const run of (data.runs ?? []).slice(0, 6)) {
      const ts = run.createdAt ? new Date(run.createdAt).getTime() : 0;
      ciRuns.push({
        kind: 'ci',
        id: run.databaseId,
        title: run.displayTitle ?? '',
        status: run.status ?? '',
        conclusion: run.conclusion ?? '',
        branch: run.headBranch ?? '',
        headSha: run.headSha ?? '',
        workflow: run.workflowName ?? '',
        age: run.createdAt ? relativeAge(run.createdAt) : '',
        ts,
        repo: localLabel,
      });
    }
    return ciRuns;
  });

  const client = options?.client ?? getQueryClient();
  const remoteUpdatedAt = Math.min(...(['issues', 'prs', 'ci', 'commits'] as ActivityListKind[])
    .map(kind => { const state = client.getQueryState(activityListQuery(repoSlug ?? '', kind).queryKey); return state ? githubSnapshotTime(state.data, state.dataUpdatedAt) : 0; }).filter(Boolean));
  return { commits, remoteCommits, prs, issues, ciRuns, remoteUpdatedAt, ...(workspaceError ? { workspaceError } : {}), ...(remoteError ? { remoteError } : {}) };
}

// ── Render helpers ──

export function itemKey(item: ActivityItem): string {
  if (item.kind === 'commit') return `c-${item.repo ?? 'local'}-${item.hash}`;
  if (item.kind === 'event') return `e-${item.data.id}`;
  if (item.kind === 'issue') return `i-${item.repo}-${item.number}`;
  if (item.kind === 'pr') return `pr-${item.repo}-${item.number}`;
  if (item.kind === 'packet') return `pkt-${item.packet.id}`;
  return `ci-${item.repo}-${item.id}`;
}

export function itemTitle(item: ActivityItem): string {
  if (item.kind === 'commit') return item.hash ? `${item.message} · ${item.hash.slice(0, 7)}` : item.message;
  if (item.kind === 'event') return item.data.title;
  if (item.kind === 'issue') return `#${item.number} ${item.title}`;
  if (item.kind === 'pr') return `#${item.number} ${item.title}`;
  if (item.kind === 'packet') return item.packet.title;
  return item.title;
}

export function itemSubline(item: ActivityItem): React.ReactNode {
  if (item.kind === 'commit') {
    return (
      <>
        <span style={{ color: 'var(--t-text-secondary)' }}>{item.hash}</span>
        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
        <span>{item.age}</span>
        {item.groupedPushEvent ? (
          <span style={{
            paddingTop: 0,
            paddingRight: 4,
            paddingBottom: 0,
            paddingLeft: 4,
            borderRadius: 4,
            background: ACTIVITY_COLORS.accentBg,
            color: ACTIVITY_COLORS.accent,
            fontSize: 9.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
          }}>
            pushed
          </span>
        ) : null}
        {item.groupedCiRun ? (
          <span style={{
            paddingTop: 0,
            paddingRight: 4,
            paddingBottom: 0,
            paddingLeft: 4,
            borderRadius: 4,
            background: item.groupedCiRun.conclusion === 'success'
              ? ACTIVITY_COLORS.successBg
              : item.groupedCiRun.conclusion === 'failure'
                ? ACTIVITY_COLORS.dangerBg
                : ACTIVITY_COLORS.attentionBg,
            color: item.groupedCiRun.conclusion === 'success'
              ? ACTIVITY_COLORS.success
              : item.groupedCiRun.conclusion === 'failure'
                ? ACTIVITY_COLORS.danger
                : ACTIVITY_COLORS.attention,
            fontSize: 9.5,
            fontWeight: 300,
            letterSpacing: '-0.1px',
          }}>
            {item.groupedCiRun.conclusion || item.groupedCiRun.status || 'ci'}
          </span>
        ) : null}
      </>
    );
  }
  if (item.kind === 'pr') {
    return (
      <>
        <span style={{ color: ACTIVITY_COLORS.add, flexShrink: 0 }}>+{item.additions}</span>
        <span style={{ color: ACTIVITY_COLORS.delete, flexShrink: 0 }}>-{item.deletions}</span>
        <span style={{ color: 'var(--t-text-faint)', flexShrink: 0 }}>·</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{item.branch}</span>
        <span style={{ color: 'var(--t-text-faint)', flexShrink: 0 }}>·</span>
        <span style={{ flexShrink: 0 }}>{item.age}</span>
      </>
    );
  }
  if (item.kind === 'ci') {
    return (
      <>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{item.workflow}</span>
        <span style={{ color: 'var(--t-text-faint)', flexShrink: 0 }}>·</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{item.branch}</span>
        <span style={{ color: 'var(--t-text-faint)', flexShrink: 0 }}>·</span>
        <span style={{
          color: item.conclusion === 'success' ? ACTIVITY_COLORS.success : item.conclusion === 'failure' ? ACTIVITY_COLORS.danger : ACTIVITY_COLORS.attention,
          fontWeight: 400,
          flexShrink: 0,
        }}>
          {item.conclusion || item.status}
        </span>
      </>
    );
  }
  if (item.kind === 'issue') {
    return (
      <>
        {item.labels.slice(0, 2).map((label) => (
          <span
            key={label.name}
            style={{
              paddingTop: 0,
              paddingRight: 4,
              paddingBottom: 0,
              paddingLeft: 4,
              borderRadius: 4,
              background: `var(--o8-activity-label-bg, #${label.color}18)`,
              color: `var(--o8-activity-label-fg, #${label.color})`,
              fontSize: 9.5,
              fontWeight: 300,
              letterSpacing: '-0.1px',
              fontFamily: 'var(--font-sans-system)',
            }}
          >
            {label.name}
          </span>
        ))}
        <span style={{ color: 'var(--t-text-faint)' }}>·</span>
        <span>{item.age}</span>
      </>
    );
  }
  return null;
}

// ── Expanded detail types + fetching ──

interface PRExpandDetail {
  mergeable: boolean;
  checksStatus: string;
  reviewDecision: string | null;
  files: { path: string; additions: number; deletions: number }[];
}

export type ExpandDetails = {
  pr: Record<string, PRExpandDetail>;
};

export function useExpandDetails() {
  const client = useQueryClient();
  const [prDetails, setPrDetails] = useState<Record<string, PRExpandDetail>>({});

  const fetchForItem = useCallback((item: ActivityItem, key: string) => {
    if (item.kind === 'pr' && !prDetails[key]) {
      client.fetchQuery(activityPrHoverQuery(item.repo.toLowerCase(), item.number))
        .then((d) => {
          setPrDetails((prev) => ({ ...prev, [key]: {
            mergeable: Boolean(d.mergeable),
            checksStatus: d.checksStatus ?? 'unknown',
            reviewDecision: d.reviewDecision ?? null,
            files: (d.files ?? []).slice(0, 6),
          }}));
        })
        .catch(() => {});
    }
  }, [client, prDetails]);

  return { prDetails, fetchForItem };
}

// ── Expanded row detail content ──

const DETAIL_LABEL_STYLE: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 300,
  color: 'var(--t-text-faint)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: 4,
};

const DETAIL_ROW_STYLE: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 300,
  letterSpacing: '-0.1px',
  color: 'var(--t-text-faint)',
  lineHeight: 1.45,
  fontFamily: 'var(--font-sans-system)',
};

function DetailPill({ label, color, background: fill }: { label: string; color: string; background?: string }) {
  const background = fill ?? (color.startsWith('#') ? `${color}14` : 'var(--t-bg-card)');
  return (
    <span style={{
      paddingTop: 1, paddingRight: 6, paddingBottom: 1, paddingLeft: 6,
      borderRadius: 6, fontSize: 9.5, fontWeight: 300, letterSpacing: '-0.1px',
      background,
      color,
    }}>
      {label}
    </span>
  );
}

function DetailActionButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        alignSelf: 'flex-start',
        minHeight: 26,
        border: '1px solid var(--t-divider-subtle)',
        borderRadius: 8,
        background: 'var(--t-bg-card)',
        color: 'var(--t-text-secondary)',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans-system)',
        fontSize: 11,
        fontWeight: 350,
        letterSpacing: '-0.1px',
        paddingTop: 0,
        paddingRight: 9,
        paddingBottom: 0,
        paddingLeft: 9,
      }}
      onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--t-hover)'; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = 'var(--t-bg-card)'; }}
    >
      {label}
    </button>
  );
}

export function renderExpandedDetail(
  item: ActivityItem,
  prDetails: Record<string, PRExpandDetail>,
  key: string,
  actions?: { active?: boolean; onOpenPr?: (item: Extract<ActivityItem, { kind: 'pr' }>) => void },
): React.ReactNode {
  if (item.kind === 'commit') {
    return (
      <div style={{ ...DETAIL_ROW_STYLE, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={DETAIL_LABEL_STYLE}>Commit</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ color: 'var(--t-text-secondary)', fontWeight: 300, letterSpacing: '-0.1px' }}>{item.hash}</span>
          <span style={{ color: 'var(--t-text-faint)' }}>{item.age}</span>
        </div>
        <div style={{ color: 'var(--t-text)', fontSize: 13.5, lineHeight: 1.45, fontWeight: 300, letterSpacing: '-0.1px', fontFamily: 'var(--font-sans-system)' }}>
          {item.message}
        </div>
      </div>
    );
  }

  if (item.kind === 'pr') {
    const detail = prDetails[key];
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <DetailPill label={item.state} color={item.state === 'merged' ? ACTIVITY_COLORS.merge : item.state === 'open' ? ACTIVITY_COLORS.success : ACTIVITY_COLORS.danger} />
          <DetailPill label={`+${item.additions} -${item.deletions}`} color={item.additions > item.deletions ? ACTIVITY_COLORS.add : ACTIVITY_COLORS.delete} />
          <DetailPill label={`${item.changedFiles} file${item.changedFiles === 1 ? '' : 's'}`} color='var(--t-text-muted)' />
          {item.reviewDecision ? <DetailPill label={item.reviewDecision.replace('_', ' ').toLowerCase()} color={item.reviewDecision === 'APPROVED' ? ACTIVITY_COLORS.success : ACTIVITY_COLORS.attention} /> : null}
        </div>
        {item.checkSummary ? (
          <div style={{ ...DETAIL_ROW_STYLE, display: 'flex', gap: 8 }}>
            {item.checkSummary.passed > 0 ? <span style={{ color: ACTIVITY_COLORS.success }}>{item.checkSummary.passed} passed</span> : null}
            {item.checkSummary.failed > 0 ? <span style={{ color: ACTIVITY_COLORS.danger }}>{item.checkSummary.failed} failed</span> : null}
            {item.checkSummary.pending > 0 ? <span style={{ color: ACTIVITY_COLORS.attention }}>{item.checkSummary.pending} pending</span> : null}
          </div>
        ) : null}
        {detail?.files && detail.files.length > 0 ? (
          <div>
            <div style={DETAIL_LABEL_STYLE}>Changed files</div>
            {detail.files.map((f) => (
              <div key={f.path} style={{ ...DETAIL_ROW_STYLE, display: 'flex', gap: 8 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                <span style={{ color: ACTIVITY_COLORS.add, flexShrink: 0 }}>+{f.additions}</span>
                <span style={{ color: ACTIVITY_COLORS.delete, flexShrink: 0 }}>-{f.deletions}</span>
              </div>
            ))}
          </div>
        ) : detail === undefined ? (
          <div style={{ ...DETAIL_ROW_STYLE, color: 'var(--t-text-faint)' }}>Loading...</div>
        ) : null}
        <div style={{ ...DETAIL_ROW_STYLE, fontFamily: 'var(--font-sans-system)' }}>
          <span style={{ fontWeight: 350, letterSpacing: '-0.1px', color: 'var(--t-text-secondary)' }}>{item.author}</span>
          <span style={{ color: 'var(--t-text-faint)' }}> on </span>
          <span style={{ color: 'var(--t-text-secondary)' }}>{item.branch}</span>
        </div>
        {actions?.onOpenPr ? (
          <DetailActionButton label="Open PR details" onClick={() => actions.onOpenPr?.(item)} />
        ) : null}
      </div>
    );
  }

  if (item.kind === 'ci') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <DetailPill label={item.conclusion || item.status} color={item.conclusion === 'success' ? ACTIVITY_COLORS.success : item.conclusion === 'failure' ? ACTIVITY_COLORS.danger : ACTIVITY_COLORS.attention} />
          <span style={{ ...DETAIL_ROW_STYLE }}>
            {item.workflow} on {item.branch}
          </span>
        </div>
        {actions?.active !== false ? (
          <O8ActivityCIDetail repo={item.repo} runId={item.id}>
            {(detail) => <>
              {detail?.failingJobs && detail.failingJobs.length > 0 ? (
                <div>
                  <div style={DETAIL_LABEL_STYLE}>Failing jobs</div>
                  {detail.failingJobs.map((j) => (
                    <div key={j.name} style={{ ...DETAIL_ROW_STYLE, display: 'flex', gap: 6, alignItems: 'center' }}>
                      <IconXCircle size={10} color={ACTIVITY_COLORS.danger} />
                      <span>{j.name}</span>
                      {j.failingStep ? <span style={{ color: 'var(--t-text-faint)' }}>{j.failingStep}</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {detail?.summaryLine ? (
                <div style={{ ...DETAIL_ROW_STYLE, color: ACTIVITY_COLORS.danger, fontWeight: 350 }}>
                  {detail.summaryLine.slice(0, 200)}
                </div>
              ) : null}
            </>}
          </O8ActivityCIDetail>
        ) : null}
      </div>
    );
  }

  if (item.kind === 'issue') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <DetailPill label={item.state} color={item.state === 'open' ? ACTIVITY_COLORS.success : ACTIVITY_COLORS.merge} />
          {item.labels.slice(0, 4).map((l) => (
            <DetailPill key={l.name} label={l.name} color={`var(--o8-activity-label-fg, #${l.color})`} background={`var(--o8-activity-label-bg, #${l.color}14)`} />
          ))}
        </div>
        {item.body ? (
          <div style={{ fontSize: 13.5, color: 'var(--t-text-faint)', lineHeight: 1.45, fontWeight: 300, letterSpacing: '-0.1px', fontFamily: 'var(--font-sans-system)' }}>
            {item.body.slice(0, 200)}{item.body.length > 200 ? '...' : ''}
          </div>
        ) : null}
        <div style={{ ...DETAIL_ROW_STYLE, display: 'flex', gap: 8, fontFamily: 'var(--font-sans-system)' }}>
          {item.author ? <span><span style={{ fontWeight: 350, letterSpacing: '-0.1px', color: 'var(--t-text-secondary)' }}>{item.author}</span></span> : null}
          {item.assignees.length > 0 ? <span style={{ color: 'var(--t-text-faint)' }}>{item.assignees.join(', ')}</span> : null}
          {item.comments > 0 ? <span>{item.comments} comment{item.comments === 1 ? '' : 's'}</span> : null}
        </div>
      </div>
    );
  }

  return null;
}

export function itemBadge(item: ActivityItem): React.ReactNode {
  if (item.kind === 'pr' && item.state) {
    return (
      <span style={{
        paddingTop: 1,
        paddingRight: 6,
        paddingBottom: 1,
        paddingLeft: 6,
        borderRadius: 999,
        fontSize: 9,
        fontWeight: 300,
        letterSpacing: '0.04em',
        flexShrink: 0,
        marginTop: 4,
        background: item.state === 'merged' ? ACTIVITY_COLORS.mergeBg : item.state === 'open' ? ACTIVITY_COLORS.successBg : ACTIVITY_COLORS.dangerBg,
        color: item.state === 'merged' ? ACTIVITY_COLORS.merge : item.state === 'open' ? ACTIVITY_COLORS.success : ACTIVITY_COLORS.danger,
        textTransform: 'uppercase',
        fontFamily: 'var(--font-sans-system)',
      }}>
        {item.state}
      </span>
    );
  }
  if (item.kind === 'issue' && item.state) {
    return (
      <span style={{
        paddingTop: 1,
        paddingRight: 6,
        paddingBottom: 1,
        paddingLeft: 6,
        borderRadius: 999,
        fontSize: 9,
        fontWeight: 300,
        letterSpacing: '0.04em',
        flexShrink: 0,
        marginTop: 4,
        background: item.state === 'open' ? ACTIVITY_COLORS.successBg : ACTIVITY_COLORS.mergeBg,
        color: item.state === 'open' ? ACTIVITY_COLORS.success : ACTIVITY_COLORS.merge,
        textTransform: 'uppercase',
        fontFamily: 'var(--font-sans-system)',
      }}>
        {item.state}
      </span>
    );
  }
  return null;
}
