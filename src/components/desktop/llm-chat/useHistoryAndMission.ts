import { removeTranscriptReadingPositions } from '@/components/desktop/thoughts/chat-panel/transcript-reading-position';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useRepoIssues, useRepoPullRequests } from '@/lib/github-client';

import { repoSlugFromRemoteUrl } from '../IssueLinkPicker';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { SavedChatRepoContext } from '@/lib/llm/chat-history';

import { describeRepoMission, fallbackRepoLabel, HISTORY_DELETED_EVENT, MISSION_DISMISSED_STORAGE_KEY, type HistoryConversationItem, type MissionAction, type MissionCardData, type MissionRepoSummary, type PreferredRepoContext, type QueuedContextCard } from './shared';

export function useHistoryAndMission({
  historyOpen,
  input,
  inputRef,
  isEmpty,
  onOpenHistoryChat,
  preferredRepo,
  queuedContextCards,
  sendMessage,
  tabId,
}: {
  historyOpen: boolean;
  input: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  isEmpty: boolean;
  onOpenHistoryChat?: (historyTabId: string, title: string, repo?: SavedChatRepoContext | null) => void;
  preferredRepo?: PreferredRepoContext | null;
  queuedContextCards: QueuedContextCard[];
  sendMessage: (overrideText?: string) => Promise<void>;
  tabId: string;
}) {
  const [historyItems, setHistoryItems] = useState<HistoryConversationItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [missionDismissed, setMissionDismissed] = useState(false);
  const [missionDismissalResolved, setMissionDismissalResolved] = useState(false);
  const missionContextKey = isEmpty
    ? JSON.stringify([preferredRepo?.localPath ?? '', preferredRepo?.name ?? '', preferredRepo?.remoteUrl ?? ''])
    : null;
  const [missionContext, setMissionContext] = useState<{ key: string; summary: MissionRepoSummary | null } | null>(null);
  const repoContextResolved = missionContextKey !== null && missionContext?.key === missionContextKey;
  const resolvedRepo = repoContextResolved ? missionContext.summary : null;
  const missionRepoSlug = resolvedRepo?.slug ?? null;
  const issues = useRepoIssues(missionRepoSlug);
  const prs = useRepoPullRequests(missionRepoSlug);
  const missionContextResolved = repoContextResolved && (!missionRepoSlug || (!issues.isPending && !prs.isPending));
  const missionRepoSummary = missionContextResolved && resolvedRepo ? {
    ...resolvedRepo,
    issueCount: Array.isArray(issues.data?.issues) ? issues.data.issues.length : null,
    prCount: Array.isArray(prs.data?.prs) ? prs.data.prs.length : null,
  } : null;

  const loadHistory = useCallback(async (search?: string) => {
    setHistoryLoading(true);
    try {
      const url = search ? `/api/v2/chat-history/list?q=${encodeURIComponent(search)}` : '/api/v2/chat-history/list';
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        setHistoryItems(data.conversations ?? []);
      }
    } catch {}
    setHistoryLoading(false);
  }, []);

  const toggleStar = useCallback(async (historyTabId: string, starred: boolean) => {
    try {
      await fetch('/api/v2/chat-history', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tabId: historyTabId, starred }) });
      setHistoryItems((current) => current.map((item) => item.tabId === historyTabId ? { ...item, starred } : item));
    } catch {}
  }, []);

  const deleteHistory = useCallback(async (historyTabId: string) => {
    try {
      const response = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(historyTabId)}`, { method: 'DELETE' });
      if (!response.ok) return;
      setHistoryItems((current) => current.filter((item) => item.tabId !== historyTabId));
      if (typeof window !== 'undefined') {
        removeTranscriptReadingPositions(historyTabId);
        window.dispatchEvent(new CustomEvent(HISTORY_DELETED_EVENT, { detail: { tabId: historyTabId } }));
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (historyOpen) {
      void loadHistory();
    }
  }, [historyOpen, loadHistory]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const dismissed = window.localStorage.getItem(MISSION_DISMISSED_STORAGE_KEY) === '1';
    setMissionDismissed(dismissed);
    setMissionDismissalResolved(true);
  }, []);

  useEffect(() => {
    if (missionContextKey === null) return;
    let active = true;
    void (async () => {
      const [historyResult, reposResult] = await Promise.allSettled([fetch('/api/v2/chat-history/list'), fetch('/api/panel/repos')]);
      let nextHistoryItems: HistoryConversationItem[] = [];
      if (historyResult.status === 'fulfilled' && historyResult.value.ok) {
        const historyData = await historyResult.value.json().catch(() => null) as { conversations?: HistoryConversationItem[] } | null;
        nextHistoryItems = historyData?.conversations ?? [];
      }
      let nextRepos: RepoRegistryEntry[] = [];
      if (reposResult.status === 'fulfilled' && reposResult.value.ok) {
        const reposData = await reposResult.value.json().catch(() => null) as { repos?: RepoRegistryEntry[] } | null;
        nextRepos = reposData?.repos ?? [];
      }
      if (!active) return;
      setHistoryItems(nextHistoryItems);
      const preferredSlug = repoSlugFromRemoteUrl(preferredRepo?.remoteUrl);
      const preferredPath = preferredRepo?.localPath?.trim();
      const preferredName = preferredRepo?.name?.trim();
      let nextRepoSummary: MissionRepoSummary | null = null;
      if (preferredPath || preferredName || preferredSlug) {
        nextRepoSummary = { name: preferredName || (preferredPath ? preferredPath.split('/').filter(Boolean).pop() ?? 'your codebase' : 'your codebase'), localPath: preferredPath ?? undefined, remoteUrl: preferredRepo?.remoteUrl ?? null, slug: preferredSlug, issueCount: null, prCount: null };
      } else {
        const registeredCandidate = nextRepos.find((repo) => Boolean(repoSlugFromRemoteUrl(repo.remoteUrl))) ?? nextRepos[0] ?? null;
        if (registeredCandidate) {
          nextRepoSummary = { name: registeredCandidate.name, localPath: registeredCandidate.localPath, remoteUrl: registeredCandidate.remoteUrl, slug: repoSlugFromRemoteUrl(registeredCandidate.remoteUrl), issueCount: null, prCount: null };
        }
      }
      if (!active) return;
      setMissionContext({ key: missionContextKey, summary: nextRepoSummary });
    })();
    return () => { active = false; };
  }, [missionContextKey, preferredRepo?.localPath, preferredRepo?.name, preferredRepo?.remoteUrl]);

  const groupedHistory = (() => {
    const groups = new Map<string, HistoryConversationItem[]>();
    const repoOrder = new Map<string, number>();
    for (const item of historyItems) {
      const repoLabel = item.repoName?.trim() || item.repoPath?.trim()?.split('/').filter(Boolean).pop() || 'Unscoped';
      if (!groups.has(repoLabel)) groups.set(repoLabel, []);
      groups.get(repoLabel)!.push(item);
      const currentOrder = repoOrder.get(repoLabel) ?? 0;
      const timestamp = new Date(item.modifiedAt).getTime();
      repoOrder.set(repoLabel, Math.max(currentOrder, Number.isFinite(timestamp) ? timestamp : 0));
    }
    return [...groups.entries()].sort((left, right) => {
      const preferredName = preferredRepo?.name?.trim();
      if (preferredName) {
        if (left[0] === preferredName && right[0] !== preferredName) return -1;
        if (right[0] === preferredName && left[0] !== preferredName) return 1;
      }
      return (repoOrder.get(right[0]) ?? 0) - (repoOrder.get(left[0]) ?? 0);
    }).map(([label, items]) => ({ label, items }));
  })();

  const preferredRepoSlug = repoSlugFromRemoteUrl(preferredRepo?.remoteUrl);
  const resumeMissionThread = (() => {
    const resumableItems = historyItems.filter((item) => item.tabId !== tabId && item.messageCount > 1);
    if (resumableItems.length === 0) return null;
    const preferredMatch = resumableItems.find((item) => {
      if (preferredRepo?.localPath && item.repoPath === preferredRepo.localPath) return true;
      if (preferredRepoSlug && repoSlugFromRemoteUrl(item.remoteUrl) === preferredRepoSlug) return true;
      if (preferredRepo?.name?.trim() && item.repoName?.trim() === preferredRepo.name.trim()) return true;
      return false;
    });
    return preferredMatch ?? resumableItems[0] ?? null;
  })();

  const missionCard = (() => {
    if (!missionContextResolved) return null;
    if (resumeMissionThread) {
      const historyRepo = resumeMissionThread.repoName || resumeMissionThread.repoPath ? {
        name: resumeMissionThread.repoName ?? undefined,
        localPath: resumeMissionThread.repoPath ?? undefined,
        branch: resumeMissionThread.repoBranch ?? undefined,
        remoteUrl: resumeMissionThread.remoteUrl ?? undefined,
      } satisfies SavedChatRepoContext : null;

      return { source: 'history', eyebrow: 'Saved thread', title: 'Pick up where you left off', description: resumeMissionThread.title, actions: [{ id: 'resume-thread', kind: 'history', label: 'Resume thread', prompt: `Continue this thread and help me finish it: ${resumeMissionThread.title}`, historyTabId: resumeMissionThread.tabId, historyTitle: resumeMissionThread.title, historyRepo }] } satisfies MissionCardData;
    }
    const repoLabel = missionRepoSummary?.name ?? fallbackRepoLabel(preferredRepo ?? null);
    const issueCount = missionRepoSummary?.issueCount ?? null;
    const prCount = missionRepoSummary?.prCount ?? null;
    if (missionRepoSummary && ((issueCount ?? 0) > 0 || (prCount ?? 0) > 0)) {
      const repoPromptLabel = missionRepoSummary.slug ?? repoLabel;
      const actions: MissionAction[] = [];
      if ((issueCount ?? 0) > 0) actions.push({ id: 'triage-issues', kind: 'send', label: 'Triage issues', prompt: `Triage the open GitHub issues in ${repoPromptLabel}. Identify the highest-leverage first action and explain why.` });
      if ((prCount ?? 0) > 0) actions.push({ id: 'review-prs', kind: 'send', label: 'Review PRs', prompt: `Review the open pull requests in ${repoPromptLabel}. Summarize what is pending and tell me which PR needs attention first.` });
      return { source: 'repo', eyebrow: 'Connected repo', title: 'Get to know your codebase', description: describeRepoMission(repoLabel, issueCount ?? 0, prCount ?? 0), actions } satisfies MissionCardData;
    }
    if (missionRepoSummary || preferredRepo?.localPath || preferredRepo?.name) {
      const repoPathHint = missionRepoSummary?.localPath ?? preferredRepo?.localPath?.trim();
      const repoPromptLabel = repoPathHint || missionRepoSummary?.slug || repoLabel;
      return { source: 'codebase', eyebrow: 'Connected repo', title: 'Get to know your codebase', description: `I can explain how ${repoLabel} is organized and point you to the best place to start.`, actions: [{ id: 'explain-codebase', kind: 'send', label: 'Explain codebase', prompt: `Explain the architecture of ${repoPromptLabel}. Map the main folders, key flows, and the best first change surface.` }] } satisfies MissionCardData;
    }
    return { source: 'freeform', eyebrow: 'First mission', title: 'Tell me what you are building', description: "Describe your project and I'll set up your workspace.", actions: [{ id: 'start-chatting', kind: 'focus', label: 'Start chatting' }] } satisfies MissionCardData;
  })();

  const persistMissionDismissal = useCallback(() => {
    setMissionDismissed(true);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MISSION_DISMISSED_STORAGE_KEY, '1');
    }
  }, []);

  const handleMissionAction = useCallback((action: MissionAction) => {
    persistMissionDismissal();
    if (action.kind === 'history' && action.historyTabId && action.historyTitle && onOpenHistoryChat) {
      onOpenHistoryChat(action.historyTabId, action.historyTitle, action.historyRepo ?? null);
      return;
    }
    if (action.kind === 'send' && action.prompt) {
      void sendMessage(action.prompt);
      return;
    }
    if (action.kind === 'focus') {
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (action.prompt) {
      void sendMessage(action.prompt);
    }
  }, [inputRef, onOpenHistoryChat, persistMissionDismissal, sendMessage]);

  const missionCardEligible = isEmpty && input.trim().length === 0 && queuedContextCards.length === 0;

  return {
    deleteHistory,
    groupedHistory,
    historyItems,
    historyLoading,
    historySearch,
    loadHistory,
    missionCard,
    persistMissionDismissal,
    setHistorySearch,
    shouldShowMissionCard: Boolean(missionCardEligible && missionDismissalResolved && missionContextResolved && !missionDismissed && missionCard),
    shouldShowSuggestedPrompts: Boolean(isEmpty && missionDismissalResolved && missionContextResolved && (!missionCard || missionDismissed || !missionCardEligible)),
    toggleStar,
    handleMissionAction,
  };
}
