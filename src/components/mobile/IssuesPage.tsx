'use client';
import { githubSnapshotTime } from '@/lib/github-client/refresh-policy';

import { useQueries } from '@tanstack/react-query';
import { getMobileGithubContext, useMobileGithubContext } from '@/lib/mobile/github-cache';
import { issueListQuery, pullRequestListQuery, refreshGithubList } from '@/lib/github-client';
import { useGithubWindowHidden } from '@/lib/github-client/visibility';
import { GithubReadStatus } from '@/components/github/GithubReadStatus';
import { Suspense, lazy, memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from './ThemeContext';
import { MobileIssuesPRCard, repoShortLabel, type IssuesPagePR } from './MobileIssuesPRCard';
import { relativeTimeLabel } from '@/lib/format/relative-time';
import { PullToRefresh } from './PullToRefresh';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';

const DeployStatus = lazy(() => import('./DeployStatus'));
const MobileDiffViewer = lazy(async () => ({
  default: (await import('./MobileDiffViewer')).MobileDiffViewer,
}));

type PR = IssuesPagePR;

type ThemeColors = ReturnType<typeof useTheme>['colors'];

interface Issue {
  number: number;
  title: string;
  state: string;
  labels: { name: string; color: string }[];
  author?: { login: string };
  body?: string;
  createdAt?: string;
}

interface IssuesPageProps {
  onBack: () => void;
  onOpenPR?: (repo: string, prNumber: number) => void;
  hideHeader?: boolean;
  refreshSignal?: number;
}

const STORAGE_KEY = 'o8:registered-repos';
const DEFAULT_REPOS: string[] = [];

interface PanelRepo {
  remoteUrl?: string;
  name?: string;
}

function repoSlugFromRemoteUrl(url: string | undefined): string | null {
  if (!url) return null;
  // https://github.com/o8-run/o8.git → o8-run/o8
  const match = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

function sectionHeaderStyle(colors: ThemeColors) {
  return {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: colors.textSecondary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: 8,
    padding: '0 4px',
  };
}

function loadRegisteredRepos(): string[] {
  if (typeof window === 'undefined') return DEFAULT_REPOS;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {}
  return DEFAULT_REPOS;
}

function saveRegisteredRepos(repos: string[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(repos));
  } catch {}
}

function timeAgo(iso: string): string {
  return relativeTimeLabel(new Date(iso).getTime(), { subMinute: 'just-now-lower' });
}

const repoShort = repoShortLabel;

const IssueCard = memo(function IssueCard({ issue, repo }: { issue: Issue; repo: string }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => setExpanded(!expanded)}
      onTouchEnd={(event) => {
        setExpanded(!expanded);
        event.preventDefault();
      }}
      style={{
        padding: '14px',
        borderRadius: 14,
        background: colors.cardBg,
        border: `1px solid ${colors.cardBorder}`,
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        touchAction: 'manipulation',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#30d158"
          strokeWidth="2"
          strokeLinecap="round"
          style={{ flexShrink: 0, marginTop: 2 }}
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: colors.text, lineHeight: 1.4 }}>{issue.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: colors.textSecondary, fontFamily: '"SF Mono", ui-monospace, monospace' }}>
              #{issue.number}
            </span>
            <span
              style={{
                fontSize: 10,
                color: colors.blueAccent,
                padding: '3px 8px',
                borderRadius: 999,
                background: colors.blueGlass,
                border: `1px solid ${colors.blueGlassBorder}`,
                fontWeight: 600,
              }}
            >
              {repoShort(repo)}
            </span>
            {issue.createdAt ? <span style={{ fontSize: 10, color: colors.textSecondary }}>{timeAgo(issue.createdAt)}</span> : null}
          </div>
        </div>
      </div>
      {issue.labels.length > 0 ? (
        <div style={{ display: 'flex', gap: 4, marginTop: 10, flexWrap: 'wrap' }}>
          {issue.labels.map((label) => (
            <span
              key={label.name}
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: '3px 8px',
                borderRadius: 999,
                background: `#${label.color}18`,
                color: `#${label.color}`,
                border: `1px solid #${label.color}30`,
              }}
            >
              {label.name}
            </span>
          ))}
        </div>
      ) : null}
      {expanded && issue.body ? (
        <p
          style={{
            marginTop: 10,
            fontSize: 12,
            lineHeight: 1.5,
            color: colors.textSecondary,
            whiteSpace: 'pre-wrap',
            display: '-webkit-box',
            WebkitLineClamp: 8,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {issue.body.slice(0, 600)}
        </p>
      ) : null}
    </div>
  );
});

function RepoSwitcher({
  repos,
  selected,
  onSelect,
  onAddRepo,
}: {
  repos: string[];
  selected: string;
  onSelect: (repo: string) => void;
  onAddRepo: (repo: string) => void;
}) {
  const { colors } = useTheme();
  const [showAdd, setShowAdd] = useState(false);
  const [input, setInput] = useState('');

  const handleAdd = () => {
    const trimmed = input.trim();
    if (trimmed && /^[\w.-]+\/[\w.-]+$/.test(trimmed) && !repos.includes(trimmed)) {
      onAddRepo(trimmed);
      setInput('');
      setShowAdd(false);
    }
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <span style={sectionHeaderStyle(colors)}>Repositories</span>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => onSelect('all')}
          onTouchEnd={(event) => {
            onSelect('all');
            event.preventDefault();
          }}
          style={{
            minHeight: 44,
            padding: '0 14px',
            borderRadius: 12,
            border: selected === 'all' ? `1px solid ${colors.blueGlassBorder}` : `1px solid ${colors.cardBorder}`,
            background: selected === 'all' ? colors.blueGlass : colors.cardBg,
            color: selected === 'all' ? colors.text : colors.textSecondary,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
        >
          All
        </button>
        {repos.map((repo) => (
          <button
            key={repo}
            type="button"
            onClick={() => onSelect(repo)}
            onTouchEnd={(event) => {
              onSelect(repo);
              event.preventDefault();
            }}
            style={{
              minHeight: 44,
              maxWidth: 180,
              padding: '0 14px',
              borderRadius: 12,
              border: selected === repo ? `1px solid ${colors.blueGlassBorder}` : `1px solid ${colors.cardBorder}`,
              background: selected === repo ? colors.blueGlass : colors.cardBg,
              color: selected === repo ? colors.text : colors.textSecondary,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {repoShort(repo)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowAdd(!showAdd)}
          onTouchEnd={(event) => {
            setShowAdd(!showAdd);
            event.preventDefault();
          }}
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            border: `1px solid ${colors.cardBorder}`,
            background: colors.cardBg,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            WebkitTapHighlightColor: 'transparent',
            touchAction: 'manipulation',
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.blueAccent} strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {showAdd ? (
        <div
          style={{
            display: 'flex',
            gap: 6,
            marginTop: 8,
            padding: 8,
            borderRadius: 14,
            background: colors.cardBg,
            border: `1px solid ${colors.cardBorder}`,
          }}
        >
          <input
            type="text"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') handleAdd();
            }}
            placeholder="owner/repo"
            style={{
              flex: 1,
              minHeight: 44,
              padding: '0 12px',
              borderRadius: 12,
              border: `1px solid ${colors.cardBorder}`,
              background: colors.blueSoft,
              fontSize: 13,
              color: colors.text,
              fontFamily: '"SF Mono", ui-monospace, monospace',
              outline: 'none',
              WebkitAppearance: 'none',
            }}
          />
          <button
            type="button"
            onClick={handleAdd}
            onTouchEnd={(event) => {
              handleAdd();
              event.preventDefault();
            }}
            style={{
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 12,
              border: 'none',
              background: colors.blueAccent,
              color: colors.text,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
              touchAction: 'manipulation',
            }}
          >
            Add
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SectionHeader({ label }: { label: string }) {
  const { colors } = useTheme();
  return <span style={sectionHeaderStyle(colors)}>{label}</span>;
}

export default function IssuesPage(props: IssuesPageProps) {
  const context = useMobileGithubContext();
  return <IssuesPageBody key={context.epoch} {...props} context={context} />;
}

function IssuesPageBody({ onBack, onOpenPR, hideHeader = false, refreshSignal = 0, context }: IssuesPageProps & { context: ReturnType<typeof getMobileGithubContext> }) {
  const { colors } = useTheme();
  const [repos, setRepos] = useState<string[]>(() => loadRegisteredRepos().filter(repo => repo.length > 0));

  const [activeTab, setActiveTab] = useState<'all' | 'issues' | 'prs'>('all');
  const [selectedRepo, setSelectedRepo] = useState('all');
  const [diffSheet, setDiffSheet] = useState<{ repo: string; pr: PR } | null>(null);
  const hidden = useGithubWindowHidden();
  const previousRefresh = useRef(refreshSignal);
  const lists = useQueries({ queries: repos.flatMap(repo => [
    { ...issueListQuery(repo, { headers: context.headers, beforeRead: context.beforeRead, isHidden: () => hidden }), select: (data: unknown) => data as { issues: Issue[]; error?: string } },
    { ...pullRequestListQuery(repo, { headers: context.headers, beforeRead: context.beforeRead, isHidden: () => hidden }), select: (data: unknown) => data as { prs: PR[]; error?: string } },
  ]) }, context.client);
  const issues = repos.flatMap((repo, index) => ((lists[index * 2]?.data as { issues?: Issue[] })?.issues ?? []).map(issue => ({ issue, repo })));
  const prs = repos.flatMap((repo, index) => ((lists[index * 2 + 1]?.data as { prs?: PR[] })?.prs ?? []).map(pr => ({ pr, repo })));
  issues.sort((a, b) => b.issue.number - a.issue.number); prs.sort((a, b) => b.pr.number - a.pr.number);
  const loading = lists.some(list => list.isPending);
  const loadNote = lists.some(list => list.error || (list.data as { error?: string })?.error) ? 'GitHub refresh is delayed.' : null;
  const lastUpdated = Math.min(...lists.filter(list => list.dataUpdatedAt).map(list => githubSnapshotTime(list.data, list.dataUpdatedAt)));

  const handleOpenPRDiff = useCallback(
    (repo: string, pr: PR) => {
      setDiffSheet({ repo, pr });
      // Legacy navigator hook (no current callers wire it). The diff sheet is
      // the primary action — onOpenPR fires alongside if a parent wants to
      // also push their own route.
      if (onOpenPR) onOpenPR(repo, pr.number);
    },
    [onOpenPR],
  );

  // Pull the real registered repos from the panel registry. Fallback to
  // sessionStorage cache so the list isn't empty during the fetch.
  useEffect(() => {
    const wsToken = getMobileWsToken();
    const headers: Record<string, string> = {};
    if (wsToken) headers.Authorization = `Bearer ${wsToken}`;
    void fetch('/api/panel/repos', { cache: 'no-store', headers })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { repos?: PanelRepo[] } | null) => {
        if (!data?.repos) return;
        const slugs = data.repos
          .map((r) => repoSlugFromRemoteUrl(r.remoteUrl))
          .filter((s): s is string => Boolean(s));
        if (slugs.length > 0) {
          setRepos(slugs);
          saveRegisteredRepos(slugs);
        }
      })
      .catch((error) => console.log('[mobile-issues] repos fetch failed', error));
  }, []);

  const fetchAll = useCallback(async (repoList: string[]) => {
    await Promise.allSettled(repoList.flatMap(repo => [
      refreshGithubList(context.client, repo, 'issues', undefined, context.headers, context.beforeRead),
      refreshGithubList(context.client, repo, 'prs', undefined, context.headers, context.beforeRead),
    ]));
  }, [context]);
  useEffect(() => {
    if (previousRefresh.current !== refreshSignal) { previousRefresh.current = refreshSignal; void fetchAll(repos); }
  }, [fetchAll, repos, refreshSignal]);

  const addRepo = useCallback(
    (repo: string) => {
      const updated = [...repos, repo];
      setRepos(updated);
      saveRegisteredRepos(updated);
    },
    [repos]
  );

  const filteredIssues = selectedRepo === 'all' ? issues : issues.filter((entry) => entry.repo === selectedRepo);
  const filteredPRs = selectedRepo === 'all' ? prs : prs.filter((entry) => entry.repo === selectedRepo);
  const activeResultsEmpty = activeTab === 'all'
    ? filteredIssues.length === 0 && filteredPRs.length === 0
    : activeTab === 'issues'
      ? filteredIssues.length === 0
      : filteredPRs.length === 0;
  const emptyMessage = loadNote
    ?? (activeTab === 'issues'
      ? 'No open issues'
      : activeTab === 'prs'
        ? 'No open pull requests'
        : 'No open issues or pull requests');

  const tabs: { key: 'all' | 'prs' | 'issues'; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: filteredIssues.length + filteredPRs.length },
    { key: 'prs', label: 'PRs', count: filteredPRs.length },
    { key: 'issues', label: 'Issues', count: filteredIssues.length },
  ];

  const handleRefresh = useCallback(async () => {
    await fetchAll(repos);
  }, [fetchAll, repos]);

  return (
   <PullToRefresh onRefresh={handleRefresh}>
    <div style={{ padding: '0 12px 24px', width: '100%', boxSizing: 'border-box', background: colors.bg, minHeight: '100%' }}>
      <GithubReadStatus error={loadNote} updatedAt={Number.isFinite(lastUpdated) ? lastUpdated : null} />
      {hideHeader ? (
        <p style={{ margin: '8px 4px 12px', fontSize: 13, color: colors.textSecondary, fontWeight: 500 }}>
          {loading ? 'Loading...' : `${filteredIssues.length} issues · ${filteredPRs.length} PRs`}
        </p>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', color: colors.text, margin: 0 }}>
              Issues & PRs
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: colors.textSecondary, fontWeight: 500 }}>
              {loading ? 'Loading...' : `${filteredIssues.length} issues · ${filteredPRs.length} PRs`}
            </p>
          </div>
          <button
            type="button"
            onClick={onBack}
            style={{
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 12,
              border: 'none',
              background: colors.blueAccent,
              color: colors.text,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            Done
          </button>
        </div>
      )}

      <RepoSwitcher repos={repos} selected={selectedRepo} onSelect={setSelectedRepo} onAddRepo={addRepo} />

      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: 4,
          borderRadius: 14,
          background: colors.cardBg,
          border: `1px solid ${colors.cardBorder}`,
          marginBottom: 16,
        }}
      >
        {tabs.map((tab) => {
          const active = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              onTouchEnd={(event) => {
                setActiveTab(tab.key);
                event.preventDefault();
              }}
              style={{
                flex: 1,
                minHeight: 44,
                borderRadius: 12,
                border: active ? `1px solid ${colors.blueGlassBorder}` : '1px solid transparent',
                background: active ? colors.blueGlass : 'transparent',
                cursor: 'pointer',
                WebkitTapHighlightColor: 'transparent',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 4,
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, color: active ? colors.text : colors.textSecondary }}>
                {tab.label}
              </span>
              <span
                style={{
                  minWidth: 18,
                  height: 18,
                  borderRadius: 999,
                  padding: '0 5px',
                  background: active ? colors.blueAccent : colors.surfaceBorder,
                  color: active ? colors.text : colors.textSecondary,
                  fontSize: 10,
                  fontWeight: 700,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading ? (
          <div
            style={{
              padding: '32px 20px',
              textAlign: 'center',
              color: colors.textSecondary,
              fontSize: 14,
              borderRadius: 14,
              background: colors.cardBg,
              border: `1px solid ${colors.cardBorder}`,
            }}
          >
            Loading...
          </div>
        ) : (
          <>
            {loadNote && !activeResultsEmpty ? (
              <div
                style={{
                  paddingTop: 12,
                  paddingRight: 16,
                  paddingBottom: 12,
                  paddingLeft: 16,
                  textAlign: 'center',
                  color: colors.textSecondary,
                  fontSize: 13,
                  borderRadius: 14,
                  background: colors.cardBg,
                  border: `1px solid ${colors.cardBorder}`,
                }}
              >
                {loadNote}
              </div>
            ) : null}
            {(activeTab === 'all' || activeTab === 'prs') && filteredPRs.length > 0 ? (
              <>
                {activeTab === 'all' ? <SectionHeader label="Pull Requests" /> : null}
                {filteredPRs.map(({ pr, repo }) => (
                  <MobileIssuesPRCard key={`pr-${repo}-${pr.number}`} pr={pr} repo={repo} onOpen={() => handleOpenPRDiff(repo, pr)} />
                ))}
              </>
            ) : null}
            {(activeTab === 'all' || activeTab === 'issues') && filteredIssues.length > 0 ? (
              <>
                {activeTab === 'all' ? <SectionHeader label="Issues" /> : null}
                {filteredIssues.map(({ issue, repo }) => (
                  <IssueCard key={`issue-${repo}-${issue.number}`} issue={issue} repo={repo} />
                ))}
              </>
            ) : null}
            {activeResultsEmpty ? (
              <div
                style={{
                  paddingTop: 32,
                  paddingRight: 20,
                  paddingBottom: 32,
                  paddingLeft: 20,
                  textAlign: 'center',
                  color: colors.textSecondary,
                  fontSize: 14,
                  borderRadius: 14,
                  background: colors.cardBg,
                  border: `1px solid ${colors.cardBorder}`,
                }}
              >
                {emptyMessage}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div style={{ marginTop: 24 }}>
        <SectionHeader label="Deployments" />
        <Suspense
          fallback={
            <div
              style={{
                padding: '20px',
                textAlign: 'center',
                color: colors.textSecondary,
                fontSize: 13,
                borderRadius: 14,
                background: colors.cardBg,
                border: `1px solid ${colors.cardBorder}`,
              }}
            >
              Loading...
            </div>
          }
        >
          <DeployStatus repos={repos} />
        </Suspense>
      </div>

      {diffSheet ? (
        <Suspense fallback={null}>
          <MobileDiffViewer
            open
            onClose={() => setDiffSheet(null)}
            source={{ kind: 'pr', repo: diffSheet.repo, number: diffSheet.pr.number }}
            title={diffSheet.pr.title}
            subtitle={`${repoShort(diffSheet.repo)} #${diffSheet.pr.number}`}
          />
        </Suspense>
      ) : null}
    </div>
   </PullToRefresh>
  );
}
