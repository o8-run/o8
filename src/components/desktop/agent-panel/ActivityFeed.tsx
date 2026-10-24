'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useActivityExtras } from './useActivityExtras';
import { ActivityFeedControls } from './ActivityFeedControls';
import { ActivityFeedTimeline } from './ActivityFeedTimeline';
import { useActivityPrHoverDetail } from './useActivityPrHoverDetail';
import { useActivityCiHoverDetail } from './useActivityCiHoverDetail';
import {
  ActivityFeedEmptyState,
  activityItemKey,
  agentRepoSlug,
  normalizeActivitySubject,
  normalizeRepoSlug,
  shortRepoLabel,
  shortWorkspaceLabel,
} from './shared';
import type {
  ActivityItem,
  AgentDetail,
  CommitSummary,
  EventEntry,
  FeedFilter,
  RepoTaskLaunchRequest,
} from './types';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';

const ALL_REPOS_KEY = '__github__';

interface ActivityFeedProps {
  events: EventEntry[];
  commits: CommitSummary[];
  agents: AgentDetail[];
  onSelectSession?: (sessionKey: string) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectPR?: (prNumber: number, repo?: string) => void;
  onReviewPR?: (prNumber: number, repo?: string) => void;
  onLaunchTask?: (request: RepoTaskLaunchRequest) => void;
  activeRepo?: string | null;
  activeAgentKey?: string | null;
  refreshKey?: number;
}

export const ActivityFeed = memo(function ActivityFeed({
  events,
  commits,
  agents,
  onSelectSession,
  onSelectIssue,
  onSelectCommit,
  onSelectPR,
  onReviewPR,
  onLaunchTask,
  activeRepo: externalRepo,
  activeAgentKey,
  refreshKey,
}: ActivityFeedProps) {
  const [filter, setFilter] = useState<FeedFilter>('all');
  const [repoOverrideState, setRepoOverrideState] = useState<{
    activeAgentKey: string | null;
    value: string | null;
  }>(() => ({ activeAgentKey: activeAgentKey ?? null, value: null }));
  const repoOverride = repoOverrideState.activeAgentKey === (activeAgentKey ?? null)
    ? repoOverrideState.value
    : null;
  const setRepoOverride = useCallback((value: string | null) => {
    setRepoOverrideState({ activeAgentKey: activeAgentKey ?? null, value });
  }, [activeAgentKey]);
  const [repoPickerOpen, setRepoPickerOpen] = useState(false);
  const [registeredRepos, setRegisteredRepos] = useState<string[]>([]);
  const [hoveredItemKey, setHoveredItemKey] = useState<string | null>(null);
  const [hoveredItemRect, setHoveredItemRect] = useState<DOMRect | null>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    ipcFetch('/api/panel/repos')
      .then((response) => response.json())
      .then((data) => {
        const ghRepos = (data.repos ?? [])
          .map((repo: { remoteUrl?: string }) => {
            const url = (repo.remoteUrl ?? '').replace(/\.git$/, '');
            const parts = url.split('/');
            return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
          })
          .filter(Boolean) as string[];
        setRegisteredRepos(ghRepos);
      })
      .catch(() => {});
  }, []);

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.sessionKey === activeAgentKey) ?? null,
    [agents, activeAgentKey],
  );
  const activeAgentRepo = useMemo(() => agentRepoSlug(activeAgent), [activeAgent]);
  const activeAgentWorkspaceLabel = useMemo(
    () => shortWorkspaceLabel(activeAgent?.runtimeSurface?.cwd ?? activeAgent?.workspace),
    [activeAgent],
  );
  const externalPanelRepo = useMemo(() => normalizeRepoSlug(externalRepo), [externalRepo]);
  const liveAgentRepos = useMemo(
    () => agents
      .map((agent) => agentRepoSlug(agent))
      .filter((repo): repo is string => Boolean(repo)),
    [agents],
  );

  const allRepos = useMemo(() => {
    const repoSet = new Set<string>();
    if (activeAgentRepo) repoSet.add(activeAgentRepo);
    if (externalPanelRepo) repoSet.add(externalPanelRepo);
    for (const repo of liveAgentRepos) repoSet.add(repo);
    for (const repo of registeredRepos) {
      const normalized = normalizeRepoSlug(repo);
      if (normalized) repoSet.add(normalized);
    }
    return Array.from(repoSet);
  }, [activeAgentRepo, externalPanelRepo, liveAgentRepos, registeredRepos]);

  const repo = useMemo(() => {
    if (repoOverride) return repoOverride;
    if (externalPanelRepo) return externalPanelRepo;
    if (activeAgentRepo) return activeAgentRepo;
    if (allRepos.length > 0) return ALL_REPOS_KEY;
    return null;
  }, [repoOverride, activeAgentRepo, externalPanelRepo, allRepos]);

  const isAllRepos = repo === ALL_REPOS_KEY;
  const repoLabel = isAllRepos ? 'GitHub' : repo ? shortRepoLabel(repo) : activeAgentWorkspaceLabel;
  const scopeHelp = isAllRepos
    ? 'Recent pull requests, commits, issues, and checks across your registered repos.'
    : repo
      ? `Recent pull requests, commits, issues, and checks for ${shortRepoLabel(repo)}.`
      : 'Recent repo work appears here once a GitHub repo is attached.';

  const agentRepoById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agentRepoSlug(agent)])),
    [agents],
  );
  const visibleAgentEvents = useMemo(() => {
    return events.filter((event) => {
      const eventRepo = agentRepoById.get(event.agentId) ?? event.repo ?? null;
      if (!eventRepo) return !repo || isAllRepos;
      if (!repo || isAllRepos) return true;
      return eventRepo === repo;
    });
  }, [agentRepoById, events, isAllRepos, repo]);

  const { extras, remoteScopeError, timelineOrigin, updatedAt } = useActivityExtras(repo, allRepos, isAllRepos, refreshKey);

  const fallbackCommitItems = useMemo<ActivityItem[]>(() => {
    if (repo || extras.repoCommits.length > 0) return [];
    const fallbackRepo = externalPanelRepo ?? activeAgentRepo ?? null;
    return commits.slice(0, 10).map((commit, index) => ({
      kind: 'commit' as const,
      hash: commit.hash,
      message: commit.message,
      age: commit.age,
      ts: timelineOrigin - index,
      repo: fallbackRepo ?? undefined,
    }));
  }, [activeAgentRepo, commits, externalPanelRepo, extras.repoCommits.length, repo, timelineOrigin]);

  const items = useMemo<ActivityItem[]>(() => {
    const timeline: ActivityItem[] = [];
    timeline.push(...extras.repoCommits, ...fallbackCommitItems);
    if (!repo || isAllRepos) {
      for (const event of visibleAgentEvents) {
        const ts = event.timestamp ? new Date(event.timestamp).getTime() || timelineOrigin : timelineOrigin;
        timeline.push({ kind: 'event', data: event, ts });
      }
    }
    timeline.push(...extras.issues, ...extras.prs, ...extras.ciRuns);
    timeline.sort((a, b) => b.ts - a.ts);
    return timeline.slice(0, 40);
  }, [extras, fallbackCommitItems, isAllRepos, repo, timelineOrigin, visibleAgentEvents]);

  const counts = useMemo(() => {
    const nextCounts: Record<FeedFilter, number> = { all: items.length, commit: 0, issue: 0, pr: 0, ci: 0, packet: 0 };
    for (const item of items) {
      if (item.kind === 'event') continue;
      if (item.kind in nextCounts) nextCounts[item.kind as FeedFilter]++;
    }
    return nextCounts;
  }, [items]);

  const filtered = useMemo(() => {
    if (filter !== 'all') return items.filter((item) => item.kind === filter);

    const primarySubjects = new Set(
      items.flatMap((item) => {
        if (item.kind === 'commit') {
          const subject = normalizeActivitySubject(item.message);
          return subject ? [subject] : [];
        }
        if (item.kind === 'pr') {
          const subject = normalizeActivitySubject(item.title);
          return subject ? [subject] : [];
        }
        return [];
      }),
    );

    return items.filter((item) => {
      if (item.kind !== 'ci') return true;
      const subject = normalizeActivitySubject(item.title);
      return !(subject && primarySubjects.has(subject));
    });
  }, [filter, items]);

  const commitStack = useMemo(
    () => extras.repoCommits.filter((item): item is Extract<ActivityItem, { kind: 'commit' }> => item.kind === 'commit').slice(0, 5),
    [extras.repoCommits],
  );

  const hoveredPr = filtered.find((item) => item.kind === 'pr' && activityItemKey(item) === hoveredItemKey);
  const prHover = useActivityPrHoverDetail(hoveredPr?.kind === 'pr' ? hoveredPr.repo : null,
    hoveredPr?.kind === 'pr' ? hoveredPr.number : null);
  const prHoverDetails = prHover.detail && hoveredItemKey && hoveredPr ? { [hoveredItemKey]: prHover.detail } : {};
  const hoveredCi = filtered.find((item) => item.kind === 'ci' && activityItemKey(item) === hoveredItemKey);
  const ciHover = useActivityCiHoverDetail(hoveredCi?.kind === 'ci' ? hoveredCi.repo : null,
    hoveredCi?.kind === 'ci' ? hoveredCi.id : null);
  const ciHoverDetails = ciHover.detail && hoveredItemKey && hoveredCi ? { [hoveredItemKey]: ciHover.detail } : {};

  const openHoverCard = useCallback((key: string, rect: DOMRect) => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
    setHoveredItemKey(key);
    setHoveredItemRect(rect);
  }, []);

  const scheduleHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = setTimeout(() => {
      setHoveredItemKey(null);
      setHoveredItemRect(null);
    }, 140);
  }, []);

  const cancelHoverClose = useCallback(() => {
    if (hoverCloseTimerRef.current) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  }, []);

  const grouped = useMemo(() => {
    const groups: Array<{ label: string; items: ActivityItem[] }> = [];
    let currentLabel = '';
    const today = new Date(timelineOrigin).toDateString();
    const yesterday = new Date(timelineOrigin - 86400000).toDateString();

    for (const item of filtered) {
      const dateLabel = new Date(item.ts).toDateString();
      const label = dateLabel === today
        ? 'Today'
        : dateLabel === yesterday
          ? 'Yesterday'
          : new Date(item.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (label !== currentLabel) {
        groups.push({ label, items: [] });
        currentLabel = label;
      }
      groups[groups.length - 1].items.push(item);
    }
    return groups;
  }, [filtered, timelineOrigin]);

  const missingGitHubScope = allRepos.length === 0 && !externalPanelRepo && !activeAgentRepo;
  const openPrItems = extras.prs.filter((item): item is Extract<ActivityItem, { kind: 'pr' }> => item.kind === 'pr' && item.state === 'open');
  const openPrContext = openPrItems.length > 0 ? { count: openPrItems.length, repo: openPrItems[0].repo } : null;

  if (!items.length) {
    return <ActivityFeedEmptyState missingGitHubScope={missingGitHubScope} repoLabel={repoLabel} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <ActivityFeedControls
        repoLabel={repoLabel}
        repoPickerOpen={repoPickerOpen}
        onToggleRepoPicker={() => setRepoPickerOpen((current) => !current)}
        isAllRepos={isAllRepos}
        repo={repo}
        allRepos={allRepos}
        scopeHelp={scopeHelp}
        remoteScopeError={remoteScopeError}
        remoteUpdatedAt={Number.isFinite(updatedAt) ? updatedAt : null}
        filter={filter}
        counts={counts}
        onSelectFilter={setFilter}
        onSelectRepo={(repoSlug) => {
          setRepoOverride(repoSlug);
          setRepoPickerOpen(false);
        }}
        onSelectAllRepos={() => {
          setRepoOverride(ALL_REPOS_KEY);
          setRepoPickerOpen(false);
        }}
        openPrContext={openPrContext}
        onOpenPrs={(repoSlug) => (onReviewPR ?? onSelectPR)?.(0, repoSlug)}
      />

      <ActivityFeedTimeline
        grouped={grouped}
        filteredLength={filtered.length}
        filter={filter}
        repoLabel={repoLabel}
        items={items}
        agents={agents}
        hoveredItemKey={hoveredItemKey}
        hoveredItemRect={hoveredItemRect}
        prHoverDetails={prHoverDetails}
        prHoverStatus={prHover.status}
        ciHoverDetails={ciHoverDetails}
        ciHoverStatus={ciHover.status}
        commitStack={commitStack}
        onOpenHoverCard={openHoverCard}
        onUpdateHoveredRect={setHoveredItemRect}
        onScheduleHoverClose={scheduleHoverClose}
        onCancelHoverClose={cancelHoverClose}
        onSelectSession={onSelectSession}
        onSelectIssue={onSelectIssue}
        onSelectCommit={onSelectCommit}
        onSelectPR={onSelectPR}
        onReviewPR={onReviewPR}
        onLaunchTask={onLaunchTask}
      />
    </div>
  );
});
