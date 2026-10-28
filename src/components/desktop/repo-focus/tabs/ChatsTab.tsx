'use client';

import { removeTranscriptReadingPositions } from '@/components/desktop/thoughts/chat-panel/transcript-reading-position';
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { orchestratorBackendDisplayLabel } from '@/lib/orchestrator/display';
import { OrchestratorHoverCard } from '@/components/desktop/OrchestratorHoverCard';
import { requestConfirm, toast } from '@/components/shared/ConfirmToastHost';
import { clearLastOrchestratorThreadForId } from '@/components/desktop/workspace-terminal/orchestrator-thread-restore';
import {
  packetBelongsToRepo,
  packetVisualState,
  REPO_FOCUS_FONT,
} from '../utils';
import { SessionRow } from './AgentRows';
import { CompactChatHistory } from './chats/CompactChatHistory';
import { WorkingChatHistory } from './chats/WorkingChatHistory';
import { useSidebarFixtures } from './chats/use-sidebar-fixtures';
import { staysInWorkingView, type ChatGroupMode } from './chats/sidebar-view';
import { setSidebarView, usePublishSidebarAttention, useSidebarView } from './chats/sidebar-view-store';
import { HISTORY_ROW_TONES } from './chats/constants';
import {
  historyIsVisibleForRepos,
  historyRepoContext,
  historySection,
  isAutomationSession,
  isOwnedAutomationSession,
  packetSortTime,
  packetStateTone,
  packetTimestamp,
  pickHistoryPacket,
  sessionBelongsToRepo,
  sessionIdentity,
} from './chats/helpers';
import {
  ArchivedLaneCompactRow,
  CompactSessionRow,
  HistoryChatRow,
  MergedPacketRow,
} from './chats/HistoryRows';
import { HistoryActionMenu } from './chats/Menus';
import { SectionLabel } from './chats/shared';
import {
  attentionRank,
  deriveArchivedLanes,
  deriveHistoryDateGroups,
  deriveHistoryRepoGroups,
  derivePrioritySplit,
  deriveSweptThreads,
  isCompletionUnread,
  repoSuffix,
  SIDEBAR_HOVER_THREAD_EVENT,
} from './chats/sections';
import { useRowReadState } from './chats/use-row-read-state';
import { getLastVisited, markVisited } from './chats/read-state';
import { useSidebarManualOrder } from './chats/use-sidebar-manual-order';
import { SidebarSortableRow } from './chats/SidebarSortableRow';
import { EMPTY_CHAT_VIEW_ACTIONS, EMPTY_SIDEBAR_AGENTS, mergeSidebarAgentHistory, sidebarAgentItemId } from './chats/sidebar-agent-navigation';
import type {
  ArchivedLaneRow,
  ChatHistoryItem,
  ChatsTabProps,
  HistoryActionMenuState,
  HistoryGroupKey,
} from './chats/types';

export function ChatsTab({
  repos,
  selectedRepo,
  ideWorkspaceSessions = [],
  activeSessionKey,
  onSelectSession,
  onOpenHistoryChat,
  variant = 'tab',
  limit,
  hideWhenEmpty = false,
  sectionLabel = 'Chats',
  sections = ['chat', 'orchestrator'],
  showLiveSessions = true,
  groupMode = 'sections',
  packets = [],
  agentEntries = EMPTY_SIDEBAR_AGENTS,
  agentViewActions = EMPTY_CHAT_VIEW_ACTIONS,
  onCreateOrchestratorForRepo,
  emptyActions,
}: ChatsTabProps) {
  const [historyItems, setHistoryItems] = useState<ChatHistoryItem[]>([]);
  const [archivedHistoryItems, setArchivedHistoryItems] = useState<ChatHistoryItem[]>([]);
  const [archivedLanes, setArchivedLanes] = useState<ArchivedLaneRow[]>([]);
  const [showAllChats, setShowAllChats] = useState(false);
  const demoFixtures = useSidebarFixtures(variant === 'mini');
  const agentByTabId = useMemo(() => new Map(agentEntries.map(entry => [sidebarAgentItemId(entry), entry])), [agentEntries]);

  // Group-by mode for the left-rail chat list (mini / flat variant).
  // Keep the existing persisted grouping ids compatible with the view menu.
  const chatGroupBy = useSidebarView();
  const updateChatGroupBy = useCallback((next: ChatGroupMode) => {
    setSidebarView(next);
    setShowAllChats(false);
  }, []);
  useEffect(() => { setShowAllChats(false); }, [chatGroupBy]);
  // Per-repo drawer collapse (repo grouping only) — each repo header is a
  // minimizable drawer. Persisted as a JSON array of
  // collapsed group keys so the drawer state survives reloads.
  const REPO_COLLAPSED_KEY = 'o8:chat-repo-groups-collapsed';
  const [collapsedRepoGroups, setCollapsedRepoGroups] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(REPO_COLLAPSED_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as unknown;
      if (Array.isArray(parsed)) {
        setCollapsedRepoGroups(new Set(parsed.filter((key): key is string => typeof key === 'string')));
      }
    } catch { /* ignore */ }
  }, []);
  const toggleRepoGroup = useCallback((key: string) => {
    setCollapsedRepoGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (typeof window !== 'undefined') {
        try { window.localStorage.setItem(REPO_COLLAPSED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      }
      return next;
    });
  }, []);
  const [loading, setLoading] = useState(true);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [busyHistoryIds, setBusyHistoryIds] = useState<Set<string>>(() => new Set());
  // Rail recency = the last time the conversation SPOKE (Q ruling
  // 2026-07-16). The previous ChatGPT-style click-bump (an optimistic
  // clickedAt map that overrode modifiedAt so an opened chat popped to the
  // top) is deliberately GONE — clicking a chat must not reorder the rail;
  // only a new message does. modifiedAt itself is last-message-derived
  // server-side (chat-history/list + the mobile lister) for the same reason.
  const effectiveModifiedAtMs = useCallback((item: ChatHistoryItem) => {
    const ts = Date.parse(item.modifiedAt);
    return Number.isFinite(ts) ? ts : 0;
  }, []);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<HistoryGroupKey, boolean>>({
    chat: false,
    orchestrator: false,
    merged: false,
    archived: true,
  });
  const [historyActionMenu, setHistoryActionMenu] = useState<HistoryActionMenuState | null>(null);

  const fetchHistory = useCallback(async (cancelled?: () => boolean) => {
    setLoading(true);
    try {
      const response = await fetch('/api/v2/chat-history/list?include=orchestrator&archived=include', { cache: 'no-store' });
      if (!response.ok) throw new Error('Chat history unavailable');
      const payload = await response.json() as { conversations?: ChatHistoryItem[] };
      if (!Array.isArray(payload.conversations)) throw new Error('Chat history unavailable');
      if (cancelled?.()) return;
      const conversations = payload.conversations ?? [];
      setHistoryItems(conversations.filter((item) => !item.archivedAt));
      setArchivedHistoryItems(conversations.filter((item) => Boolean(item.archivedAt)));
      setHistoryUnavailable(false);
    } catch {
      if (cancelled?.()) return;
      setHistoryUnavailable(true);
    } finally {
      if (!cancelled?.()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchHistory(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [fetchHistory]);

  // Refetch when chat-history mutates (rename / archive / share via the
  // header title menu). Without this listener the left rail keeps the
  // pre-mutation snapshot until the next mount.
  useEffect(() => {
    const handler = () => { void fetchHistory(); };
    window.addEventListener('o8:chat-history-updated', handler as EventListener);
    return () => window.removeEventListener('o8:chat-history-updated', handler as EventListener);
  }, [fetchHistory]);

  useEffect(() => {
    const activeThreadId = (activeSessionKey ?? '').replace(/^llm-chat:/, '');
    if (!historyItems.some((item) => item.tabId === activeThreadId)) return;
    markVisited(`thread:${activeThreadId}`);
  }, [activeSessionKey, historyItems]);

  // Archived agent sessions (Codex / lanes table) — only fetched in the
  // compact left-rail variant where they render inline under each repo.
  // The project drawer's Chats tab leaves these to its Agents tab.
  useEffect(() => {
    if (variant !== 'mini') return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/lanes?active=false', { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const data = await res.json() as { lanes?: ArchivedLaneRow[] };
        const archived = (data.lanes ?? [])
          .filter((l) => l.status === 'archived')
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        if (!cancelled) setArchivedLanes(archived);
      } catch {
        // silent — best-effort
      }
    };
    void load();
    // #2154 — a lane archived from the Agents rail must land HERE right away,
    // not after a reload; otherwise clearing the rail looks like deletion.
    const onLifecycle = () => { void load(); };
    window.addEventListener('o8:lifecycle-reconcile', onLifecycle);
    return () => {
      cancelled = true;
      window.removeEventListener('o8:lifecycle-reconcile', onLifecycle);
    };
  }, [variant]);

  const withHistoryBusy = useCallback(async (tabId: string, action: () => Promise<void>) => {
    setBusyHistoryIds((prev) => new Set(prev).add(tabId));
    try {
      await action();
      await fetchHistory();
    } finally {
      setBusyHistoryIds((prev) => {
        const next = new Set(prev);
        next.delete(tabId);
        return next;
      });
    }
  }, [fetchHistory]);

  const patchHistoryItem = useCallback(async (tabId: string, patch: Record<string, unknown>) => {
    const response = await fetch('/api/v2/chat-history', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId, ...patch }),
    });
    if (!response.ok) throw new Error('Unable to update chat history');
  }, []);

  const archiveHistoryItem = useCallback((item: ChatHistoryItem) => (
    withHistoryBusy(item.tabId, () => patchHistoryItem(item.tabId, { archivedAt: new Date().toISOString() }))
  ), [patchHistoryItem, withHistoryBusy]);

  const restoreHistoryItem = useCallback((item: ChatHistoryItem) => (
    withHistoryBusy(item.tabId, () => patchHistoryItem(item.tabId, { archivedAt: null }))
  ), [patchHistoryItem, withHistoryBusy]);

  const togglePinnedHistoryItem = useCallback((item: ChatHistoryItem) => (
    withHistoryBusy(item.tabId, () => patchHistoryItem(item.tabId, { pinned: !item.pinned, starred: !item.pinned ? true : item.starred }))
  ), [patchHistoryItem, withHistoryBusy]);

  const renameHistoryItem = useCallback((item: ChatHistoryItem, title: string) => (
    withHistoryBusy(item.tabId, () => patchHistoryItem(item.tabId, { title }))
  ), [patchHistoryItem, withHistoryBusy]);

  const deleteHistoryItem = useCallback((item: ChatHistoryItem) => {
    void (async () => {
      const confirmed = await requestConfirm({
        title: `Delete "${item.title}" from chat history?`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await withHistoryBusy(item.tabId, async () => {
          const response = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(item.tabId)}`, { method: 'DELETE' });
          if (!response.ok) {
            // Parse the API error message so we can surface it to the operator
            // (file lock, permission, ENOENT race — server now logs + 500s
            // instead of silently 200-OK'ing failed unlinks).
            const payload = await response.json().catch(() => null) as { error?: string } | null;
            throw new Error(payload?.error ?? `Delete failed (${response.status})`);
          }
        });
        // Notify any open workspace tab bound to this thread so it resets to the
        // fresh new-chat state instead of showing the dead transcript — the row
        // dropped from this rail, but the center tab had no signal until now
        // (operator reports v0.1.557/560/580).
        if (typeof window !== 'undefined') {
          removeTranscriptReadingPositions(item.tabId);
          window.dispatchEvent(new CustomEvent('o8:chat-history-deleted', { detail: { tabId: item.tabId } }));
          // And clear the last-active restore keys — in any repo bucket — that
          // point at the deleted thread, so a reload can't resurrect it into a
          // workspace tab.
          clearLastOrchestratorThreadForId(item.tabId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Delete failed';
        toast(`Couldn't delete "${item.title}": ${message}. Try again — if Codex was busy on this thread the file may have been locked.`);
      }
    })();
  }, [withHistoryBusy]);

  const targetRepos = useMemo(() => (
    selectedRepo ? [selectedRepo] : repos
  ), [repos, selectedRepo]);
  const repoByGroupKey = useMemo(() => {
    const map = new Map<string, (typeof targetRepos)[number]>();
    for (const repo of targetRepos) map.set(repo.name.toLowerCase(), repo);
    return map;
  }, [targetRepos]);
  const visiblePackets = useMemo(() => (
    packets.filter((packet) => targetRepos.some((repo) => packetBelongsToRepo(packet, repo.localPath)))
  ), [packets, targetRepos]);

  const visibleHistory = useMemo(() => (
    historyItems.filter((item) => !demoFixtures.some((sample) => sample.tabId === item.tabId)
      && historyIsVisibleForRepos(item, targetRepos))
  ), [historyItems, targetRepos, demoFixtures]);
  const historyPacketsByTabId = useMemo(() => new Map(
    visibleHistory.map((item) => [item.tabId, pickHistoryPacket(item, visiblePackets)]),
  ), [visibleHistory, visiblePackets]);
  const visibleArchivedHistory = useMemo(() => (
    archivedHistoryItems.filter((item) => historyIsVisibleForRepos(item, targetRepos))
  ), [archivedHistoryItems, targetRepos]);
  const allowedSections = useMemo(() => new Set(sections), [sections]);
  const visibleFlatHistory = useMemo(() => (
    visibleHistory
      .filter((item) => allowedSections.has(historySection(item)))
      .slice()
      .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
  ), [allowedSections, visibleHistory]);
  const livePacketThreadIds = useMemo(() => new Set(visiblePackets
    .filter((packet) => packetVisualState(packet) !== 'merged' && packet.status !== 'archived')
    .map((packet) => packet.orchestratorThreadId?.trim())
    .filter((threadId): threadId is string => Boolean(threadId))), [visiblePackets]);
  const sweptThreads = useMemo(() => deriveSweptThreads(visibleFlatHistory, {
    activeSessionKey,
    liveThreadIds: livePacketThreadIds,
  }), [activeSessionKey, livePacketThreadIds, visibleFlatHistory]);
  const visibleChatHistory = useMemo(() => (
    visibleHistory.filter((item) => historySection(item) === 'chat')
  ), [visibleHistory]);
  const visibleOrchestratorHistory = useMemo(() => (
    visibleHistory.filter((item) => historySection(item) === 'orchestrator')
  ), [visibleHistory]);
  const visibleMergedPackets = useMemo(() => (
    visiblePackets
      .filter((packet) => packetVisualState(packet) === 'merged')
      .slice()
      .sort((a, b) => packetSortTime(b) - packetSortTime(a))
  ), [visiblePackets]);

  const visibleHistoryIds = useMemo(() => new Set(visibleHistory.map((item) => item.tabId)), [visibleHistory]);

  // Worker packets keyed by the orchestrator thread that spawned them
  // (packet.orchestratorThreadId === thread tabId, taught on create_mission).
  // Archived packets stay out — they live in the Archived section.
  const ownedPacketsByThread = useMemo(() => {
    const map = new Map<string, typeof visiblePackets>();
    for (const packet of visiblePackets) {
      const threadId = packet.orchestratorThreadId?.trim();
      if (!threadId || packet.status === 'archived') continue;
      const bucket = map.get(threadId);
      if (bucket) bucket.push(packet);
      else map.set(threadId, [packet]);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => packetSortTime(b) - packetSortTime(a));
    }
    return map;
  }, [visiblePackets]);

  const readStateVersion = useRowReadState();
  const packetAttention = useCallback((packet: typeof packets[number]) => ({
    status: packet.status, rejected: packet.review?.approved === false,
    outcome: packet.releaseState === 'released' ? 'merged' : null,
    unread: isCompletionUnread(packetTimestamp(packet), getLastVisited(`packet:${packet.id}`)),
  }), []);
  const historyAttentionPackets = useMemo(() => {
    void readStateVersion; // Receipt reads change priority without a server refresh.
    return new Map(visibleHistory.map((item) => {
    const candidates = [historyPacketsByTabId.get(item.tabId), ...(ownedPacketsByThread.get(item.tabId) ?? [])]
      .filter((packet): packet is typeof visiblePackets[number] => Boolean(packet));
    candidates.sort((a, b) => attentionRank(packetAttention(b)) - attentionRank(packetAttention(a))
      || Number(staysInWorkingView({ status: b.status })) - Number(staysInWorkingView({ status: a.status }))
      || packetSortTime(b) - packetSortTime(a));
    return [item.tabId, candidates[0]];
    }));
  }, [historyPacketsByTabId, ownedPacketsByThread, packetAttention, readStateVersion, visibleHistory]);

  const openHistoryItem = useCallback((item: ChatHistoryItem) => {
    markVisited(`thread:${item.tabId}`);
    const related = [historyPacketsByTabId.get(item.tabId), ...(ownedPacketsByThread.get(item.tabId) ?? [])];
    for (const packet of related) if (packet) markVisited(`packet:${packet.id}`);
    onOpenHistoryChat?.(item.tabId, item.title, historyRepoContext(item));
  }, [historyPacketsByTabId, onOpenHistoryChat, ownedPacketsByThread]);

  const visibleSessions = useMemo(() => (
    ideWorkspaceSessions
      .filter((session) => targetRepos.some((repo) => sessionBelongsToRepo(session, repo)))
      .filter((session) => !sessionIdentity(session).some((id) => visibleHistoryIds.has(id)))
      .sort((a, b) => {
        const aTime = Number(a.lastActivityAt ?? Date.parse(a.lastEventAt));
        const bTime = Number(b.lastActivityAt ?? Date.parse(b.lastEventAt));
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
      })
  ), [ideWorkspaceSessions, targetRepos, visibleHistoryIds]);

  const compact = variant === 'mini';
  const shownSessions = showLiveSessions ? visibleSessions : visibleSessions.filter(isAutomationSession);
  const displayedSessions = limit ? shownSessions.slice(0, Math.min(shownSessions.length, limit)) : shownSessions;
  const remainingHistorySlots = limit ? Math.max(0, limit - displayedSessions.length) : Number.POSITIVE_INFINITY;
  const projectedAgentHistory = useMemo(() => mergeSidebarAgentHistory(
    sweptThreads.chats, chatGroupBy === 'scheduled' ? [] : agentEntries,
  ), [agentEntries, chatGroupBy, sweptThreads.chats]);
  const dateSortedChatItems = useMemo(() => {
    return (
    projectedAgentHistory.filter(item => !item.archivedAt).filter((item) => {
      if (compact && chatGroupBy === 'scheduled') return ideWorkspaceSessions.some((session) =>
        isOwnedAutomationSession(session) && sessionIdentity(session).includes(item.tabId));
      return true;
    }).sort((a, b) => effectiveModifiedAtMs(b) - effectiveModifiedAtMs(a))
    );
  }, [chatGroupBy, compact, effectiveModifiedAtMs, ideWorkspaceSessions, projectedAgentHistory]);
  const manualOrder = useSidebarManualOrder(dateSortedChatItems);
  const sortedChatItems = chatGroupBy === 'manual' ? manualOrder.orderedItems : dateSortedChatItems;
  const workingHistoryIds = useMemo(() => {
    void readStateVersion;
    return new Set(sortedChatItems.filter(item => {
      const agent = agentByTabId.get(item.tabId);
      if (agent) return staysInWorkingView(agent.attention, agent.active);
      const selected = activeSessionKey === item.tabId || activeSessionKey === `llm-chat:${item.tabId}`;
      const related = [historyPacketsByTabId.get(item.tabId), ...(ownedPacketsByThread.get(item.tabId) ?? [])];
      return selected || related.some((packet) => packet && staysInWorkingView({
        status: packet.status, rejected: packet.review?.approved === false,
        outcome: packet.releaseState === 'released' ? 'merged' : null,
        unread: isCompletionUnread(packetTimestamp(packet), getLastVisited(`packet:${packet.id}`)),
      })) || ideWorkspaceSessions.some((session) => sessionIdentity(session).includes(item.tabId)
        && staysInWorkingView({ status: session.status }));
    }).map(item => item.tabId));
  }, [activeSessionKey, agentByTabId, historyPacketsByTabId, ideWorkspaceSessions, ownedPacketsByThread, readStateVersion, sortedChatItems]);
  const chatCap = compact && !showAllChats ? 12 : Number.POSITIVE_INFINITY;
  const historyCap = Number.isFinite(remainingHistorySlots) ? remainingHistorySlots : Number.POSITIVE_INFINITY;
  const flatHistoryItems = [...sortedChatItems.filter(item => item.pinned), ...sortedChatItems.filter(item => !item.pinned)]
    .slice(0, Math.max(0, Math.min(chatCap, historyCap)));
  const cappedChatCount = Math.min(sortedChatItems.length, historyCap);
  const flatHistoryRepoGroups = useMemo(
    () => deriveHistoryRepoGroups(flatHistoryItems, targetRepos),
    [flatHistoryItems, targetRepos],
  );
  const flatHistoryDateGroups = useMemo(
    () => deriveHistoryDateGroups(flatHistoryItems),
    [flatHistoryItems],
  );
  const flatPrioritySplit = useMemo(() => {
    void readStateVersion;
    const eligibleItems = sortedChatItems.slice(0, historyCap);
    const split = derivePrioritySplit(eligibleItems.map((item) => {
      const agent = agentByTabId.get(item.tabId);
      if (agent) return { item, modifiedAt: item.modifiedAt, ...agent.attention };
      const packet = historyAttentionPackets.get(item.tabId);
      return {
        item,
        modifiedAt: item.modifiedAt,
        status: packet?.status ?? null,
        rejected: packet?.review?.approved === false,
        outcome: packet?.releaseState === 'released' ? 'merged' : null,
        unread: packet
          ? isCompletionUnread(packetTimestamp(packet), getLastVisited(`packet:${packet.id}`))
          : false,
      };
    }));
    return {
      needsAttention: split.priority.length,
      priority: [...split.priority, ...split.remainder.filter((entry) => staysInWorkingView(entry))].map((entry) => entry.item),
      remainder: split.remainder.filter((entry) => !staysInWorkingView(entry)).map((entry) => entry.item),
    };
  }, [agentByTabId, historyAttentionPackets, historyCap, readStateVersion, sortedChatItems]);
  usePublishSidebarAttention([...historyAttentionPackets.values()].filter((packet) => packet && attentionRank(packetAttention(packet)) > 0).length
    + sortedChatItems.filter(item => { const agent = agentByTabId.get(item.tabId); return agent && attentionRank(agent.attention) > 0; }).length, compact);
  const flatRemainderItems = [...flatPrioritySplit.remainder].sort((a, b) => Number(b.pinned) - Number(a.pinned)).slice(
    0,
    compact && !showAllChats ? Math.max(0, 12 - flatPrioritySplit.priority.length) : Number.POSITIVE_INFINITY,
  );
  const shownActivityCount = flatPrioritySplit.priority.length + flatRemainderItems.length;
  const hiddenChatCount = Math.max(0, cappedChatCount - (
    chatGroupBy === 'flat' || chatGroupBy === 'working' ? shownActivityCount : flatHistoryItems.length
  ));

  const flatArchivedLanes = useMemo(
    () => deriveArchivedLanes(archivedLanes, targetRepos.map((repo) => repo.localPath))
      .filter(lane => !agentEntries.some(entry => entry.row.laneId === lane.id)),
    [agentEntries, archivedLanes, targetRepos],
  );
  const combinedArchivedHistory = useMemo(() => {
    const byId = new Map<string, ChatHistoryItem>();
    for (const item of [...visibleArchivedHistory, ...sweptThreads.swept, ...projectedAgentHistory.filter(item => item.archivedAt)]) {
      if (allowedSections.has(historySection(item))) byId.set(item.tabId, item);
    }
    return [...byId.values()].sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  }, [allowedSections, projectedAgentHistory, sweptThreads.swept, visibleArchivedHistory]);
  const historyGroups = useMemo(() => {
    const sourceGroups = [
      { key: 'orchestrator' as const, label: 'Orchestrator', items: visibleOrchestratorHistory },
      { key: 'chat' as const, label: sectionLabel ?? 'Chats', items: visibleChatHistory },
    ].filter((group) => allowedSections.has(group.key));

    if (!Number.isFinite(remainingHistorySlots)) {
      return sourceGroups.filter((group) => group.items.length > 0);
    }

    const slots = Math.max(0, remainingHistorySlots);
    if (slots === 0) return [];
    if (sourceGroups.length <= 1) {
      return sourceGroups.map((group) => ({ ...group, items: group.items.slice(0, slots) })).filter((group) => group.items.length > 0);
    }

    const groups: Array<{ key: 'chat' | 'orchestrator'; label: string; items: ChatHistoryItem[] }> = [];
    let remaining = slots;
    for (const group of sourceGroups) {
      if (remaining <= 0) break;
      const reserveForLater = sourceGroups.slice(sourceGroups.indexOf(group) + 1).some((next) => next.items.length > 0) ? 1 : 0;
      const take = Math.min(group.items.length, Math.max(0, remaining - reserveForLater));
      groups.push({ ...group, items: group.items.slice(0, take) });
      remaining -= take;
    }
    return groups.filter((group) => group.items.length > 0);
  }, [allowedSections, remainingHistorySlots, sectionLabel, visibleChatHistory, visibleOrchestratorHistory]);
  const showMergedPackets = groupMode === 'sections' && !compact && visibleMergedPackets.length > 0;
  const showArchivedHistory = chatGroupBy !== 'scheduled' && (combinedArchivedHistory.length > 0 || flatArchivedLanes.length > 0);
  const hasContent = displayedSessions.length > 0 || (
    groupMode === 'flat'
      ? flatHistoryItems.length > 0
      : historyGroups.some((group) => group.items.length > 0)
  ) || agentEntries.length > 0 || showMergedPackets || showArchivedHistory;
  const toggleGroup = (key: HistoryGroupKey) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Fleet reveal: hovering a thread that owns live packets lights those rows
  // in the Agents section (SIDEBAR_HOVER_THREAD_EVENT) immediately, and opens
  // the orchestrator hover card on dwell. The card's own hover keeps both
  // alive so the pointer can travel onto it.
  const [threadHover, setThreadHover] = useState<{ item: ChatHistoryItem; rect: DOMRect } | null>(null);
  const threadHoverOpenRef = useRef<number | null>(null);
  const threadHoverCloseRef = useRef<number | null>(null);
  const broadcastThreadLink = useCallback((packetIds: string[] | null) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(SIDEBAR_HOVER_THREAD_EVENT, { detail: { packetIds } }));
  }, []);
  const clearThreadHoverTimers = useCallback(() => {
    if (threadHoverOpenRef.current) window.clearTimeout(threadHoverOpenRef.current);
    if (threadHoverCloseRef.current) window.clearTimeout(threadHoverCloseRef.current);
    threadHoverOpenRef.current = null;
    threadHoverCloseRef.current = null;
  }, []);
  const handleThreadHover = useCallback((item: ChatHistoryItem, packetIds: string[], rect: DOMRect | null) => {
    clearThreadHoverTimers();
    if (rect) {
      broadcastThreadLink(packetIds);
      threadHoverOpenRef.current = window.setTimeout(() => setThreadHover({ item, rect }), 240);
    } else {
      broadcastThreadLink(null);
      threadHoverCloseRef.current = window.setTimeout(() => setThreadHover(null), 160);
    }
  }, [broadcastThreadLink, clearThreadHoverTimers]);
  useEffect(() => () => {
    // Never leave the Agents section stuck dimmed if this tab unmounts mid-hover.
    clearThreadHoverTimers();
    broadcastThreadLink(null);
    setThreadHover(null);
  }, [broadcastThreadLink, chatGroupBy, clearThreadHoverTimers]);

  const renderHistoryRow = (item: ChatHistoryItem, archived = false) => {
    const wrap = (node: ReactNode) => compact && !archived ? <SidebarSortableRow key={item.tabId} item={item}
      insertion={manualOrder.insertion} onMove={manualOrder.move} siblings={sortedChatItems}>{node}</SidebarSortableRow>
      : <Fragment key={item.tabId}>{node}</Fragment>;
    const agent = agentByTabId.get(item.tabId);
    if (agent) return wrap(<Fragment key={item.tabId}>{agent.render({
      roomy: compact && (chatGroupBy === 'flat' || chatGroupBy === 'working' && !item.pinned && workingHistoryIds.has(item.tabId)),
      showPreview: chatGroupBy === 'flat' || chatGroupBy === 'working' && !item.pinned && workingHistoryIds.has(item.tabId),
      repoLabel: chatGroupBy === 'repo' ? null : repoSuffix(item, targetRepos),
    })}</Fragment>);
    const owned = archived ? [] : ownedPacketsByThread.get(item.tabId) ?? [];
    const packet = historyAttentionPackets.get(item.tabId);
    return wrap(
      <HistoryChatRow
        key={item.tabId}
        item={item}
        compact={compact}
        disabled={!onOpenHistoryChat}
        active={activeSessionKey === item.tabId || activeSessionKey === `llm-chat:${item.tabId}`}
        tone={archived ? HISTORY_ROW_TONES.neutral : packetStateTone(packet)}
        repoLabel={compact && chatGroupBy === 'repo' ? null : repoSuffix(item, targetRepos)}
        ownedCount={owned.length}
        roomy={compact && (chatGroupBy === 'flat' || (chatGroupBy === 'working' && workingHistoryIds.has(item.tabId) && !item.pinned))}
        preview={compact && (chatGroupBy === 'flat' || (chatGroupBy === 'working' && workingHistoryIds.has(item.tabId) && !item.pinned)) ? item.preview : undefined}
        scheduled={ideWorkspaceSessions.some((session) => sessionIdentity(session).includes(item.tabId) && isOwnedAutomationSession(session))}
        onHoverChange={(rect) => handleThreadHover(item, owned.map((packet) => packet.id), rect)}
        onOpen={() => openHistoryItem(item)}
        onOpenMenu={(event) => setHistoryActionMenu({ item, archived, x: event.clientX, y: event.clientY })}
      />
    );
  };

  if (hideWhenEmpty && (!hasContent || loading)) return null;

  return (
    <div
      style={{
        minHeight: compact ? undefined : '100%',
        paddingTop: compact ? 0 : 4,
        paddingBottom: compact ? 8 : 14,
        fontFamily: REPO_FOCUS_FONT,
      }}
    >
      {/* Top-level live sessions block — hidden in compact (AgentPanel)
          mode because automation sessions already render under the
          Spawned agents → <repo> group below. Showing them here too
          caused a visible Daily standup duplication at the top of the
          panel. Non-compact callers (full repo focus view) still get
          the active-session header for context. */}
      {!compact ? (
        displayedSessions.map((session) => (
          <SessionRow
            key={session.sessionKey}
            session={session}
            onSelectSession={onSelectSession}
          />
        ))
      ) : null}

      {groupMode === 'flat' && (flatHistoryItems.length > 0 || compact) ? (
        <div>
          {compact ? (
            <>
              {chatGroupBy === 'working' ? <WorkingChatHistory
                items={sortedChatItems.slice(0, historyCap)} workingIds={workingHistoryIds} fixtures={demoFixtures}
                activeSessionKey={activeSessionKey} renderHistoryRow={renderHistoryRow} onOpenHistoryChat={onOpenHistoryChat}
                onChangeView={updateChatGroupBy} showAll={showAllChats} onShowMore={() => setShowAllChats(true)}
                viewActions={agentViewActions}
              /> : <CompactChatHistory
                chatGroupBy={chatGroupBy} updateChatGroupBy={updateChatGroupBy}
                priority={flatPrioritySplit.priority} remainder={flatRemainderItems}
                flatHistoryItems={flatHistoryItems} flatHistoryDateGroups={flatHistoryDateGroups}
                flatHistoryRepoGroups={flatHistoryRepoGroups} collapsedRepoGroups={collapsedRepoGroups}
                repoByGroupKey={repoByGroupKey} toggleRepoGroup={toggleRepoGroup}
                onCreateOrchestratorForRepo={onCreateOrchestratorForRepo} renderHistoryRow={renderHistoryRow}
                hiddenChatCount={hiddenChatCount} showMore={() => setShowAllChats(true)}
                fixtures={demoFixtures} activeSessionKey={activeSessionKey} onOpenHistoryChat={onOpenHistoryChat}
                viewActions={agentViewActions}
                scheduledSessions={chatGroupBy === 'scheduled' ? visibleSessions.filter(isOwnedAutomationSession).map((session) => (
                  <CompactSessionRow key={session.sessionKey} session={session} onSelectSession={onSelectSession} />
                )) : null}
              />}
            </>
          ) : (
            <>
              {sectionLabel ? (
                <SectionLabel
                  label={sectionLabel}
                  compact={compact}
                />
              ) : null}
              {flatHistoryItems.map((item) => renderHistoryRow(item))}
            </>
          )}
        </div>
      ) : null}

      {showMergedPackets ? (
        <div>
          <SectionLabel
            label="Merged"
            compact={compact}
            collapsed={collapsedGroups.merged}
            onToggle={() => toggleGroup('merged')}
          />
          {collapsedGroups.merged ? null : (
            visibleMergedPackets.slice(0, 8).map((packet) => (
              <MergedPacketRow key={packet.id} packet={packet} compact={compact} />
            ))
          )}
        </div>
      ) : null}

      {groupMode === 'sections' ? historyGroups.map((group) => (
        <div key={group.key}>
          <SectionLabel
            label={group.label}
            compact={compact}
            collapsed={collapsedGroups[group.key]}
            onToggle={() => toggleGroup(group.key)}
          />
          {collapsedGroups[group.key] ? null : (
            group.items.map((item) => renderHistoryRow(item))
          )}
        </div>
      )) : null}

      {showArchivedHistory ? (
        <div>
          <SectionLabel
            label="Archived"
            compact={compact}
            collapsed={collapsedGroups.archived}
            onToggle={() => toggleGroup('archived')}
          />
          {collapsedGroups.archived ? null : (
            <>
              {combinedArchivedHistory.slice(0, 12).map((item) => renderHistoryRow(item, Boolean(item.archivedAt)))}
              {flatArchivedLanes.map((lane) => (
                <ArchivedLaneCompactRow
                  key={lane.id}
                  lane={lane}
                  onSelectSession={onSelectSession}
                />
              ))}
            </>
          )}
        </div>
      ) : null}

      {!hasContent && !demoFixtures.length ? (
        !loading && !historyUnavailable && emptyActions ? <div style={{ paddingTop: 8, paddingBottom: 8 }}>{emptyActions}</div> :
        <div
          style={{
            paddingTop: 42,
            paddingRight: 28,
            paddingBottom: 42,
            paddingLeft: 28,
            textAlign: 'center',
            color: 'var(--t-text-faint)',
          }}
        >
          <div style={{ fontSize: 14, lineHeight: '19px', fontWeight: 500, color: 'var(--t-text-muted)' }}>
            {loading ? 'Loading project chats…' : historyUnavailable ? 'Project chats unavailable' : 'No project chats yet'}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, lineHeight: '16px' }}>
            {loading ? 'Saved conversations will appear here.' : historyUnavailable ? <button type="button" onClick={() => void fetchHistory()} style={{ border: 0, background: 'transparent', color: 'var(--t-accent)', cursor: 'pointer', font: 'inherit' }}>Try again</button> : 'New and saved chats for this project will collect here.'}
          </div>
        </div>
      ) : null}
      {historyActionMenu ? (
        <HistoryActionMenu
          state={historyActionMenu}
          busy={busyHistoryIds.has(historyActionMenu.item.tabId)}
          onClose={() => setHistoryActionMenu(null)}
          onTogglePin={() => { void togglePinnedHistoryItem(historyActionMenu.item); }}
          onArchive={() => {
            if (historyActionMenu.archived) {
              void restoreHistoryItem(historyActionMenu.item);
            } else {
              void archiveHistoryItem(historyActionMenu.item);
            }
          }}
          onDelete={() => deleteHistoryItem(historyActionMenu.item)}
          onRename={(title) => { void renameHistoryItem(historyActionMenu.item, title); }}
        />
      ) : null}
      {threadHover ? (
        <OrchestratorHoverCard
          threadId={threadHover.item.tabId}
          title={threadHover.item.title}
          repoLabel={repoSuffix(threadHover.item)}
          branchLabel={threadHover.item.repoBranch}
          workspacePath={threadHover.item.repoPath}
          updatedAt={threadHover.item.modifiedAt}
          backendLabel={threadHover.item.backend
            ? orchestratorBackendDisplayLabel({ backend: threadHover.item.backend, agent: threadHover.item.agent })
            : null}
          packets={ownedPacketsByThread.get(threadHover.item.tabId) ?? []}
          anchorRect={threadHover.rect}
          onMouseEnter={() => {
            clearThreadHoverTimers();
            broadcastThreadLink((ownedPacketsByThread.get(threadHover.item.tabId) ?? []).map((packet) => packet.id));
          }}
          onMouseLeave={() => {
            broadcastThreadLink(null);
            setThreadHover(null);
          }}
        />
      ) : null}
    </div>
  );
}
