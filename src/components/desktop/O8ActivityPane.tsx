'use client';
import { GithubReadStatus } from '@/components/github/GithubReadStatus';

/**
 * O8ActivityPane — Activity feed for the O8 Panel right-side panel.
 *
 * Fetches commits, PRs, issues, and CI runs from the panel API endpoints
 * AND folds in orchestrator packets + auto-directive proposals from
 * mission state. Renders a unified, chronological timeline with segmented
 * filter pills and a repo selector dropdown.
 *
 * As of the Mission-rail consolidation (commit 2), packets render
 * unconditionally and the directive proposals section is pinned above the
 * timeline. The right-side Mission rail in OrchestratorTab is deleted —
 * Activity is the single mission-control surface.
 */

import { RamsButton } from './settings/RamsButton';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTheme } from '@/lib/theme/context';
import type { ActivityItem } from './agent-panel/types';
import { shortRepoLabel, normalizeRepoSlug } from './agent-panel/shared';
import { openExternalUrl } from '@/lib/desktop/open-external';
import { usePrLinkDestinationFlag } from '@/lib/operator/use-pr-link-destination';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import {
  ACTIVITY_COLORS,
  FILTER_TABS,
  IconZap,
  feedIconForItem,
  itemBadge,
  itemKey,
  itemSubline,
  itemTitle,
  renderExpandedDetail,
  useExpandDetails,
  type O8FeedFilter,
} from './o8-activity-helpers';
import { useO8ActivityData } from './useO8ActivityData';
import { repoSlugFromRemote } from './canvas-utils';
import { groupActivityByCommitSha } from './o8-activity-grouping';
import { useOrchestratorData } from './orchestrator-data-context';
import {
  O8DirectiveProposalDrawer,
  hydrateProposalPrefs,
  markProposalsSeen,
  PROPOSALS_OPEN_KEY,
} from './o8-panel/O8DirectiveProposalDrawer';
import { O8ActivityMissionControls } from './o8-panel/O8ActivityMissionControls';
import { O8ActivityPacketRow } from './o8-panel/O8ActivityPacketRow';
import { O8ProblemDossiers } from './o8-panel/O8ProblemDossiers';
import { O8RepoSelector } from './o8-panel/O8RepoSelector';
import { PrPanel } from './pr-panel/PrPanel';
import { useDirectiveProposals } from './thoughts/mission-panel/useDirectiveProposals';
import type { DirectiveProposalCandidate } from './thoughts/directive-proposal-types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

const EMPTY_REPO_ENTRIES: RepoRegistryEntry[] = [];

const FILTER_TABS_WITH_PACKETS = [
  ...FILTER_TABS,
  { key: 'packet' as O8FeedFilter, label: 'Packets', icon: (c: string) => <IconZap size={11} color={c} /> },
];

function activityItemMatchesFilter(item: ActivityItem, filter: O8FeedFilter) {
  if (filter === 'all') return true;
  if (filter === 'ci' && item.kind === 'commit' && item.groupedCiRun) return true;
  return item.kind === filter;
}

/** Returns epoch milliseconds parsed from an optional ISO date string, or null when absent or unparseable. */
function parseTs(value?: string | null): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ── Component ──

interface O8ActivityPaneProps {
  active?: boolean;
  repoPath?: string | null;
  repoSlug?: string | null;
  registeredRepos?: RepoRegistryEntry[];
  allRepos?: boolean;
  onSelectAllRepos?: () => void;
  onSelectRepoPath?: (repoPath: string) => void;
  onSelectCommit?: (hash: string, meta?: Record<string, string>) => void;
  onSelectIssue?: (issueNumber: number, repo?: string) => void;
  onSelectPR?: (number: number, repo?: string) => void;
  onClosePR?: (number: number, repo?: string | null) => void;
  selectedPrNumber?: number | null;
  selectedPrRepo?: string | null;
}

export const O8ActivityPane = memo(function O8ActivityPane({
  active = true,
  repoPath,
  repoSlug,
  registeredRepos: registeredRepoEntries = EMPTY_REPO_ENTRIES,
  allRepos = false,
  onSelectAllRepos,
  onSelectRepoPath,
  onSelectCommit,
  onSelectIssue,
  selectedPrNumber,
  selectedPrRepo,
  onSelectPR,
  onClosePR,
}: O8ActivityPaneProps) {
  const { workspaceGlass } = useTheme();
  const [packetFallbackTimestamp] = useState(() => Date.now());
  const [filter, setFilter] = useState<O8FeedFilter>('all');
  const [fallbackRepoOptions, setFallbackRepoOptions] = useState<string[]>([]);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [proposalsOpen, setProposalsOpen] = useState(false);
  // Frozen-per-mount set of proposal ids the operator had already seen.
  // Empty on the server / first paint (hydration-safe), filled in an effect.
  const [seenProposalSnapshot, setSeenProposalSnapshot] = useState<Set<string>>(() => new Set());
  const proposalAutoOpenedRef = useRef(false);
  const persistedSeenSigRef = useRef('');
  const prSelectionKey = `${selectedPrRepo ?? repoSlug ?? ''}:${selectedPrNumber ?? ''}`;
  const suppliedPr = selectedPrNumber ? { number: selectedPrNumber, repo: selectedPrRepo ?? repoSlug ?? null } : null;
  const [prSelection, setPrSelection] = useState(() => ({ key: prSelectionKey, pr: suppliedPr }));
  const selectedPr = prSelection.key === prSelectionKey ? prSelection.pr : suppliedPr;
  if (prSelection.key !== prSelectionKey) setPrSelection({ key: prSelectionKey, pr: suppliedPr });
  const setSelectedPr = useCallback((pr: { number: number; repo: string | null } | null) => setPrSelection({ key: prSelectionKey, pr }), [prSelectionKey]);
  const prLinkDestination = usePrLinkDestinationFlag();

  // Hydrate the proposals open/closed pref after mount so SSR doesn't
  // hydrate-mismatch. Default = collapsed; the row is recommendations,
  // not pending tasks, so it shouldn't dominate the timeline visually.
  useEffect(() => {
    hydrateProposalPrefs(setProposalsOpen, setSeenProposalSnapshot);
  }, []);
  const handleToggleProposals = useCallback(() => {
    setProposalsOpen((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(PROPOSALS_OPEN_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const { prDetails, fetchForItem } = useExpandDetails();
  const mountedRef = useRef(true);
  const [retryNonce, setRetryNonce] = useState(0);
  const orchestratorData = useOrchestratorData();
  const missionPackets = orchestratorData?.missionState?.packets;
  const activeMissionId = orchestratorData?.missionState?.missionId?.trim() ?? '';

  // #746 — directive proposals are surfaced above the timeline as
  // recommendations. Accept routes through OrchestratorDataContext so the
  // orchestrator chat composer pre-fills with the proposed directive.
  const handleAcceptDirectiveProposal = useCallback((proposal: DirectiveProposalCandidate) => {
    const draftText = [
      proposal.source === 'observation'
        ? 'Please review and promote the following worker observation if it is worth keeping:'
        : 'Please save the following directive after I review it:',
      '',
      proposal.draftDirective,
    ].join('\n');
    orchestratorData?.onAcceptDirectiveProposal?.({
      id: `proposal-accept-${proposal.id}-${Date.now()}`,
      text: draftText,
    });
  }, [orchestratorData]);

  const registeredRepos = useMemo(() => {
    const slugs = registeredRepoEntries
      .map((entry) => repoSlugFromRemote(entry.remoteUrl) ?? normalizeRepoSlug(entry.name))
      .filter((slug): slug is string => Boolean(slug));
    return Array.from(new Set(slugs));
  }, [registeredRepoEntries]);

  const repoOptions = registeredRepos.length > 0 ? registeredRepos : fallbackRepoOptions;

  // Fallback for legacy callers/tests that do not pass the dashboard registry.
  useEffect(() => {
    if (registeredRepos.length > 0) return;
    let cancelled = false;
    ipcFetch('/api/panel/repos')
      .then((res) => res.json())
      .then((d) => {
        const slugs = (d.repos ?? [])
          .map((r: { remoteUrl?: string | null; name?: string | null }) => {
            return repoSlugFromRemote(r.remoteUrl) ?? normalizeRepoSlug(r.name);
          })
          .filter(Boolean) as string[];
        if (!cancelled && mountedRef.current) setFallbackRepoOptions(Array.from(new Set(slugs)));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [registeredRepos.length]);

  // Resolve the focused repo's slug from the shared scope (a localPath) so the
  // feed fetch keys off the same repo the Workspace tab + left switcher show.
  const selectedSlug = useMemo(() => {
    if (!repoPath) return null;
    const entry = registeredRepoEntries.find((e) => e.localPath === repoPath);
    if (!entry) return null;
    return repoSlugFromRemote(entry.remoteUrl);
  }, [repoPath, registeredRepoEntries]);

  const effectiveRepo = useMemo(() => {
    if (repoPath && registeredRepoEntries.some((entry) => entry.localPath === repoPath)) return selectedSlug;
    if (selectedSlug) return selectedSlug;
    const normalized = normalizeRepoSlug(repoSlug);
    if (normalized) return normalized;
    if (!repoPath && repoOptions.length > 0) return repoOptions[0];
    return null;
  }, [selectedSlug, repoSlug, repoOptions, repoPath, registeredRepoEntries]);

  // Slug → on-disk path, so the local-git commit fallback (#1341) can resolve
  // a workspace path in all-repos mode too (not just the focused repo).
  const pathForSlug = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of registeredRepoEntries) {
      const slug = repoSlugFromRemote(entry.remoteUrl) ?? normalizeRepoSlug(entry.name);
      if (slug && entry.localPath) map.set(slug, entry.localPath);
    }
    return map;
  }, [registeredRepoEntries]);

  // Whether the *focused* repo has a real GitHub remote. Drives honest empty
  // copy: PRs/Issues/CI can't exist without GitHub, so a local-only repo says
  // "Connect GitHub …" instead of the misleading "No activity yet" (#1341).
  const focusedGithubConnected = useMemo(() => {
    if (allRepos) return true; // mixed scope — don't imply a single repo lacks GitHub
    if (repoPath) {
      const entry = registeredRepoEntries.find((e) => e.localPath === repoPath);
      if (entry) return Boolean(repoSlugFromRemote(entry.remoteUrl));
    }
    // Legacy prop path with no matching registry entry: a resolved remote slug
    // means GitHub is in play.
    return Boolean(normalizeRepoSlug(repoSlug));
  }, [allRepos, repoPath, registeredRepoEntries, repoSlug]);

  const isAllRepos = allRepos;

  const targets = useMemo(() => {
    if (isAllRepos) return registeredRepoEntries.length > 0
      ? registeredRepoEntries.map((entry) => ({ repo: repoSlugFromRemote(entry.remoteUrl), path: entry.localPath }))
      : repoOptions.map((slug) => ({ repo: slug, path: pathForSlug.get(slug) ?? null }));
    return effectiveRepo || repoPath
      ? [{ repo: effectiveRepo, path: repoPath ?? (effectiveRepo ? pathForSlug.get(effectiveRepo) : null) ?? null }]
      : [];
  }, [isAllRepos, registeredRepoEntries, repoOptions, pathForSlug, effectiveRepo, repoPath]);
  const { data, loading } = useO8ActivityData(targets, active, isAllRepos, retryNonce);

  const {
    proposals,
    pendingProposalId,
    handleAccept: handleAcceptProposal,
    handleDismiss: handleDismissProposal,
  } = useDirectiveProposals({
    open: true,
    visible: active || !loading,
    retryNonce: 0,
    onAccept: handleAcceptDirectiveProposal,
  });

  // #9 — unread / actionable hierarchy. Proposals not in the frozen seen
  // snapshot read as "new": accent dot + border on the row, accent header,
  // and a one-time auto-open so they aren't buried. We persist "seen" once
  // the section is open (clears the emphasis on the NEXT load) but keep the
  // snapshot frozen this session so opening doesn't make "N new" vanish
  // while the operator is still looking.
  const newProposalIds = useMemo(
    () => new Set(proposals.filter((p) => !seenProposalSnapshot.has(p.id)).map((p) => p.id)),
    [proposals, seenProposalSnapshot],
  );
  const unreadProposalCount = newProposalIds.size;

  useEffect(() => {
    if (proposalAutoOpenedRef.current || unreadProposalCount === 0) return;
    proposalAutoOpenedRef.current = true;
    setProposalsOpen(true);
  }, [unreadProposalCount]);

  useEffect(() => {
    if (!proposalsOpen || proposals.length === 0) return;
    // Persist only when the proposal set changes — the hook may hand us a
    // fresh array reference each render, and we don't want a localStorage
    // write on every one.
    const sig = proposals.map((p) => p.id).sort().join('|');
    if (persistedSeenSigRef.current === sig) return;
    persistedSeenSigRef.current = sig;
    markProposalsSeen(proposals.map((p) => p.id));
  }, [proposalsOpen, proposals]);

  // Packet items are derived from orchestrator missionState (not the
  // /api/panel feed). Always-on as of commit 2 — Mission rail is gone, so
  // Activity is the single read for "what packets are live."
  const packetItems = useMemo<ActivityItem[]>(() => {
    if (!missionPackets) return [];
    const items: ActivityItem[] = [];
    for (const packet of missionPackets) {
      if (packet.archivedAt) continue;
      // Comparison-group siblings — render only the leader, like the
      // Mission rail used to do via ComparisonCard.
      if (packet.comparisonGroupId && packet.comparisonIndex && packet.comparisonIndex > 0) continue;
      const ts = parseTs(packet.lane?.lastEventAt) ?? parseTs(packet.lastEventAt) ?? packetFallbackTimestamp;
      items.push({ kind: 'packet', packet, ts, repo: packet.workspaceTargetPath ?? undefined });
    }
    return items;
  }, [missionPackets, packetFallbackTimestamp]);

  // Build sorted timeline
  const allItems = useMemo<ActivityItem[]>(() => {
    const timeline = groupActivityByCommitSha([...data.commits, ...data.prs, ...data.issues, ...data.ciRuns, ...packetItems]);
    return timeline.slice(0, 50);
  }, [data, packetItems]);

  const counts = useMemo(() => {
    const c: Record<O8FeedFilter, number> = { all: allItems.length, commit: 0, issue: 0, pr: 0, ci: 0, packet: 0 };
    for (const item of allItems) {
      if (item.kind in c) c[item.kind as O8FeedFilter]++;
      if (item.kind === 'commit' && item.groupedCiRun) c.ci++;
    }
    return c;
  }, [allItems]);

  const filtered = useMemo(() => {
    return allItems.filter((item) => activityItemMatchesFilter(item, filter));
  }, [allItems, filter]);

  // Group by day
  const grouped = useMemo(() => {
    const groups: Array<{ label: string; items: ActivityItem[] }> = [];
    let currentLabel = '';
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

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
  }, [filtered]);

  const handleItemClick = useCallback((item: ActivityItem) => {
    if (item.kind === 'commit') {
      onSelectCommit?.(item.hash, item.repo ? { repo: item.repo } : undefined);
    } else if (item.kind === 'pr') {
      if (prLinkDestination === 'browser' && item.repo) {
        openExternalUrl(`https://github.com/${item.repo}/pull/${item.number}`);
      } else {
        setSelectedPr({ number: item.number, repo: item.repo ?? null });
        onSelectPR?.(item.number, item.repo);
      }
    } else if (item.kind === 'issue') {
      if (onSelectIssue) {
        onSelectIssue(item.number, item.repo);
      } else {
        openExternalUrl(`https://github.com/${item.repo}/issues/${item.number}`);
      }
    } else if (item.kind === 'ci') {
      openExternalUrl(`https://github.com/${item.repo}/actions/runs/${item.id}`);
    }
  }, [onSelectCommit, onSelectIssue, onSelectPR, prLinkDestination, setSelectedPr]);

  if (selectedPr) {
    return (
      <PrPanel
        id="right-pr-detail"
        active={active}
        prNumber={selectedPr.number}
        repoSlug={selectedPr.repo ?? repoSlug ?? null}
        repoPath={repoPath ?? null}
        onSelectLayer={number => { setSelectedPr({ number, repo: selectedPr.repo }); onSelectPR?.(number, selectedPr.repo ?? undefined); }}
        onClose={() => { setSelectedPr(null); onClosePR?.(selectedPr.number, selectedPr.repo); }}
      />
    );
  }

  return (
    <div style={{
      ...(workspaceGlass ? {
        '--o8-activity-label-fg': 'var(--t-text-secondary)',
        '--o8-activity-label-bg': 'var(--t-input-bg)',
        '--o8-activity-issue-fg': 'var(--t-text-muted)',
        '--o8-activity-issue-bg': 'var(--t-hover)',
      } : {}),
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    } as CSSProperties}>
      {/* Header: repo selector + filter pills */}
      <div style={{
        paddingTop: 10,
        paddingRight: 12,
        paddingBottom: 8,
        paddingLeft: 12,
        borderBottom: '1px solid var(--t-divider)',
        flexShrink: 0,
      }}>
        {/* Repo selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <O8RepoSelector
            active={active}
            repos={registeredRepoEntries}
            allRepos={allRepos}
            selectedRepoPath={repoPath ?? null}
            onSelectAll={() => onSelectAllRepos?.()}
            onSelectRepo={(path) => onSelectRepoPath?.(path)}
            style={{ flex: 1, minWidth: 0 }}
          />

          <O8ActivityMissionControls
            missionId={activeMissionId}
          />
        </div>

        {/* Filter pills */}
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          paddingTop: 3,
          paddingRight: 3,
          paddingBottom: 3,
          paddingLeft: 3,
          borderRadius: 10,
          border: '0.5px solid var(--t-divider-subtle)',
          background: 'var(--t-panel)',
        }}>
          {FILTER_TABS_WITH_PACKETS.map((tab) => {
            const active = filter === tab.key;
            const count = counts[tab.key];
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setFilter(tab.key)}
                title={tab.label}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = 'var(--t-hover)';
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = 'transparent';
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  paddingTop: 3,
                  paddingRight: 8,
                  paddingBottom: 3,
                  paddingLeft: 6,
                  borderRadius: 999,
                  border: 'none',
                  background: active ? ACTIVITY_COLORS.accentBg : 'transparent',
                  color: active ? ACTIVITY_COLORS.accent : 'var(--t-text-muted)',
                  fontSize: 11,
                  fontWeight: 350,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans-system)',
                  transition: 'background 120ms ease, color 120ms ease',
                  letterSpacing: '-0.1px',
                }}
              >
                {tab.icon(active ? ACTIVITY_COLORS.accent : 'var(--t-text-muted)')}
                {tab.label}
                {count > 0 && tab.key !== 'all' ? (
                  <span style={{
                    fontSize: 9.5,
                    fontWeight: 260,
                    letterSpacing: '-0.4px',
                    color: active ? ACTIVITY_COLORS.accent : 'var(--t-text-faint)',
                    fontFamily: 'var(--font-sans-system)',
                  }}>
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      {/* Activity list */}
      <div className="cortex-scroll-fade-y cortex-themed-scroll" style={{
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
      }}>
        <O8ProblemDossiers
          active={active}
          repoPath={repoPath ?? null}
          refreshKey={orchestratorData?.missionState?.updatedAt ?? null}
        />
        <O8DirectiveProposalDrawer
          proposals={proposals}
          proposalsOpen={proposalsOpen}
          onToggleProposals={handleToggleProposals}
          unreadProposalCount={unreadProposalCount}
          pendingProposalId={pendingProposalId}
          newProposalIds={newProposalIds}
          onAccept={handleAcceptProposal}
          onDismiss={handleDismissProposal}
        />
        {!loading && (data.workspaceError || data.remoteError) ? (
          <div role="status" style={{ paddingTop: 16, paddingRight: 14, paddingBottom: 16, paddingLeft: 14, color: 'var(--t-text-muted)', fontSize: 13, lineHeight: 1.45 }}>
            {data.workspaceError ? <div>{data.workspaceError}</div> : null}
            {data.remoteError ? <><div>{data.remoteError}</div><GithubReadStatus error={data.remoteError} updatedAt={data.remoteUpdatedAt ?? null} /></> : null}
            <div style={{ marginTop: 8 }}><RamsButton variant="ghost" onClick={() => setRetryNonce((n) => n + 1)}>Retry</RamsButton></div>
          </div>
        ) : null}
        {loading ? (
          <div style={{
            paddingTop: 32,
            paddingBottom: 32,
            textAlign: 'center',
            fontSize: 13,
            fontWeight: 300,
            color: 'var(--t-text-faint)',
            lineHeight: 1.45,
            letterSpacing: '-0.1px',
          }}>
            Loading activity...
          </div>
        ) : filtered.length === 0 && (data.workspaceError || data.remoteError) ? null : filtered.length === 0 ? (
          <div style={{
            paddingTop: 32,
            paddingBottom: 32,
            textAlign: 'center',
            fontSize: 13,
            fontWeight: 300,
            color: 'var(--t-text-faint)',
            lineHeight: 1.45,
            letterSpacing: '-0.1px',
          }}>
            {(() => {
              if (!effectiveRepo && !repoPath) return 'Choose a folder to see activity here.';
              const label = effectiveRepo ? shortRepoLabel(effectiveRepo) : repoPath?.split(/[\\/]/).filter(Boolean).pop() ?? 'this folder';
              // PRs / Issues / CI cannot exist without GitHub — say so plainly
              // for a repo with no remote instead of the misleading "No activity
              // yet" (#1341). Do not build the connect flow here (#1338).
              const githubOnlyFilter = filter === 'pr' || filter === 'issue' || filter === 'ci';
              if (githubOnlyFilter && !focusedGithubConnected) {
                return 'Connect GitHub to see pull requests, issues, and CI runs.';
              }
              // All / Commits empty means local git genuinely has no history —
              // the commit fallback already ran, so this is honest.
              if ((filter === 'all' || filter === 'commit') && !focusedGithubConnected) {
                return `No commits yet in ${label}.`;
              }
              return `No ${filter === 'all' ? '' : filter + ' '}activity yet for ${label}.`;
            })()}
          </div>
        ) : (
          grouped.map((group) => (
            <div key={group.label}>
              {/* Day label */}
              <div style={{
                paddingTop: 8,
                paddingRight: 14,
                paddingBottom: 4,
                paddingLeft: 14,
                fontSize: 9,
                fontWeight: 300,
                color: 'var(--t-text-faint)',
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}>
                {group.label}
              </div>

              {/* Items */}
              {group.items.map((item) => {
                if (item.kind === 'packet') {
                  const key = `pkt-${item.packet.id}`;
                  const isExpanded = expandedKey === key;
                  return (
                    <O8ActivityPacketRow
                      key={key}
                      packet={item.packet}
                      isExpanded={isExpanded}
                      onToggleExpanded={() => setExpandedKey(isExpanded ? null : key)}
                    />
                  );
                }
                const icon = feedIconForItem(item);
                const key = itemKey(item);
                const isExpanded = expandedKey === key;
                return (
                  <div key={key}>
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      onClick={() => {
                        if (isExpanded) {
                          setExpandedKey(null);
                        } else {
                          setExpandedKey(key);
                          fetchForItem(item, key);
                        }
                      }}
                      onDoubleClick={() => handleItemClick(item)}
                      title={item.kind === 'pr' ? 'Expand pull request' : 'Expand activity details'}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                        width: '100%',
                        paddingTop: 7,
                        paddingRight: 14,
                        paddingBottom: 7,
                        paddingLeft: 14,
                        border: 'none',
                        background: isExpanded ? ACTIVITY_COLORS.accentBg : 'transparent',
                        cursor: 'pointer',
                        textAlign: 'left',
                        transition: 'background 100ms cubic-bezier(0.22, 1, 0.36, 1)',
                      }}
                      onMouseEnter={(e) => { if (!isExpanded) e.currentTarget.style.background = ACTIVITY_COLORS.accentBg; }}
                      onMouseLeave={(e) => { if (!isExpanded) e.currentTarget.style.background = 'transparent'; }}
                    >
                      {/* Expand indicator */}
                      <div style={{
                        width: 10, height: 20,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, color: 'var(--t-text-faint)', fontSize: 10,
                        transition: 'transform 150ms cubic-bezier(0.22, 1, 0.36, 1)',
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                      }}>
                        <svg width="7" height="7" viewBox="0 0 7 7" fill="currentColor"><path d="M1.5 0.5L5.5 3.5L1.5 6.5Z" /></svg>
                      </div>

                      {/* Status dot */}
                      <div style={{
                        width: 20, height: 20, borderRadius: '50%',
                        background: icon.bg,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, marginTop: 1, color: icon.color,
                      }}>
                        {icon.icon}
                      </div>

                      {/* Content */}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 13.5, color: 'var(--t-text)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          lineHeight: 1.25, fontWeight: 300, letterSpacing: '-0.1px',
                        }}>
                          {itemTitle(item)}
                        </div>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          marginTop: 3, fontSize: 9.5,
                          fontWeight: 260, letterSpacing: '-0.4px',
                          color: 'var(--t-text-faint)',
                          fontFamily: 'var(--font-sans-system)',
                          lineHeight: 1.25,
                          minWidth: 0, overflow: 'hidden',
                        }}>
                          {itemSubline(item)}
                        </div>
                      </div>

                      {/* Trailing badge */}
                      {itemBadge(item)}
                    </button>

                    {/* Expanded detail */}
                    {isExpanded ? (
                      <div style={{
                        paddingTop: 6, paddingRight: 14, paddingBottom: 10, paddingLeft: 52,
                        borderBottom: '1px solid var(--t-panel-border, rgba(0,0,0,0.06))',
                      }}>
                        {renderExpandedDetail(item, prDetails, key, {
                          active,
                          onOpenPr: (pr) => handleItemClick(pr),
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
});
