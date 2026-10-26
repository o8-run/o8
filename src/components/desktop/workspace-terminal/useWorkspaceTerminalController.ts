'use client';

import { reorderTabs } from '@/lib/workspace-terminal/reorder-tabs';
import { retargetWorkspaceTab } from './retarget-workspace-tab';
import { useTextChatTabs } from './use-text-chat-tabs';
import { useWorkspaceThreadBindings } from './useWorkspaceThreadBindings';
import { useWorkspaceInspectorTabs } from './useWorkspaceInspectorTabs';

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ForwardedRef, type MouseEvent as ReactMouseEvent } from 'react';
import {
  buildRepoStateScope,
  loadTabState,
  saveTabState,
  scrubLocalStorageTabZombies,
  type PersistedTabState,
} from '@/lib/terminal/tab-state';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { ChatModelId } from '@/components/desktop/orchestrator/chat-models';
import { useExperimentalChatFlag } from '@/lib/operator/use-experimental-chat';
import { useExperimentalCanvasFlag } from '@/lib/operator/use-experimental-canvas';
import { orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import type { OrchestrationMode, OrchestratorRuntime } from '@/lib/orchestrator/types';
import { ORCHESTRATED_TAB_AUTO_ARCHIVE_MS } from '@/components/desktop/workspace-terminal/constants';
import type {
  LocalhostPreview,
  RegisteredRepo,
  TerminalTab,
  TerminalTabHandle,
  WorkspaceChatRuntime,
  WorkspaceTerminalProps,
} from '@/components/desktop/workspace-terminal/types';
import {
  buildWorkspaceLaneState,
  createWorkspaceTabId,
  deriveNewOrchestratorRepo,
  generateLlmChatTabId,
  isReusableBlankOrchestratorTab,
} from '@/components/desktop/workspace-terminal/utils';
import type { XtermPanelHandle } from '@/components/desktop/workspace-terminal/XtermPanel';
import { buildTerminalTabHandle, snapshotTerminalExit } from '@/components/desktop/workspace-terminal/terminal-imperative-handle';
import { createTerminalActivityTracker } from '@/components/desktop/workspace-terminal/terminal-activity';
import { readLastOrchestratorThreadTitle } from '@/components/desktop/workspace-terminal/orchestrator-thread-restore';
import { scrubOrphanSessionTileKeys } from '@/components/desktop/workspace-terminal/use-session-tiles';
import { attachRestoredTerminalSessions, applyCreatedTerminalSession, canPreserveScopedTabs, computeRestoredTabs, loadInitialTabState, mergeUserSpawnedTabs, reconcileValidatedTabs, resetControllerRefs, shouldSkipRestoreKeyChange } from '@/components/desktop/workspace-terminal/terminal-restore';
import {
  buildChatSessionSnapshots,
  buildCommitCanvasTab,
  computeChatSessionSignature,
  computeCliChatSession,
  computeLlmChatSession,
  buildLlmInjection,
  resolveActiveChatSessionKey,
} from '@/components/desktop/workspace-terminal/terminal-session-ops';
import {
  buildHistoryChatTab,
  buildNewChatTab,
  buildPersistedState,
  computeCheckpointRestore,
  deferRemoteTerminalLaunch,
  flushQueuedRemoteLaunches,
  isAutoArchiveEligible,
  resolveRunCommandTarget,
  observeXtermHelperNames,
  shellQuote,
  startPreviewDrag,
  computeSaveCheckpoint,
  computeUpdatedChatMessages,
  computeUpdatedChatSessionKey,
} from '@/components/desktop/workspace-terminal/terminal-tab-handlers';
import { useWorkspaceTabCleanup } from '@/components/desktop/workspace-terminal/useWorkspaceTabCleanup';
import { useTerminalTabLaunchers } from '@/components/desktop/workspace-terminal/use-terminal-tab-launchers';
import { usePendingCliCommands } from '@/components/desktop/workspace-terminal/use-pending-cli-commands';
import type { WorkspaceAttachedTerminalSession } from '@/components/desktop/workspace-terminal/terminal-mode';
import { useWorkspaceTabLabelUpdater } from '@/components/desktop/workspace-terminal/use-workspace-tab-label-updater';
import { logTerminalBench } from './terminal-bench-instrumentation';
import { recordSpawnEvent, registerIntrospectionContributor } from '@/lib/feedback/workspace-introspect';

type ControllerProps = WorkspaceTerminalProps;

type TerminalBenchTabsState = {
  pendingSessions?: { size: number; ids: string[] };
};

type TerminalRequestCaller =
  | 'restore-optimistic-dead'
  | 'restore-validated-dead'
  | 'default-shell'
  | 'ws-bootstrap'
  | 'fallback-shell'
  | 'new-tab'
  | 'run-command';

function ownerTabIdFromRequest(requestId: string | undefined): string | null {
  if (!requestId) return null;
  return /^workspace-(.+)-\d+$/.exec(requestId)?.[1] ?? null;
}

function exposeTerminalBenchPendingSessions(pendingSessions: ReadonlySet<string>): void {
  if (typeof window === 'undefined' || window.__o8TerminalBenchEnabled !== true) return;
  const benchWindow = window as Window & { __o8TerminalBenchTabs?: TerminalBenchTabsState | null };
  if (!benchWindow.__o8TerminalBenchTabs) return;
  benchWindow.__o8TerminalBenchTabs.pendingSessions = {
    size: pendingSessions.size,
    ids: Array.from(pendingSessions),
  };
}

export function useWorkspaceTerminalController(
  {
    stateScope,
    defaultTab,
    autoCreateDefaultTab = true,
    preferredRepo = null,
    selectedRepo = null,
    splitCreated = false,
    onActiveChatSessionChange,
    onActiveTabKindChange,
    onChatSessionsChange,
    onActiveLaneChange,
    onRepoScopeChange,
    onActiveRepoContextChange,
    onOpenRepoDiff,
    onPreviewDetected,
    sendTerminalCreate,
    sendTerminalAttach,
    sendTerminalDetach,
    sendTerminalInput,
    termWsConnected,
  }: ControllerProps,
  ref: ForwardedRef<TerminalTabHandle>,
) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [previews, setPreviews] = useState<LocalhostPreview[]>([]);
  const [restoreCompletedKey, setRestoreCompletedKey] = useState<string | null>(null);
  const [previewHeight, setPreviewHeight] = useState(0.55);
  const [isDragging, setIsDragging] = useState(false);
  const [launchRequestKey, setLaunchRequestKey] = useState(0);

  const containerDivRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<TerminalTab[]>([]);
  const panelRefs = useRef<Map<string, XtermPanelHandle>>(new Map());
  const pendingCliCommands = useRef<Map<string, string>>(new Map());
  const queuedRemoteLaunchesRef = useRef<Map<string, string>>(new Map());
  const pendingRequestRef = useRef<Map<string, string>>(new Map());
  const pendingSessionsRef = useRef<Set<string>>(new Set());
  const terminalAckRevisionsRef = useRef(new Map<string, number>());
  const restoredRef = useRef(false);
  const restoreSettledRef = useRef(false);
  const restoreInFlightRef = useRef(false);
  const restoreGenerationRef = useRef(0);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detectedPortsRef = useRef<Set<number>>(new Set());
  const urlDetectionEnabledRef = useRef(false);
  const termWsConnectedRef = useRef(termWsConnected);
  const initialTerminalBootstrapRef = useRef(false);
  const restoreKeyRef = useRef<string | null>(null);
  const preferredRepoRef = useRef(preferredRepo);
  const selectedRepoRef = useRef(selectedRepo);
  const reportedRepoScopeRef = useRef<string | null | undefined>(undefined);
  const chatSessionsChangeRef = useRef(onChatSessionsChange);
  const activeChatSessionChangeRef = useRef(onActiveChatSessionChange);
  const reportedChatSessionsSignatureRef = useRef('');
  const reportedActiveChatSessionKeyRef = useRef<string | null>(null);
  const terminalActivity = useMemo(() => createTerminalActivityTracker({ getTabs: () => tabsRef.current, setTabs }), []);
  useEffect(() => () => terminalActivity.dispose(), [terminalActivity]);
  const landTerminalTabs = useCallback((site: string, nextTabs: TerminalTab[]) => {
    if (window.__o8TerminalBenchEnabled === true) {
      const previousById = new Map(tabsRef.current.map((tab) => [tab.id, tab]));
      const changed = nextTabs.flatMap((tab) => {
        if (tab.kind !== 'terminal') return [];
        const from = previousById.get(tab.id)?.tmuxSession ?? null;
        const to = tab.tmuxSession;
        return from === to ? [] : [{ tabId: tab.id, from, to }];
      });
      if (changed.length > 0) logTerminalBench('tabs-landed', { site, changed });
    }
    tabsRef.current = nextTabs;
  }, []);
  const getTabInventory = useCallback(() => tabsRef.current.map(tab => tab.id), []);
  // A monotonic user-navigation version prevents a late restore from
  // replacing a newer tab selection.
  const userNavVersionRef = useRef(0);
  const setActiveTabIdFromUser = useCallback((next: string) => {
    userNavVersionRef.current += 1;
    setActiveTabId(next);
  }, []);
  const setActiveTabIdFromRestore = useCallback((next: string, capturedVersion: number) => {
    if (capturedVersion !== userNavVersionRef.current) {
      // Newer user nav landed during the restore await — drop this stale
      // restore action so the user's tab stays put.
      return false;
    }
    setActiveTabId(next);
    return true;
  }, []);

  useEffect(() => {
    preferredRepoRef.current = preferredRepo;
  }, [preferredRepo]);

  useEffect(() => {
    selectedRepoRef.current = selectedRepo;
  }, [selectedRepo]);

  const stableRepoScope = !splitCreated && preferredRepo?.localPath
    ? buildRepoStateScope(preferredRepo.localPath)
    : null;
  const restoreKey = useMemo(
    () => [
      stateScope,
      defaultTab,
      splitCreated ? 'split' : 'shared',
      preferredRepo?.localPath ?? 'no-repo',
    ].join('::'),
    [defaultTab, preferredRepo?.localPath, splitCreated, stateScope],
  );
  const primaryRestoreSettled = restoreCompletedKey === restoreKey;
  // Alpha: the casual llm-chat ("o8 Default") tab is hidden behind
  // experimentalChat. Filter it out of the rendered set when off — existing
  // tabs disappear from the bar (effectiveActiveTabId falls back to another
  // visible tab) and the composer unmounts, so the orchestrator is the only
  // conversational surface. The tab data stays persisted for when it flips on.
  const experimentalChat = useExperimentalChatFlag();
  // Same alpha pattern for the fleet-canvas tab — hidden (data preserved)
  // unless experimentalCanvas is on.
  const experimentalCanvas = useExperimentalCanvasFlag();
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => {
      if (tab.kind === 'canvas' && tab.canvasTab?.kind === 'ci') return false;
      if (!experimentalChat && tab.kind === 'llm-chat') return false;
      if (!experimentalCanvas && tab.kind === 'fleet-canvas') return false;
      return true;
    }),
    [tabs, experimentalChat, experimentalCanvas],
  );
  const effectiveActiveTabId = useMemo(
    () => visibleTabs.some((tab) => tab.id === activeTabId)
      ? activeTabId
      : (visibleTabs[visibleTabs.length - 1]?.id ?? ''),
    [activeTabId, visibleTabs],
  );
  const activeTab = useMemo(
    () => visibleTabs.find((tab) => tab.id === effectiveActiveTabId) ?? null,
    [effectiveActiveTabId, visibleTabs],
  );

  // Report-time forensics (GQXEZD): this controller's tab truth — per
  // workspace instance — so a "New session did nothing" report shows whether
  // the tab was ever appended, where it went, and what the restore did.
  const introspectRef = useRef({ tabs, activeTabId, effectiveActiveTabId, restoreCompletedKey, stateScope });
  introspectRef.current = { tabs, activeTabId, effectiveActiveTabId, restoreCompletedKey, stateScope };
  useEffect(() => {
    const instance = `tabs:${Math.random().toString(36).slice(2, 8)}`;
    return registerIntrospectionContributor(instance, () => {
      const s = introspectRef.current;
      return {
        stateScope: s.stateScope,
        restoreCompletedKey: s.restoreCompletedKey,
        activeTabId: s.activeTabId,
        effectiveActiveTabId: s.effectiveActiveTabId,
        tabs: s.tabs.map((tab) => ({
          id: tab.id,
          kind: tab.kind,
          fresh: tab.freshSpawn === true || undefined,
          thread: tab.orchestratorThreadId ? true : undefined,
          repo: tab.repo?.name,
        })),
      };
    });
    // stateScope changes are visible through the ref; registration is per-mount.
  }, []);
  // Mirror the focused tab id into a ref so the (event-driven) orchestrator
  // spawn callbacks can read the CURRENT focus at click time without taking
  // effectiveActiveTabId as a dep (which would churn the imperative handle on
  // every tab switch). Backs the new-orchestrator repo resolver.
  const effectiveActiveTabIdRef = useRef(effectiveActiveTabId);
  useEffect(() => {
    effectiveActiveTabIdRef.current = effectiveActiveTabId;
  }, [effectiveActiveTabId]);
  const activeCheckpoint = activeTab?.kind === 'chat' ? activeTab.chatCheckpoints?.[0] : null;
  const activeRepo = activeTab?.repo ?? visibleTabs.find((tab) => tab.repo)?.repo ?? preferredRepo ?? null;
  const activeLaneState = useMemo(
    () => buildWorkspaceLaneState(stateScope, activeTab, preferredRepo ?? null),
    [activeTab, preferredRepo, stateScope],
  );
  const activeRepoContext = useMemo<RegisteredRepo | null>(() => {
    if (!activeRepo) return null;
    return {
      ...activeRepo,
      branch: activeRepo.branch ?? preferredRepo?.branch ?? null,
      readiness: activeRepo.readiness ?? preferredRepo?.readiness ?? null,
      remoteUrl: activeRepo.remoteUrl ?? preferredRepo?.remoteUrl,
    };
  }, [activeRepo, preferredRepo]);

  const resolvePersistenceScope = useCallback((currentTabs: TerminalTab[]) => {
    const preferredRepoPath = preferredRepoRef.current?.localPath ?? null;
    if (
      stableRepoScope
      && preferredRepoPath
      && currentTabs.every((tab) => !tab.repo?.localPath || tab.repo.localPath === preferredRepoPath)
    ) {
      return stableRepoScope;
    }
    return stateScope;
  }, [stableRepoScope, stateScope]);

  useEffect(() => {
    chatSessionsChangeRef.current = onChatSessionsChange;
    activeChatSessionChangeRef.current = onActiveChatSessionChange;
  }, [onActiveChatSessionChange, onChatSessionsChange]);

  const reportedActiveTabKindRef = useRef<string>('');
  useEffect(() => {
    if (!onActiveTabKindChange) return;
    const kind = activeTab?.kind ?? null;
    const signature = `${kind ?? 'null'}::${effectiveActiveTabId}`;
    if (reportedActiveTabKindRef.current === signature) return;
    reportedActiveTabKindRef.current = signature;
    onActiveTabKindChange(kind, effectiveActiveTabId);
  }, [activeTab, effectiveActiveTabId, onActiveTabKindChange]);

  useEffect(() => {
    termWsConnectedRef.current = termWsConnected;
  }, [termWsConnected]);

  useEffect(() => {
    const previousKey = restoreKeyRef.current;
    if (previousKey === restoreKey) return;
    restoreKeyRef.current = restoreKey;

    if (shouldSkipRestoreKeyChange(previousKey, restoreKey, restoreInFlightRef.current, tabsRef.current.length)) {
      return;
    }

    const shouldPreserve = canPreserveScopedTabs(tabsRef.current, preferredRepo?.localPath ?? null, previousKey?.endsWith('::no-repo') === true);
    resetControllerRefs({
      restoredRef, restoreSettledRef, initialTerminalBootstrapRef,
      reportedRepoScopeRef, reportedChatSessionsSignatureRef, reportedActiveChatSessionKeyRef,
      detectedPortsRef, pendingCliCommands, pendingRequestRef, pendingSessionsRef, saveTimerRef,
    });
    exposeTerminalBenchPendingSessions(pendingSessionsRef.current);
    if (shouldPreserve) {
      restoredRef.current = true;
      restoreSettledRef.current = true;
      const frame = window.requestAnimationFrame(() => {
        setRestoreCompletedKey(restoreKey);
      });
      return () => window.cancelAnimationFrame(frame);
    }
    terminalActivity.reset();
    urlDetectionEnabledRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      setPreviews([]);
      tabsRef.current = [];
      setTabs([]);
      setActiveTabId('');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [preferredRepo?.localPath, restoreKey, terminalActivity]);

  useEffect(() => {
    const nextSessions = buildChatSessionSnapshots(
      visibleTabs, effectiveActiveTabId,
      preferredRepo?.localPath ?? '', preferredRepo?.branch ?? 'main',
      stableRepoScope, stateScope,
    );
    const signature = computeChatSessionSignature(nextSessions);
    if (reportedChatSessionsSignatureRef.current !== signature) {
      reportedChatSessionsSignatureRef.current = signature;
      chatSessionsChangeRef.current?.(nextSessions);
    }
    const nextActiveKey = resolveActiveChatSessionKey(nextSessions, reportedActiveChatSessionKeyRef.current);
    if (reportedActiveChatSessionKeyRef.current !== nextActiveKey) {
      reportedActiveChatSessionKeyRef.current = nextActiveKey;
      activeChatSessionChangeRef.current?.(nextActiveKey);
    }
  }, [effectiveActiveTabId, preferredRepo?.branch, preferredRepo?.localPath, stableRepoScope, stateScope, visibleTabs]);

  const persistTabsNow = useCallback((currentTabs: TerminalTab[], currentActiveId: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    logTerminalBench('persist-tabs', {
      nullTerminalTabIds: currentTabs
        .filter((tab) => tab.kind === 'terminal' && tab.tmuxSession === null)
        .map((tab) => tab.id),
    });
    const tabsWithActivity = terminalActivity.merge(currentTabs);
    const persisted = buildPersistedState(tabsWithActivity, currentActiveId);
    const persistenceScope = resolvePersistenceScope(tabsWithActivity);
    void saveTabState(persisted, persistenceScope);
    if (persistenceScope !== stateScope) {
      if (stateScope === 'tile-root') {
        void saveTabState(persisted, stateScope);
      } else {
        void saveTabState({ version: 1, activeTabId: '', tabs: [], savedAt: persisted.savedAt }, stateScope);
      }
    }
  }, [resolvePersistenceScope, stateScope, terminalActivity]);

  const persistTabs = useCallback((currentTabs: TerminalTab[], currentActiveId: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      persistTabsNow(currentTabs, currentActiveId);
    }, 500);
  }, [persistTabsNow]);

  const requestTerminalForTab = useCallback((tabId: string, command: string | undefined, caller: TerminalRequestCaller) => {
    if (deferRemoteTerminalLaunch(tabsRef.current, queuedRemoteLaunchesRef.current, tabId, command, termWsConnectedRef.current)) return;
    const requestId = `workspace-${tabId}-${Date.now()}`;
    logTerminalBench('terminal-create-requested', {
      tabId,
      requestId,
      wsConnected: termWsConnectedRef.current,
      caller,
    });
    pendingRequestRef.current.set(requestId, tabId);
    pendingSessionsRef.current.add(tabId);
    exposeTerminalBenchPendingSessions(pendingSessionsRef.current);
    if (command) {
      pendingCliCommands.current.set(tabId, command);
    }
    sendTerminalCreate(120, 30, requestId, undefined, `workspace:${tabId}`, Boolean(tabsRef.current.find((tab) => tab.id === tabId)?.remoteMachine));
  }, [sendTerminalCreate]);

  useEffect(() => {
    landTerminalTabs('react-state-sync', tabs);
    if (restoreSettledRef.current) {
      persistTabs(tabs, effectiveActiveTabId);
    }
    // `restoreCompletedKey` is a dep so this re-arms at every settle point
    // (#1234): a tab op that lands while the gate is closed — or whose
    // debounced save gets cleared by resetControllerRefs during a restore-key
    // change — would otherwise never be re-persisted until the NEXT tab op.
    // Every settle path calls setRestoreCompletedKey, so the gate opening
    // flushes the accumulated state exactly once.
  }, [effectiveActiveTabId, landTerminalTabs, persistTabs, restoreCompletedKey, tabs]);

  const handleCloseTabRef = useRef<(tabId: string) => void>(() => undefined);
  useWorkspaceThreadBindings({ tabsRef, activeTabIdRef: effectiveActiveTabIdRef,
    closeTabRef: handleCloseTabRef, setTabs, persistTabsNow });

  // Both Project pickers re-bind their owning tab, including a background tab
  // in another workspace tile. The tab's repo is the split-worker claim and
  // persisted restore scope, so never infer ownership from global focus.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ tabId?: string; repoPath?: string; repoName?: string | null }>).detail;
      const tabId = detail?.tabId;
      const repoPath = detail?.repoPath;
      if (!tabId || !repoPath) return;
      setTabs((previous) => {
        const next = retargetWorkspaceTab(previous, tabId, repoPath, detail?.repoName);
        tabsRef.current = next;
        return next;
      });
    };
    window.addEventListener('o8:select-workspace-scope', handler as EventListener);
    return () => window.removeEventListener('o8:select-workspace-scope', handler as EventListener);
  }, []);

  // One-time scrub of orphaned `…:session-tiles:tab:*` localStorage keys left
  // behind by closed tabs (they were never cleaned on close pre-fix). Runs once
  // after restore populates `tabs`, keying off the live tab ids so legit
  // layouts are preserved. Going forward, handleCloseTab clears keys on close.
  const orphanScrubDoneRef = useRef(false);
  // Keyed on restoreCompletedKey (not just tabs): that state flips exactly once
  // when restore finishes, in the same render that populates `tabs`. Gating on
  // `tabs` alone was racy — if restoreSettledRef flipped true AFTER the last
  // tabs change, the effect never re-ran and orphans survived that load.
  useEffect(() => {
    if (orphanScrubDoneRef.current) return;
    if (!restoreSettledRef.current) return;
    if (tabs.length === 0) return;
    orphanScrubDoneRef.current = true;
    const removed = scrubOrphanSessionTileKeys(new Set(tabs.map((t) => t.id)));
    if (removed > 0) console.log(`[session-tiles] scrubbed ${removed} orphaned tab layout key(s)`);
  }, [tabs, restoreCompletedKey]);

  const createDefaultShellTab = useCallback((): TerminalTab => ({
    id: createWorkspaceTabId('terminal'), label: 'Shell', kind: 'terminal',
    tmuxSession: null, cliAgent: 'shell', createdAt: Date.now(), lastActivity: Date.now(),
  }), []);

  const createDefaultChatTab = useCallback((): TerminalTab => ({
    id: generateLlmChatTabId(), label: 'Chat', kind: 'llm-chat',
    tmuxSession: null, repo: preferredRepoRef.current ?? undefined,
    linkedIssue: null, createdAt: Date.now(), lastActivity: Date.now(),
    chatModelId: 'o8-default',
  }), []);

  const createDefaultOrchestratorTab = useCallback((options?: { fresh?: boolean; repoOverride?: RegisteredRepo | null }): TerminalTab => {
    // For the boot-restore path: pre-set tab.label from the saved last-
    // active orchestrator title when one exists in localStorage. Without
    // this the header reads "Orchestrator" for 1-2s on cold reload before
    // the title-sync effect fetches chat-history and dispatches the
    // rename event.
    // For "+ New session" spawns (fresh=true): skip the restore so the
    // operator gets a true blank tab labeled "Orchestrator" — clicking
    // New session twice shouldn't duplicate the previous thread's name.
    const fresh = options?.fresh ?? false;
    // Fix 1: a caller can override the repo (focused-lane binding for new
    // spawns); otherwise fall back to the global preferredRepo as before.
    const repo = options?.repoOverride ?? preferredRepoRef.current ?? undefined;
    const savedTitle = fresh ? null : readLastOrchestratorThreadTitle(repo?.localPath ?? null);
    return {
      id: createWorkspaceTabId('orchestrator'),
      label: savedTitle ?? 'Orchestrator',
      kind: 'orchestrator',
      tmuxSession: null,
      repo,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      mode: 'fleet',
      ...(fresh ? { freshSpawn: true } : {}),
    };
  }, []);

  const createDefaultChatTabSet = useCallback((): TerminalTab[] => {
    // Alpha: don't spawn the casual llm-chat tab by default — orchestrator only,
    // unless experimentalChat is on. (visibleTabs also hides any pre-existing
    // llm-chat tab, so this is belt-and-suspenders + avoids a wasted spawn.)
    if (!experimentalChat) return [createDefaultOrchestratorTab()];
    return [createDefaultOrchestratorTab(), createDefaultChatTab()];
  }, [createDefaultChatTab, createDefaultOrchestratorTab, experimentalChat]);
  const createInitialChatTabs = useCallback((): TerminalTab[] => defaultTab === 'orchestrator'
    ? [createDefaultOrchestratorTab({ fresh: true, repoOverride: selectedRepoRef.current })] : splitCreated ? [experimentalChat ? createDefaultChatTab() : createDefaultOrchestratorTab({ fresh: true })]
    : createDefaultChatTabSet(), [createDefaultChatTab, createDefaultChatTabSet, createDefaultOrchestratorTab, defaultTab, experimentalChat, splitCreated]);

  const spawnSingleRuntimeTab = useCallback((runtime: OrchestratorRuntime): string => {
    const newTab: TerminalTab = {
      id: createWorkspaceTabId('orchestrator'),
      label: orchestratorRuntimeTone(runtime).label,
      kind: 'orchestrator',
      tmuxSession: null,
      repo: deriveNewOrchestratorRepo(tabsRef.current, effectiveActiveTabIdRef.current, selectedRepoRef.current, preferredRepoRef.current) ?? undefined,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      mode: 'single',
      singleRuntime: runtime,
    };
    const nextTabs = [...tabsRef.current, newTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabIdFromUser(newTab.id);
    return newTab.id;
  }, [setActiveTabIdFromUser]);

  const spawnChatTab = useCallback((): string => {
    const newTab = createDefaultChatTab();
    const nextTabs = [...tabsRef.current, newTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabIdFromUser(newTab.id);
    return newTab.id;
  }, [createDefaultChatTab, setActiveTabIdFromUser]);
  const spawnOrchestratorTab = useCallback((repoOverride?: RegisteredRepo | null, forceFresh = false, outsideWorkerHost = false): string => {
    // "+ New session → Orchestrator" — before minting yet another empty
    // Orchestrator tab, look for one the operator already has open with
    // no attached thread, no packet, and no draft. Focus it instead.
    // Mirrors the chat-side `isEmptyLlmChatTab` reuse in computeLlmChatSession.
    const emptyExisting = forceFresh ? undefined : tabsRef.current.find(isReusableBlankOrchestratorTab);
    if (emptyExisting) {
      // Reused blank tabs resolve the same repo as a fresh spawn, so they
      // cannot retain a stale project after the sidebar selection changes.
      const targetRepo = repoOverride
        ?? deriveNewOrchestratorRepo(tabsRef.current, effectiveActiveTabIdRef.current, selectedRepoRef.current, preferredRepoRef.current);
      if (targetRepo && emptyExisting.repo?.localPath !== targetRepo.localPath) {
        const nextTabs = tabsRef.current.map((tab) => (
          tab.id === emptyExisting.id ? { ...tab, repo: targetRepo } : tab
        ));
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
      }
      setActiveTabIdFromUser(emptyExisting.id);
      recordSpawnEvent(`orchestrator:reused tab=${emptyExisting.id} scope=${stateScope} tabs=${tabsRef.current.length}`);
      return emptyExisting.id;
    }
    // User-initiated spawn via + New session — pass fresh=true so the
    // tab gets a clean 'Orchestrator' label and skips the boot-time
    // last-thread restore (see createDefaultOrchestratorTab comments).
    // Explicit repo headers win; otherwise use sidebar selection, focused
    // lane, then the tile's repo scope.
    const newTab = createDefaultOrchestratorTab({
      fresh: true,
      repoOverride: repoOverride ?? deriveNewOrchestratorRepo(tabsRef.current, effectiveActiveTabIdRef.current, selectedRepoRef.current, preferredRepoRef.current),
    });
    if (outsideWorkerHost) newTab.outsideWorkerHost = true;
    const nextTabs = [...tabsRef.current, newTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabIdFromUser(newTab.id);
    recordSpawnEvent(`orchestrator:fresh tab=${newTab.id} scope=${stateScope} tabs=${nextTabs.length}`);
    return newTab.id;
  }, [createDefaultOrchestratorTab, setActiveTabIdFromUser, stateScope]);

  const spawnFleetCanvasTab = useCallback((): string => {
    // One fleet canvas per workspace is enough — focus the existing tab
    // instead of minting duplicates (the fleet data is identical anyway).
    const existing = tabsRef.current.find((tab) => tab.kind === 'fleet-canvas');
    if (existing) {
      setActiveTabIdFromUser(existing.id);
      return existing.id;
    }
    const newTab: TerminalTab = {
      id: createWorkspaceTabId('fleet-canvas'),
      label: 'Canvas',
      kind: 'fleet-canvas',
      tmuxSession: null,
      repo: preferredRepoRef.current ?? undefined,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    const nextTabs = [...tabsRef.current, newTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabIdFromUser(newTab.id);
    return newTab.id;
  }, [setActiveTabIdFromUser]);

  const handleUpdateTabMode = useCallback((
    tabId: string,
    patch: {
      mode?: OrchestrationMode;
      singleRuntime?: OrchestratorRuntime;
      chatModelId?: ChatModelId;
      chatOpenrouterModel?: string | null;
      worktreeMode?: 'local' | 'new-worktree';
      worktreePath?: string;
    },
  ) => {
    setTabs((previous) => previous.map((tab) => {
      if (tab.id !== tabId) return tab;
      const next: typeof tab = { ...tab, lastActivity: Date.now() };
      if (patch.mode !== undefined) next.mode = patch.mode;
      if (patch.singleRuntime !== undefined) next.singleRuntime = patch.singleRuntime;
      if (patch.chatModelId !== undefined) next.chatModelId = patch.chatModelId;
      if (patch.chatOpenrouterModel !== undefined) {
        // null clears the override; string sets it.
        next.chatOpenrouterModel = patch.chatOpenrouterModel ?? undefined;
      }
      if (patch.worktreeMode !== undefined) next.worktreeMode = patch.worktreeMode;
      if (patch.worktreePath !== undefined) next.worktreePath = patch.worktreePath;
      return next;
    }));
  }, []);

  const applyPersistedState = useCallback(async (saved: PersistedTabState, cancelled?: () => boolean) => {
    // Capture the user-nav version at the start of restore. If the user
    // clicks a different tab while computeRestoredTabs is awaiting, the
    // captured version goes stale and we drop the activeTabId update.
    const capturedNavVersion = userNavVersionRef.current;
    // Capture the pre-restore tab ids too: any tab the user spawns while the
    // compute awaits (GQXEZD — "New session" during a slow Rosetta restore)
    // must survive the landing. Replace-not-merge silently ate it.
    const preRestoreTabIds = new Set(tabsRef.current.map((tab) => tab.id));
    const preRestoreAckRevisions = new Map(terminalAckRevisionsRef.current);
    const restoreGeneration = ++restoreGenerationRef.current;
    const result = await computeRestoredTabs(saved, {
      preferredRepo: preferredRepoRef.current,
      defaultTab,
      createDefaultChatTab: defaultTab === 'orchestrator' ? () => createInitialChatTabs()[0] : createDefaultChatTab,
    }, cancelled, 'optimistic');
    if (!result) return false;

    const mergedTabs = mergeUserSpawnedTabs(result.tabs, tabsRef.current, preRestoreTabIds);
    landTerminalTabs('restore-optimistic', mergedTabs);
    setTabs(mergedTabs);
    // Self-guarding: a user spawn during restore bumped the nav version, so
    // the restored active id is dropped and the user's tab keeps focus.
    setActiveTabIdFromRestore(result.activeTabId, capturedNavVersion);
    if (cancelled?.()) return false;

    if (termWsConnectedRef.current) {
      initialTerminalBootstrapRef.current = true;
      attachRestoredTerminalSessions(result.sessionsToAttach, mergedTabs, sendTerminalAttach);
      for (const deadTab of result.deadTerminalTabs) {
        if (cancelled?.()) return false;
        const restoreCommand = deadTab.repo?.localPath ? `cd ${shellQuote(deadTab.repo.localPath)}` : undefined;
        requestTerminalForTab(deadTab.id, restoreCommand, 'restore-optimistic-dead');
      }
    } else {
      initialTerminalBootstrapRef.current = false;
    }

    // Paint the sanitized saved workspace first. The existing liveness,
    // archived-thread, and lane checks still decide the final state, but they
    // now reconcile in the background instead of holding crash recovery blank.
    void computeRestoredTabs(saved, {
      preferredRepo: preferredRepoRef.current,
      defaultTab,
      createDefaultChatTab: defaultTab === 'orchestrator' ? () => createInitialChatTabs()[0] : createDefaultChatTab,
    }, () => cancelled?.() || restoreGeneration !== restoreGenerationRef.current, 'validated').then((validated) => {
      if (!validated || cancelled?.() || restoreGeneration !== restoreGenerationRef.current) return;
      const acknowledgedDuringRestore = new Set([...terminalAckRevisionsRef.current]
        .filter(([tabId, revision]) => revision !== preRestoreAckRevisions.get(tabId))
        .map(([tabId]) => tabId));
      const currentById = new Map(tabsRef.current.map((tab) => [tab.id, tab]));
      for (const validatedTab of validated.tabs) {
        const currentTab = currentById.get(validatedTab.id);
        if (validatedTab.tmuxSession === null && currentTab?.tmuxSession && acknowledgedDuringRestore.has(validatedTab.id)) {
          logTerminalBench('validated-restore-preserved-session', {
            tabId: validatedTab.id,
            sessionName: currentTab.tmuxSession,
          });
        }
      }
      const validatedTabs = reconcileValidatedTabs(validated.tabs, tabsRef.current, acknowledgedDuringRestore);
      const reconciledTabs = mergeUserSpawnedTabs(validatedTabs, tabsRef.current, new Set(result.tabs.map((tab) => tab.id)));
      landTerminalTabs('restore-validated', reconciledTabs);
      setTabs(reconciledTabs);
      setActiveTabIdFromRestore(validated.activeTabId, capturedNavVersion);
      for (const tab of reconciledTabs) {
        if (tab.kind !== 'terminal' || !tab.tmuxSession || !tab.terminalExit || currentById.get(tab.id)?.terminalExit) continue;
        snapshotTerminalExit({ tabsRef, panelRefs, setTabs, persistTabsNow, activeTabId: introspectRef.current.effectiveActiveTabId }, tab.tmuxSession, tab.terminalExit.exitCode,
          () => cancelled?.() || restoreGeneration !== restoreGenerationRef.current);
      }
      if (!termWsConnectedRef.current) return;
      for (const deadTab of validated.deadTerminalTabs) {
        const currentTab = tabsRef.current.find((tab) => tab.id === deadTab.id);
        if (!currentTab || currentTab.kind !== 'terminal' || currentTab.tmuxSession || pendingSessionsRef.current.has(deadTab.id)) continue;
        const restoreCommand = deadTab.repo?.localPath ? `cd ${shellQuote(deadTab.repo.localPath)}` : undefined;
        requestTerminalForTab(deadTab.id, restoreCommand, 'restore-validated-dead');
      }
    });
    return result.restoredAny;
  }, [createDefaultChatTab, createInitialChatTabs, defaultTab, landTerminalTabs, persistTabsNow, requestTerminalForTab, sendTerminalAttach, setActiveTabIdFromRestore]);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    restoreInFlightRef.current = true;
    let cancelled = false;

    // #717 — one-time, no-op-if-already-clean scrub of any localStorage values
    // shaped like `{ tabs: [...] }` BEFORE we call the API. There's no current
    // localStorage tab cache, but the user's #717 audit showed pre-fix zombies
    // surviving WebKit wipes; this is the future-proof guarantee that any
    // localStorage-backed persist middleware added later inherits the strip
    // without rediscovering #717.
    scrubLocalStorageTabZombies();

    urlDetectionEnabledRef.current = false;
    const timer = window.setTimeout(() => {
      urlDetectionEnabledRef.current = true;
    }, 5000);

    const currentPreferredRepoPath = preferredRepoRef.current?.localPath ?? null;
    const currentRestoreKey = restoreKeyRef.current ?? `${stateScope}::${defaultTab}::${splitCreated ? 'split' : 'shared'}::${currentPreferredRepoPath ?? 'no-repo'}`;

    void (async () => {
      try {
        const saved = await loadInitialTabState(
          { stateScope, defaultTab, splitCreated, preferredRepoPath: currentPreferredRepoPath },
          () => cancelled,
        );
        if (cancelled) return;

        if (saved) {
          await applyPersistedState(saved, () => cancelled);
          if (cancelled) return;
        } else if (autoCreateDefaultTab) {
          if (defaultTab !== 'terminal') {
            const defaultTabs = createInitialChatTabs();
            tabsRef.current = defaultTabs;
            setTabs(defaultTabs);
            // Focus the new pane's requested conversation.
            setActiveTabId(defaultTabs[0].id);
          } else {
            const defaultShell = createDefaultShellTab();
            tabsRef.current = [defaultShell];
            setTabs([defaultShell]);
            setActiveTabId(defaultShell.id);
            if (termWsConnectedRef.current) {
              initialTerminalBootstrapRef.current = true;
              requestTerminalForTab(defaultShell.id, undefined, 'default-shell');
            }
          }
        } else {
          tabsRef.current = [];
          setTabs([]);
          setActiveTabId('');
        }
        restoreInFlightRef.current = false;
        restoreSettledRef.current = true;
        setRestoreCompletedKey(currentRestoreKey);
      } catch {
        restoreInFlightRef.current = false;
        if (cancelled) return;
        restoreSettledRef.current = true;
        setRestoreCompletedKey(restoreKeyRef.current ?? stateScope);
      }
    })();

    return () => {
      cancelled = true;
      // #1234 — if we're tearing down a restore that never settled, re-arm
      // the one-shot guard so the successor effect run performs the restore
      // instead of bailing at `restoredRef`. Without this, any dep-identity
      // change mid-restore (WS send callbacks, StrictMode's dev double-mount)
      // cancels the only run that would ever flip restoreSettledRef — and the
      // persist effect stays disarmed for the whole session while the UI
      // looks healthy: every tab op after boot silently fails to save.
      if (restoreInFlightRef.current) {
        restoredRef.current = false;
      }
      restoreInFlightRef.current = false;
      window.clearTimeout(timer);
    };
    // `restoreKey` is a dep so a preferredRepo change re-runs this effect:
    // the restore-key effect above resets/preserves the controller refs but
    // cannot itself restore — without this dep, a non-preserve key change
    // cleared the tabs and left restoredRef=false with nothing to re-trigger
    // the restore (the second half of #1234).
  }, [applyPersistedState, autoCreateDefaultTab, createDefaultChatTab, createInitialChatTabs, createDefaultShellTab, defaultTab, requestTerminalForTab, restoreKey, splitCreated, stateScope]);

  useEffect(() => {
    if (!termWsConnected || !restoreSettledRef.current) return;
    if (!initialTerminalBootstrapRef.current) {
      initialTerminalBootstrapRef.current = true;
      for (const tab of tabsRef.current) {
        if (tab.kind !== 'terminal') continue;
        if (tab.tmuxSession) {
          sendTerminalAttach(tab.tmuxSession, 120, 30, tab.readOnly);
          continue;
        }
        if (tab.remoteMachine) continue;
        const restoreCommand = tab.repo?.localPath ? `cd ${shellQuote(tab.repo.localPath)}` : undefined;
        requestTerminalForTab(tab.id, restoreCommand, 'ws-bootstrap');
      }
    }
    flushQueuedRemoteLaunches(tabsRef.current, queuedRemoteLaunchesRef.current, requestTerminalForTab);
  }, [requestTerminalForTab, restoreCompletedKey, sendTerminalAttach, termWsConnected]);

  useEffect(() => {
    if (tabs.length > 0 || !termWsConnected || splitCreated || !primaryRestoreSettled) return;
    const timer = window.setTimeout(() => {
      // Capture the user-nav version at the point where this fallback
      // restore is scheduled. If the user clicks a tab between the timer
      // firing and the async load resolving, we drop the late activeTabId
      // assignment so the user's click stays sticky. Phase 4 friction #4.
      const capturedNavVersion = userNavVersionRef.current;
      void (async () => {
        // Re-check at fire time (same pattern as the 2s fallback below): this
        // effect scheduled against an EMPTY tab set, but a user spawn can land
        // inside the timer + async-load window (GQXEZD) — if tabs exist now,
        // wholesale-writing defaults or a restore over them is a clobber.
        if (tabsRef.current.length > 0) return;
        if (stableRepoScope && preferredRepo?.localPath) {
          const saved = await loadTabState(stableRepoScope, preferredRepo.localPath);
          if (saved && saved.tabs.length > 0) {
            const restored = await applyPersistedState(saved);
            if (restored) return;
          }
        }
        // Same re-check after the async load — a spawn during the await must
        // not be overwritten by the default-tab injection below.
        if (tabsRef.current.length > 0) return;
        if (!autoCreateDefaultTab) {
          tabsRef.current = [];
          setTabs([]);
          setActiveTabIdFromRestore('', capturedNavVersion);
          return;
        }
        if (defaultTab !== 'terminal') {
          const defaultTabs = createInitialChatTabs();
          tabsRef.current = defaultTabs;
          setTabs(defaultTabs);
          setActiveTabIdFromRestore(defaultTabs[0].id, capturedNavVersion);
          return;
        }
        const fallbackShell = createDefaultShellTab();
        tabsRef.current = [fallbackShell];
        setTabs([fallbackShell]);
        setActiveTabIdFromRestore(fallbackShell.id, capturedNavVersion);
        if (termWsConnected) {
          requestTerminalForTab(fallbackShell.id, undefined, 'fallback-shell');
        }
      })();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [applyPersistedState, autoCreateDefaultTab, createDefaultChatTab, createInitialChatTabs, createDefaultShellTab, defaultTab, preferredRepo?.localPath, primaryRestoreSettled, requestTerminalForTab, setActiveTabIdFromRestore, splitCreated, stableRepoScope, tabs.length, termWsConnected]);

  useEffect(() => {
    if (tabs.length > 0 || defaultTab === 'terminal') return;
    const timer = window.setTimeout(() => {
      if (tabsRef.current.length > 0) return;
      const fallbacks = createInitialChatTabs();
      tabsRef.current = fallbacks;
      setTabs(fallbacks);
      setActiveTabId(fallbacks[0].id);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [createInitialChatTabs, defaultTab, tabs.length]);

  // Migration: if restored state is missing an Orchestrator tab, inject one
  // at the front. Ensures existing users get the new tab automatically and
  // don't have to manually add it.
  //
  // Issue #714 — this effect MUST be idempotent against any remount (theme
  // switch, HMR, parent re-render that unmounts TileContainer, etc.). The
  // contract: never produce a duplicate orchestrator. Two layers of dedup:
  //   1. State-side: bail if `tabs` already has an orchestrator-kind tab.
  //   2. Ref-side: also bail if `tabsRef.current` has one. Covers the window
  //      where another setTabs has scheduled an update we haven't rendered.
  // Setting via the functional updater form gives us a third guard against
  // batched / out-of-order state writes that could otherwise stack two
  // injectors onto the same base.
  useEffect(() => {
    if (defaultTab !== 'llm-chat' || splitCreated) return;
    if (tabs.length === 0) return;
    if (tabs.some((tab) => tab.kind === 'orchestrator')) return;
    if (tabsRef.current.some((tab) => tab.kind === 'orchestrator')) return;
    setTabs((previous) => {
      if (previous.some((tab) => tab.kind === 'orchestrator')) return previous;
      const orchestratorTab = createDefaultOrchestratorTab();
      const nextTabs = [orchestratorTab, ...previous];
      tabsRef.current = nextTabs;
      return nextTabs;
    });
    // Don't steal focus from whatever the user was on — just inject the tab.
  }, [createDefaultOrchestratorTab, defaultTab, splitCreated, tabs]);

  const handleSessionCreated = useCallback((sessionName: string, requestId?: string) => {
    const recordAcknowledgement = (tabId: string) => {
      terminalAckRevisionsRef.current.set(tabId, (terminalAckRevisionsRef.current.get(tabId) ?? 0) + 1);
    };
    const ownerTabId = ownerTabIdFromRequest(requestId);
    const directTabId = requestId ? pendingRequestRef.current.get(requestId) : undefined;
    if (requestId && !directTabId) {
      const ownerTab = ownerTabId
        ? tabsRef.current.find((tab) => tab.id === ownerTabId && tab.kind === 'terminal')
        : null;
      if (ownerTab?.tmuxSession === sessionName) {
        recordAcknowledgement(ownerTab.id);
        logTerminalBench('terminal-created', {
          tabId: ownerTab.id,
          requestId,
          sessionName,
          outcome: 'mapped',
          duplicate: true,
        });
        return true;
      }
      logTerminalBench('terminal-created', {
        tabId: ownerTabId,
        requestId,
        sessionName,
        outcome: 'unknown-request',
      });
      console.warn('[workspace-terminal] created ack dropped', {
        requestId,
        sessionName,
        reason: 'unknown-request',
      });
      // Only legacy non-owner requests can create an orphan attachment. An
      // owner-keyed session remains the tab's deterministic live session.
      if (!ownerTabId) sendTerminalDetach(sessionName);
      return false;
    }
    if (requestId) pendingRequestRef.current.delete(requestId);
    if (directTabId) {
      pendingSessionsRef.current.delete(directTabId);
      exposeTerminalBenchPendingSessions(pendingSessionsRef.current);
    }

    const previous = tabsRef.current;
    const pendingIndex = directTabId
      ? previous.findIndex((tab) => tab.id === directTabId && tab.kind === 'terminal' && tab.tmuxSession === null)
      : previous.findIndex((tab) => tab.kind === 'terminal' && tab.tmuxSession === null);
    if (pendingIndex < 0) {
      const directTab = directTabId
        ? previous.find((tab) => tab.id === directTabId && tab.kind === 'terminal')
        : null;
      if (directTab?.tmuxSession === sessionName) {
        recordAcknowledgement(directTab.id);
        logTerminalBench('terminal-created', {
          tabId: directTab.id,
          requestId: requestId ?? null,
          sessionName,
          outcome: 'mapped',
          duplicate: true,
        });
        return true;
      }
      logTerminalBench('terminal-created', {
        tabId: directTabId ?? null,
        requestId: requestId ?? null,
        sessionName,
        outcome: 'no-pending-tab',
      });
      console.warn('[workspace-terminal] created ack dropped', {
        requestId,
        sessionName,
        reason: 'no-pending-tab',
      });
      if (requestId && directTabId && !ownerTabId) sendTerminalDetach(sessionName);
      return false;
    }
    const updated = [...previous];
    const tab = updated[pendingIndex];
    recordAcknowledgement(tab.id);
    updated[pendingIndex] = { ...tab, tmuxSession: sessionName };
    logTerminalBench('terminal-created', {
      tabId: tab.id,
      requestId: requestId ?? null,
      sessionName,
      outcome: 'mapped',
    });
    landTerminalTabs('created-ack', updated);
    setTabs((currentTabs) => applyCreatedTerminalSession(currentTabs, tab.id, sessionName));
    // Flush the crash-recovery pointer now, before the 500 ms UI-state debounce.
    persistTabsNow(updated, activeTabId || updated[pendingIndex]?.id || '');
    return true;
  }, [activeTabId, landTerminalTabs, persistTabsNow, sendTerminalDetach]);

  const openWorkspaceCliChatSession = useCallback((options: Parameters<TerminalTabHandle['openCliChatSession']>[0]) => {
    const result = computeCliChatSession(options, tabsRef.current, activeTabId);
    tabsRef.current = result.tabs;
    setTabs(result.tabs);
    if (options.background && activeTabId) {
      // Agent-originated launch (Symon / supervisor auto-open): the tab is
      // created and lands in the tab rail + right panel like any dispatched
      // agent, but the operator's active surface is NOT hijacked — focus
      // stays where it is (Q ruling 2026-07-17). Persist keeps the current
      // active tab. (With no active tab at all — empty workspace — focusing
      // the new tab is correct, so background only applies when the operator
      // is actually somewhere.)
      if (result.needsPersist) persistTabsNow(result.tabs, activeTabId);
    } else {
      setActiveTabIdFromUser(result.activeTabId);
      if (result.needsPersist) persistTabsNow(result.tabs, result.activeTabId);
    }
    return result.activeTabId;
  }, [activeTabId, persistTabsNow, setActiveTabIdFromUser]);

  const openWorkspaceLlmChatSession = useCallback((options: {
    repo?: RegisteredRepo;
    initialText?: string;
    draftReason?: string;
    autoSend?: boolean;
    createNew?: boolean;
    label?: string;
    targetSessionKey?: string;
  }) => {
    const result = computeLlmChatSession(options, tabsRef.current, activeTabId);
    if (result.updatedTabId) {
      const injection = buildLlmInjection(options);
      const nextTabs = tabsRef.current.map((tab) => (
        tab.id === result.updatedTabId ? { ...tab, label: options.label ?? tab.label, llmDraftInjection: injection ?? tab.llmDraftInjection } : tab
      ));
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
    } else if (result.newTab) {
      const nextTabs = [result.newTab, ...tabsRef.current];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
    }
    setActiveTabIdFromUser(result.activeTabId);
    return result.activeTabId;
  }, [activeTabId, setActiveTabIdFromUser]);

  const openWorkspaceInspectorTab = useWorkspaceInspectorTabs({ tabsRef, activeTabIdRef: effectiveActiveTabIdRef, setTabs, onSelectTab: setActiveTabIdFromUser });

  const handleOpenWorkspaceCommitTab = useCallback((hash: string, meta?: Record<string, string>, repo?: RegisteredRepo) => {
    const { canvasTab, repo: resolvedRepo } = buildCommitCanvasTab(hash, meta, repo);
    openWorkspaceInspectorTab(canvasTab, { repo: resolvedRepo });
  }, [openWorkspaceInspectorTab]);

  const { openWorkspaceTerminalTab, openRemoteTerminalTab } = useTerminalTabLaunchers({
    tabsRef, pendingCliCommands, setTabs, setActiveTabIdFromUser, requestTerminalForTab,
  });

  const attachWorkspaceTerminalSession = useCallback((
    session: WorkspaceAttachedTerminalSession,
    repo: RegisteredRepo | null,
  ): string => {
    const existing = tabsRef.current.find((tab) => (
      tab.kind === 'terminal' && tab.tmuxSession === session.tmuxSession
    ));
    if (existing) return existing.id;
    const now = Date.now();
    const newTab: TerminalTab = {
      id: createWorkspaceTabId('terminal'),
      label: session.label?.trim() || 'Terminal',
      kind: 'terminal',
      tmuxSession: session.tmuxSession, readOnly: session.readOnly,
      repo: repo ?? undefined,
      createdAt: now, lastActivity: now,
    };
    const nextTabs = [...tabsRef.current, newTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    return newTab.id;
  }, []);

  useImperativeHandle(ref, () => buildTerminalTabHandle({
    tabsRef,
    panelRefs,
    detectedPortsRef,
    urlDetectionEnabledRef,
    restoreSettledRef,
    pendingRequestRef,
    activeTabId,
    stateScope,
    preferredRepo,
    setTabs,
    setPreviews,
    // External callers via the imperative handle are user-driven (e.g.
    // the dashboard wiring an "open this tab" gesture) — bump the
    // user-nav version so a concurrently-running restore doesn't yank
    // the tab back. Phase 4 friction fix #4.
    setActiveTabId: setActiveTabIdFromUser,
    onPreviewDetected,
    onOpenRepoDiff,
    handleSessionCreated,
    openWorkspaceCliChatSession,
    openWorkspaceLlmChatSession,
    openWorkspaceOrchestratorTab: spawnOrchestratorTab,
    openWorkspaceTerminalTab,
    openRemoteTerminalTab,
    attachWorkspaceTerminalSession,
    openWorkspaceInspectorTab,
    persistTabsNow,
    recordTerminalActivity: terminalActivity.record,
    sendTerminalDetach,
    closeTabById: (tabId: string) => handleCloseTabRef.current(tabId),
  }), [activeTabId, attachWorkspaceTerminalSession, handleSessionCreated, onOpenRepoDiff, onPreviewDetected, openRemoteTerminalTab, openWorkspaceCliChatSession, openWorkspaceInspectorTab, openWorkspaceLlmChatSession, openWorkspaceTerminalTab, persistTabsNow, preferredRepo, sendTerminalDetach, setActiveTabIdFromUser, spawnOrchestratorTab, stateScope, terminalActivity]);

  const handleRegisterRepo = useCallback((localPath: string) => {
    fetch('/api/panel/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', localPath }),
    }).catch(() => undefined);
  }, []);

  const handleNewTab = useCallback((agentId: string, repo?: RegisteredRepo) => {
    return openWorkspaceTerminalTab(agentId, repo);
  }, [openWorkspaceTerminalTab]);

  const handleNewChatTab = useCallback((runtime: Exclude<WorkspaceChatRuntime, 'chat'>, repo?: RegisteredRepo) => {
    const newTab = buildNewChatTab(runtime, repo);
    setTabs((previous) => [newTab, ...previous]);
    setActiveTabIdFromUser(newTab.id);
  }, [setActiveTabIdFromUser]);

  const { handleNewLLMChatTab, handleNewChatGPTPlanTab } = useTextChatTabs({
    preferredRepo, tabsRef, setTabs, persistTabsNow, setActiveTabIdFromUser,
  });

  const handleUpdateChatMessages = useCallback((tabId: string, messages: MobileTranscriptEntry[]) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? computeUpdatedChatMessages(tab, messages) : tab
    )));
  }, []);

  const handleUpdateLlmSummary = useCallback((tabId: string, summary: string | null) => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (tab.id !== tabId || tab.llmSummary === summary) return tab;
        changed = true;
        return { ...tab, llmSummary: summary };
      });
      return changed ? next : prev;
    });
  }, []);

  const handleUpdateChatSessionKey = useCallback((tabId: string, sessionKey: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? computeUpdatedChatSessionKey(tab, sessionKey) : tab
    )));
  }, []);

  const handleUpdateChatModel = useCallback((tabId: string, modelId: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? { ...tab, chatModel: modelId } : tab
    )));
  }, []);

  const handleUpdateLinkedIssue = useCallback((tabId: string, linkedIssue: TerminalTab['linkedIssue']) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? { ...tab, linkedIssue } : tab
    )));
  }, []);

  const handleUpdateTabLabel = useWorkspaceTabLabelUpdater(setTabs, tabsRef);

  const handleSaveCheckpoint = useCallback((tabId: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId ? computeSaveCheckpoint(tab) : tab
    )));
  }, []);

  const handleRestoreLatestCheckpoint = useCallback((tabId: string) => {
    const result = computeCheckpointRestore(tabsRef.current, tabId);
    if (!result.newTab) return;
    setTabs((previous) => [...previous, result.newTab!]);
    setActiveTabIdFromUser(result.activeTabId);
  }, [setActiveTabIdFromUser]);

  const handleConsumeChatDraftInjection = useCallback((tabId: string, injectionId: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId && tab.chatDraftInjection?.id === injectionId
        ? { ...tab, chatDraftInjection: undefined }
        : tab
    )));
  }, []);

  const handleConsumeLlmDraftInjection = useCallback((tabId: string, injectionId: string) => {
    setTabs((previous) => previous.map((tab) => (
      tab.id === tabId && tab.llmDraftInjection?.id === injectionId
        ? { ...tab, llmDraftInjection: undefined }
        : tab
    )));
  }, []);

  const handleRunCommandInTerminal = useCallback((command: string) => {
    const target = resolveRunCommandTarget(tabs);
    if (target.kind === 'existing-shell') {
      sendTerminalInput(target.tmuxSession!, command + '\n');
    } else if (target.kind === 'pending-shell') {
      pendingCliCommands.current.set(target.pendingTabId!, command);
      setActiveTabIdFromUser(target.pendingTabId!);
    } else {
      setTabs((previous) => [...previous, target.newTab!]);
      setActiveTabIdFromUser(target.newTab!.id);
      requestTerminalForTab(target.newTab!.id, command, 'run-command');
    }
  }, [requestTerminalForTab, sendTerminalInput, setActiveTabIdFromUser, tabs]);

  const {
    archiveWorkspaceTab,
    cleanupFinishedTabs,
    finishedTabCount,
    handleCloseTab,
    undoCleanup,
  } = useWorkspaceTabCleanup({
    activeTabId,
    detectedPortsRef,
    effectiveActiveTabId,
    panelRefs,
    pendingCliCommands,
    pendingRequestRef,
    pendingSessionsRef,
    sendTerminalDetach,
    sendTerminalInput,
    setActiveTabIdFromUser,
    setPreviews,
    setTabs,
    tabs,
    tabsRef,
  });

  useEffect(() => {
    handleCloseTabRef.current = handleCloseTab;
  }, [handleCloseTab]);

  useEffect(() => {
    const timers = new Map<string, number>();
    const now = Date.now();
    for (const tab of tabs) {
      if (tab.id === effectiveActiveTabId || !isAutoArchiveEligible(tab)) continue;
      const delayMs = Math.max(0, ORCHESTRATED_TAB_AUTO_ARCHIVE_MS - Math.max(0, now - tab.lastActivity));
      timers.set(tab.id, window.setTimeout(() => {
        const latest = terminalActivity.merge(tabsRef.current).find((candidate) => candidate.id === tab.id);
        if (latest && Date.now() - latest.lastActivity >= ORCHESTRATED_TAB_AUTO_ARCHIVE_MS) archiveWorkspaceTab(tab.id, tab.orchestrationPacket?.packetId ?? null);
      }, delayMs));
    }
    return () => { timers.forEach((id) => window.clearTimeout(id)); };
  }, [archiveWorkspaceTab, effectiveActiveTabId, tabs, terminalActivity]);
  usePendingCliCommands(tabs, pendingCliCommands.current, tabsRef, setTabs, sendTerminalInput);

  const handleDragStart = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    startPreviewDrag(containerDivRef.current, setPreviewHeight, setIsDragging);
  }, []);

  useEffect(() => {
    onActiveLaneChange?.(activeLaneState);
  }, [activeLaneState, onActiveLaneChange]);

  useEffect(() => {
    if (!containerDivRef.current) return undefined;
    return observeXtermHelperNames(containerDivRef.current, stateScope);
  }, [stateScope]);

  useEffect(() => {
    const nextRepoScope = activeRepo?.localPath ?? preferredRepo?.localPath ?? null;
    if (reportedRepoScopeRef.current === nextRepoScope) return;
    reportedRepoScopeRef.current = nextRepoScope;
    onRepoScopeChange?.(nextRepoScope);
  }, [activeRepo?.localPath, onRepoScopeChange, preferredRepo?.localPath]);

  useEffect(() => {
    onActiveRepoContextChange?.(activeRepoContext);
  }, [activeRepoContext, onActiveRepoContextChange]);

  const handleReorderTabs = useCallback((draggedId: string, dropTargetId: string, after?: boolean) => {
    setTabs((prev) => {
      const next = reorderTabs(prev, draggedId, dropTargetId, after);
      tabsRef.current = next;
      return next;
    });
  }, []);

  const handleSelectTab = useCallback((id: string) => {
    setActiveTabIdFromUser(id);
    setTabs((previous) => previous.find((tab) => tab.id === id)?.unseen
      ? previous.map((tab) => (tab.id === id ? { ...tab, unseen: false } : tab))
      : previous);
  }, [setActiveTabIdFromUser]);

  const handleClosePreview = useCallback((id: string) => {
    setPreviews((previous) => {
      const removed = previous.find((preview) => preview.id === id);
      if (removed) {
        detectedPortsRef.current.delete(removed.port);
      }
      return previous.filter((preview) => preview.id !== id);
    });
  }, []);

  const handleOpenHistoryChat = useCallback((
    currentTab: TerminalTab,
    historyTabId: string,
    title: string,
    historyRepo?: { name?: string; localPath?: string; branch?: string | null; remoteUrl?: string | null } | null,
  ) => {
    const newTab = buildHistoryChatTab(currentTab, historyTabId, title, historyRepo);
    const previous = tabsRef.current;
    const nextTabs = previous.some((tab) => tab.id === historyTabId)
      ? previous.map((tab) => (
          tab.id === historyTabId
            ? { ...tab, label: title, repo: newTab.repo ?? tab.repo }
            : tab
        ))
      : [...previous, newTab];
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    setActiveTabIdFromUser(historyTabId);
    persistTabsNow(nextTabs, historyTabId);
  }, [persistTabsNow, setActiveTabIdFromUser]);

  return {
    activeCheckpoint,
    activeRepo,
    activeTab,
    attachWorkspaceTerminalSession,
    containerDivRef,
    effectiveActiveTabId,
    cleanupFinishedTabs,
    finishedTabCount,
    handleClosePreview,
    handleCloseTab,
    handleConsumeChatDraftInjection,
    handleConsumeLlmDraftInjection,
    handleDragStart,
    handleNewChatTab,
    handleNewLLMChatTab,
    handleNewChatGPTPlanTab,
    handleNewTab,
    openRemoteTerminalTab,
    handleOpenHistoryChat,
    handleReorderTabs,
    handleOpenWorkspaceCommitTab,
    handleRegisterRepo,
    handleRestoreLatestCheckpoint,
    handleRunCommandInTerminal,
    handleSaveCheckpoint,
    handleSelectTab,
    handleUpdateChatMessages,
    handleUpdateChatModel,
    handleUpdateChatSessionKey,
    handleUpdateLinkedIssue,
    handleUpdateLlmSummary,
    handleUpdateTabLabel,
    isDragging,
    launchRequestKey,
    panelRefs,
    previews,
    previewHeight,
    primaryRestoreSettled,
    restoreSettledRef,
    setLaunchRequestKey,
    spawnSingleRuntimeTab,
    spawnChatTab,
    spawnOrchestratorTab,
    spawnFleetCanvasTab,
    handleUpdateTabMode,
    undoCleanup,
    tabs, getTabInventory,
    termWsConnected,
    visibleTabs,
  };
}
