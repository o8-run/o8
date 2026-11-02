'use client';
import { ComposerFrame } from './chat-panel/ComposerFrame';
import { SessionCacheProvider } from '../SessionCacheIndicator';

import { sendBoundComposerTurn } from './use-orchestrator-stream/bound-composer-turn';
import { ManagedChatVoiceEntry } from './chat-panel/ManagedChatVoiceEntry';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState } from 'react';
import { TranscriptPlan, useTranscriptActions } from './chat-panel/transcript-presentation';
import { composeComposerTurnMessage, resolveComposerExecutionMode, type ComposerMode } from './composer-mode';
import { orchestratorBackendDisplayLabel, orchestratorRuntimeTone } from '@/lib/orchestrator/display';
import { correlatedActionIsUnsettled } from '@/lib/orchestrator/action-receipt';
import { fetchRuntimeLaunchReceipt, fetchRuntimeSteerReceipt } from '@/lib/orchestrator/runtime-mutation-receipt';
import { getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import {
  resolveInitialOrchestratorThinkingPreferences,
  writeStoredOrchestratorThinkingOverride,
} from '@/lib/orchestrator/thinking-preferences';
import {
  queueOrchestratorSessionPrelude,
  searchOrchestratorArchive,
  writeStoredOrchestratorModel,
} from '@/lib/orchestrator/store';
import type {
  OrchestratorRuntime,
} from '@/lib/orchestrator/types';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { retainedTranscriptReducer } from '@/lib/transcripts/retained-state';
import { serializeThreadToMarkdown } from '@/lib/llm/export-thread';
import {
  executeOrchestratorSlashCommand,
  parseOrchestratorSlashCommand,
} from '@/lib/slash-commands';
import type { ThoughtsChatPanelProps } from './ThoughtsChatPanelProps';
import {
  entrySignature,
  generateSuggestions,
  isRenderableThoughtEntry,
  isRunnableCliSession,
  isRuntimeSessionKey,
  mergeSameThreadHistoryLoad,
  mergeTranscriptEntries,
  repoPathLabel,
  resolveThreadLoadPlan,
} from './utils';
import { useWorkspaceOrchestratorStream } from './chat-panel/useWorkspaceOrchestratorStream';
import { useSlashOrchestration } from './useSlashOrchestration';
import type { OrchestratorSendOptions } from './use-orchestrator-stream/types';
import { useOrchestratorStatusFeed } from './useOrchestratorStatusFeed';
import { getPendingMissionCards } from './mission-complete-detector';
import { useOrchestratorContextResidency } from '@/components/desktop/orchestrator/context-residency';
import { ProfiledChatMessageList as ChatMessageList } from './chat-panel/ProfiledChatMessageList';
import { useTaskArtifacts } from './chat-panel/useTaskArtifacts';
import type { TaskArtifactDeliverInput } from './chat-panel/TaskArtifactCard';
import { WorkerDisclosureProvider } from './chat-panel/WorkerDisclosure';
import { useThreadWorkers } from './chat-panel/ThreadWorkerCard';
import { projectThreadWorkerGroups } from './chat-panel/thread-worker-groups';
import { packetsForOrchestratorThread } from './chat-panel/SwarmStatusCard';
import { ipcFetch } from '@/lib/tauri/ipc-fetch';
import { track } from '@/lib/analytics/track';
import { ChatToastStack } from './chat-panel/ChatToastStack';
import { VisualComposerArea } from '@/components/desktop/visual-instructions/VisualComposerArea';
import { useOrchestratorModelState } from './composer-selector/useOrchestratorModelState';
import { BackendSwitchChoice } from './chat-panel/BackendSwitchChoice';
import { ComposerSendStatus } from './chat-panel/ComposerUploadStatus';
import { useDefaultComposerSendBuffer } from './chat-panel/useDefaultComposerSendBuffer';
import { useBufferedOrchestratorSend } from './chat-panel/useBufferedOrchestratorSend';
import { shouldApplyAutoRestoreAfterFetch } from './chat-panel/autoRestoreGuard';
import { loadOrchestrationMode, persistOrchestrationMode, type ChatModelId, type OrchestrationMode } from '@/components/desktop/orchestrator/ModePicker';
import {
  consumePendingComposerDraft,
  parseModeRoutingPrefix,
  stashPendingComposerDraft,
} from '@/lib/composer-mode-routing';
import { getChatModelOption, loadChatModelChoice } from '@/components/desktop/orchestrator/chat-models';
import {
  createChatAssistantEntry,
  createChatUserEntry,
  mergeToolCallIntoEntry,
  mergeToolResultIntoEntry,
  sendScratchChatMessage,
} from '@/components/desktop/orchestrator/send-chat-message';
import { resolveDisplayMessages, resolveVisibleChatMessages } from './chat-panel/resolve-display-messages';
import { EmptyStateCard } from './chat-panel/EmptyStateCard';
import { ThreadExportButton } from './chat-panel/ThreadExportButton';
import { useClearCommand } from './chat-panel/useClearCommand';
import { useOrchestratorReloadNotice } from './chat-panel/useOrchestratorReloadNotice';
import { usePersistChatThread } from './chat-panel/usePersistChatThread';
import { TranscriptActivity } from '../transcript/TranscriptActivity';
import { useTurnSummaryReceipt } from './chat-panel/useTurnSummaryReceipt';
import { useSuggestedReplies } from './chat-panel/useSuggestedReplies';
import { useThoughtsComposerAttachments } from './chat-panel/useThoughtsComposerAttachments';
import { useComposerRepoTarget } from './chat-panel/useComposerRepoTarget';
import { useTranscriptAutoScroll } from './chat-panel/useTranscriptAutoScroll';
import { useThreadHistoryBackfill } from './chat-panel/useThreadHistoryBackfill';
import {
  fetchOlderThreadPage,
  fetchThreadHistoryPage,
  useBoundedThreadHistoryWindow,
} from './chat-panel/thread-history-window';
import { ScreenshotAnnotator } from './chat-panel/ScreenshotAnnotator';
import { isAbortError } from '@/lib/active-long-lived-request';
import { useContextThinkingPreferences } from './chat-panel/useContextThinkingPreferences';
import { contextualOperatorDefaults } from './chat-panel/contextual-turn';
import { useComposerDraftLifecycle, useDraftStartFresh } from './chat-panel/useComposerDraftLifecycle';
import { composerDraftKey, useComposerDraftValue } from './chat-panel/composer-draft-store';
import { findIdleOrchestratorSession } from './chat-panel/idle-orchestrator-session';
import { fetchWithLongLivedBudget } from '@/lib/connection-budget';
import { useActiveLongLivedRequest } from '@/lib/use-active-long-lived-request';
import type {
  ThoughtsChatPanelChromeState,
  ThoughtsChatPanelHandle,
  ThoughtsChatPermissionMode,
  ThoughtsHistoryListResponse,
  ThoughtsHistoryResponse,
  ThoughtsSendNowOptions,
} from './chat-panel/types';
import {
  fetchThoughtsOperatorDefaults,
  scheduleThoughtsRuntimeReadiness,
  THOUGHTS_OPERATOR_DEFAULTS_FALLBACK,
  type OrchestratorBackendSetting,
} from './operator-defaults';
import {
  mapHistoryMessagesToTranscript,
  type ThoughtsHistoryMessage,
} from './history-transcript';
import {
  composerBackendTurnOverride,
  resolveFreshComposerTurnOptions,
  formatComposerBackendLabel,
  resolveActiveComposerBackend,
  useBackendSwitchChoice,
} from './useBackendSwitchChoice';

export type { ThoughtsChatPanelHandle, ThoughtsChatPanelChromeState, ThoughtsChatPermissionMode };

export const ThoughtsChatPanel = forwardRef<ThoughtsChatPanelHandle, ThoughtsChatPanelProps>(function ThoughtsChatPanel({
  open,
  draftInjection,
  contextualConversation,
  imageInjection,
  onImageInjectionConsumed,
  agents,
  missionState,
  preferredRuntime,
  sessionTargets,
  workspaceTargets,
  repoPath: repoPathProp,
  scopeTabId,
  draftConversationId,
  ownerTabId,
  projectId: projectIdProp,
  thoughtsBodyBackground,
  thoughtsElevatedSurface,
  thoughtsElevatedBorder,
  thoughtsElevatedShadow,
  thoughtsMutedGlass,
  permissionMode: initialPermissionMode = 'full',
  collideEnabled = false,
  onSetCollide,
  composerModeStorageId,
  repoLabel,
  emptyStateOverride,
  composerBelowSlot,
  transcriptSideRail,
  showInlineExport = true,
  footerMeterSlot,
  composerLeadingExtras,
  lockedMode,
  initialMode,
  initialSingleRuntime,
  initialChatModelId,
  initialChatOpenrouterModel,
  onModePersist,
  onSpawnSingleTab,
  onSpawnChatTab,
  onFocusPacket, onFocusSession,
  onChromeChange,
  onChatSummary,
  suppressAutoRestore = false, suppressRuntimePrewarm = false,
  expectsThreadLoad = false,
}, ref) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const draftKey = !contextualConversation ? composerDraftKey(repoPathProp, scopeTabId, threadId ?? draftConversationId ?? null) : null;
  const { value: input, setValue: setInput, captureOwner: captureDraftOwner, warning: draftWarning } = useComposerDraftValue(draftKey, 'input', contextualConversation?.initialDraft ?? '');
  const [permissionMode, setPermissionMode] = useState<ThoughtsChatPermissionMode>(initialPermissionMode);
  useEffect(() => setPermissionMode(initialPermissionMode), [initialPermissionMode]);
  // The mode ref keeps sends in sync with the selected composer mode.
  const [composerMode, setComposerMode] = useState<ComposerMode>(contextualConversation || lockedMode === 'single' || initialMode === 'single' ? 'solo' : 'fast');
  const composerModeRef = useRef<ComposerMode>(composerMode);
  composerModeRef.current = composerMode;
  // MoA IS the Collide backend — keep the chip and the model-picker's Mode
  // section telling the same truth in both directions.
  const handleComposerModeChange = useCallback((next: ComposerMode) => {
    setComposerMode(next);
    if (next === 'moa') onSetCollide?.(true);
    else if (collideEnabled) onSetCollide?.(false);
  }, [collideEnabled, onSetCollide]);
  useEffect(() => {
    if (collideEnabled && composerMode !== 'moa') {
      setComposerMode('moa');
    } else if (!collideEnabled && composerMode === 'moa') {
      setComposerMode('solo');
    }
  }, [collideEnabled, composerMode]);
  const [preEnhanceInput, setPreEnhanceInput] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const enhancementOwner = useRef<(() => boolean) | null>(null);
  // Orchestration mode + runtime + chat-model selection. Per-tab when
  // the parent provides initial values + onModePersist (the orchestrator
  // tab path); otherwise falls back to the legacy per-workspace
  // localStorage store keyed off repoPath.
  const workspaceModeKey = repoPathProp ?? '__global__';
  const usesPerTabPersistence = Boolean(onModePersist) || lockedMode !== undefined || initialMode !== undefined;
  const [orchestrationMode, setOrchestrationMode] = useState<OrchestrationMode>(
    () => lockedMode ?? initialMode ?? 'fleet',
  );
  const [singleRuntime, setSingleRuntime] = useState<OrchestratorRuntime>(
    () => initialSingleRuntime ?? 'codex',
  );
  const [chatModelId, setChatModelId] = useState<ChatModelId>(
    () => initialChatModelId ?? 'o8-default',
  );
  const [chatOpenrouterModel, setChatOpenrouterModel] = useState<string | undefined>(
    () => initialChatOpenrouterModel,
  );
  // Re-sync the pinned OpenRouter model when the parent tab record
  // changes (e.g. operator picked a different model and the tab updated).
  useEffect(() => {
    setChatOpenrouterModel(initialChatOpenrouterModel);
  }, [initialChatOpenrouterModel]);
  const [orchestrationSettingsKey, setOrchestrationSettingsKey] = useState<string | null>(
    () => (usesPerTabPersistence ? workspaceModeKey : null),
  );
  // Consume any pending slash-routed draft (`/codex foo`, `/chat hi`, ...)
  // stashed by the source tab right before it called the spawn handler.
  // Fires once per tab mount; ignored when this panel isn't a spawn
  // target (Fleet panels never have a matching pending draft).
  const slashDraftConsumedRef = useRef(false);
  useEffect(() => {
    if (slashDraftConsumedRef.current) return;
    if (!lockedMode) return;
    const target = lockedMode === 'chat'
      ? ({ kind: 'chat' } as const)
      : lockedMode === 'single'
        ? ({ kind: 'single', runtime: initialSingleRuntime ?? 'codex' } as const)
        : null;
    if (!target) return;
    const body = consumePendingComposerDraft(target);
    slashDraftConsumedRef.current = true;
    if (body) {
      setInput(body);
      latestInputRef.current = body;
    }
  }, [initialSingleRuntime, lockedMode, setInput]);
  const orchestrationSettingsLoaded = orchestrationSettingsKey === workspaceModeKey;
  const selectedChatModel = useMemo(() => getChatModelOption(chatModelId), [chatModelId]);
  useEffect(() => {
    if (usesPerTabPersistence) {
      // Per-tab path: initial values came in via props; just mark as
      // loaded so downstream effects can run.
      setOrchestrationSettingsKey(workspaceModeKey);
      return;
    }
    const loaded = loadOrchestrationMode(workspaceModeKey);
    setOrchestrationMode(loaded.mode);
    setSingleRuntime(loaded.runtime);
    setChatModelId(loadChatModelChoice(workspaceModeKey));
    setOrchestrationSettingsKey(workspaceModeKey);
  }, [usesPerTabPersistence, workspaceModeKey]);
  const handleSelectOrchestrationMode = useCallback((next: OrchestrationMode) => {
    if (lockedMode) return;
    setOrchestrationMode(next);
    if (onModePersist) {
      onModePersist({ mode: next });
    } else {
      persistOrchestrationMode(workspaceModeKey, next, singleRuntime);
    }
  }, [lockedMode, onModePersist, singleRuntime, workspaceModeKey]);

  // Empty-state Kind chip lives outside this component but needs to
  // flip the same orchestrationMode state the in-composer ModeChip
  // owns — otherwise toggling to Chat in the chip leaves the composer
  // pill row still showing the Orchestrator's model. Window event is
  // the loose-coupling bridge; gated on `open` so only the active
  // panel responds.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!open) return;
    const onSetMode = (event: Event) => {
      const detail = (event as CustomEvent<{ mode?: OrchestrationMode }>).detail;
      if (!detail?.mode) return;
      handleSelectOrchestrationMode(detail.mode);
    };
    window.addEventListener('o8:set-orchestration-mode', onSetMode as EventListener);
    return () => window.removeEventListener('o8:set-orchestration-mode', onSetMode as EventListener);
  }, [handleSelectOrchestrationMode, open]);

  const contextModelDefaults = contextualConversation?.modelDefaults;
  const [operatorDefaults, setOperatorDefaults] = useState(() => contextualOperatorDefaults(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK, contextModelDefaults));
  const [orchestratorBackend, setOrchestratorBackend] = useState<OrchestratorBackendSetting>(
    () => resolveActiveComposerBackend(contextualOperatorDefaults(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK, contextModelDefaults)),
  );
  // Who chose the composer's backend: 'default' (operator default seeded it),
  // 'thread' (adopted from a loaded thread's stored backend), 'user' (picked
  // in the composer this session). Precedence user > thread > default — a
  // reload must NOT silently re-route an OpenClaw/Codex conversation onto the
  // operator default ("they all say o8", 2026-07-16): a thread-bound tab
  // continues on ITS backend; the default is for new sessions.
  const backendSourceRef = useRef<'default' | 'thread' | 'user'>('default');
  const { adaptiveThinkingEnabled, setAdaptiveThinkingEnabled, thinkingOverride, setThinkingOverride } = useContextThinkingPreferences(THOUGHTS_OPERATOR_DEFAULTS_FALLBACK.thinkingEffort, contextualConversation);
  const [chatMessages, setChatMessages] = useReducer(retainedTranscriptReducer, []);
  const {
    entries: threadHistoryEntries,
    prependHistoryMessages,
    reset: resetThreadHistoryWindow,
  } = useBoundedThreadHistoryWindow();
  const [historyCompleteId, setHistoryCompleteId] = useState<string | null>(null);
  const [planText, setPlanText] = useState<string | null>(null);
  const [waitingForReply, setWaitingForReply] = useState(false);
  const [targetAgentKey, setTargetAgentKey] = useState<string>('__claude__');
  const thinkingPreferenceTouchedRef = useRef(false);
  const pollRef = useRef<number | null>(null);
  const pollDelayRef = useRef<number | null>(null);
  // Abort per transcript tick + on teardown so a stalled read cannot stack
  // ESTABLISHED sockets across the webview's small per-origin budget.
  const pollAbortRef = useRef<AbortController | null>(null);
  const openRef = useRef(open);
  const chatStreamRequest = useActiveLongLivedRequest(open);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const suppressNextTranscriptAutoScrollRef = useRef(false);
  const seenServerEntriesRef = useRef<Map<string, string>>(new Map());
  const responseSeenRef = useRef(false);
  const idlePollsRef = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const orchestratorSessionRef = useRef<string | null>(null);
  const singleRuntimeSessionRef = useRef<string | null>(null);
  const singleRuntimeLaunchPromiseRef = useRef<Promise<string | null> | null>(null);
  const [singleRuntimeSpawning, setSingleRuntimeSpawning] = useState(false);
  const threadIdRef = useRef<string | null>(null);
  const [activeThreadBackend, setActiveThreadBackend] = useState<OrchestratorBackendId | null>(null);
  const latestAssistantBackendRef = useRef<OrchestratorBackendId | null>(null);
  // Stored on thread load but no longer read for the composer label — the chip
  // predicts the next turn, which runs the backend's default agent (see the
  // activeBackendLabel note). Kept as a setter-only slot for the load pipeline.
  const [, setActiveThreadAgent] = useState<string | null>(null);
  // Sidebar trampoline guard: history load, restoreLastThread, and initialThreadId
  // can race. Block re-entry for the same tab while loading and briefly after.
  const inFlightLoadKeyRef = useRef<string | null>(null);
  const lastLoadKeyRef = useRef<string | null>(null);
  const lastLoadAtRef = useRef<number>(0);
  // Monotonic load generation. Every loadThread call bumps it; the async body
  // captures its value and refuses to APPLY results if a newer load has started
  // meanwhile. Without this, loading thread B while A's fetch is still in flight
  // let a late A response overwrite B — the tab showed the wrong conversation
  // (adversarial review 2026-07-15).
  const loadGenerationRef = useRef(0);
  const exportFeedbackTimerRef = useRef<number | null>(null);
  const [resolvedRepoPath, setResolvedRepoPath] = useState<string | null>(repoPathProp ?? null);
  const {
    acceptModel: acceptOrchestratorModel,
    model: orchestratorModel,
    restoreModel: restoreOrchestratorModel,
    setModel: setOrchestratorModel,
  } = useOrchestratorModelState({ operatorDefaultModel: operatorDefaults.orchestratorModel, repoPath: resolvedRepoPath, isolated: Boolean(contextualConversation) });
  const resetComposerModeForLeadChange = useCallback(() => {
    if (composerModeRef.current === 'moa' || composerModeRef.current === 'fusion') {
      handleComposerModeChange('solo');
    }
  }, [handleComposerModeChange]);
  const backendSwitch = useBackendSwitchChoice({
    backendSourceRef,
    currentModel: orchestratorModel,
    latestAssistantBackendRef,
    operatorDefaults,
    repoPath: resolvedRepoPath,
    setActiveThreadAgent,
    setActiveThreadBackend,
    setBackend: setOrchestratorBackend,
    setModel: acceptOrchestratorModel,
    setOperatorDefaults,
    onBeforeApply: resetComposerModeForLeadChange,
    persistSelection: !contextualConversation,
  });
  const [threadProjectId, setThreadProjectId] = useState<string | null>(projectIdProp ?? null);
  useEffect(() => {
    if (threadIdRef.current !== null) return;
    setThreadProjectId(projectIdProp ?? null);
  }, [projectIdProp]);
  const [exportState, setExportState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');
  const { persistThread, persistThreadNow, cancelPendingPersist } = usePersistChatThread(
    resolvedRepoPath,
    threadProjectId,
  );
  const thinkingEffort: ThinkingEffort = thinkingOverride ?? (adaptiveThinkingEnabled ? 'adaptive' : 'max');
  const composerDropHostRef = useRef<HTMLDivElement>(null);
  const {
    attachedImages,
    uploadError, uploading, failedUploads, retryFailedUploads, discardFailedUploads,
    addAttachedImage,
    attachedFiles,
    dragOver: attachmentDragOver,
    dragHandlers: attachmentDragHandlers,
    processFiles: processAttachmentFiles,
    removeAttachedImage,
    replaceAttachedImage,
    removeAttachedFile,
    clearAttachments,
  } = useThoughtsComposerAttachments({ hostRef: composerDropHostRef, draftKey });
  // Index of the attachment currently open in the screenshot annotator (or null).
  const [annotatingIndex, setAnnotatingIndex] = useState<number | null>(null);
  const settledAssistantRefetchRef = useRef<() => void>(() => {});
  // 'single' means two different things by tab kind (operator, 2026-07-06):
  // on a LOCKED tab (kind:'chat', dedicated CLI session) it is the classic
  // single-runtime composer; on an unlocked ORCHESTRATOR tab it is SOLO —
  // the same Claude orchestrator, just forbidden from dispatching this turn.
  // Picking Single must never silently swap the orchestrator for a raw Codex
  // session (that was the stuck-on-Codex trap).
  const isSingleMode = lockedMode === 'single';
  const isChatMode = orchestrationMode === 'chat';
  // One available runtime runs inline; pending readiness preserves fleet routing.
  const soloOrchestrator = operatorDefaults.readyRuntimeCount === 1 && lockedMode !== 'single' && !isChatMode;
  const isOrchestratorMode = !isSingleMode && !isChatMode && (targetAgentKey === '__claude__' || !sessionTargets.some((s) => s.key === targetAgentKey));

  const orchStream = useWorkspaceOrchestratorStream(isOrchestratorMode && orchestrationSettingsLoaded && !isChatMode ? resolvedRepoPath : null, {
    projectId: threadProjectId, visible: open, scopeTabId, suppressAutoRestore,
    seededPlanText: planText,
    hasHistory: chatMessages.some(message => !message.voice),
    threadId,
    onThreadIdMint: useCallback((id: string) => {
      if (threadIdRef.current === id) return;
      threadIdRef.current = id;
      setThreadId(id);
    }, []),
    onSettledAssistantMissing: useCallback(() => settledAssistantRefetchRef.current(), []),
  });
  // Surface per-packet lifecycle moments (merge, self-heal / needs-human) as
  // status cards in the orchestrator transcript. Also delivers the
  // Mission-complete card for MCP-dispatched missions (the chat-stream rotation
  // path only sees chat-driven ones); a shared carded set prevents double-cards.
  useOrchestratorStatusFeed({
    active: isOrchestratorMode && !isChatMode,
    repoPath: resolvedRepoPath,
    threadId,
    missionPackets: missionState?.packets ?? [],
    appendLocalEntries: orchStream.appendLocalEntries,
  });

  useEffect(() => {
    const controller = new AbortController();
    const cancelRuntimeReadiness = scheduleThoughtsRuntimeReadiness(controller.signal, (readyRuntimeCount) => {
      setOperatorDefaults((current) => ({ ...current, readyRuntimeCount }));
    });
    void (async () => {
      const defaults = contextualOperatorDefaults(await fetchThoughtsOperatorDefaults(controller.signal), contextModelDefaults);
      if (controller.signal.aborted) return;
      setOperatorDefaults(defaults);
      // Late-landing defaults must not clobber a backend the thread (or the
      // user) already chose — default is the weakest source.
      if (backendSourceRef.current === 'default') {
        setOrchestratorBackend(resolveActiveComposerBackend(defaults));
      }
      if (thinkingPreferenceTouchedRef.current) return;
      const nextThinkingPreferences = contextModelDefaults ? { adaptiveThinkingEnabled: false, thinkingOverride: contextModelDefaults.effort } : resolveInitialOrchestratorThinkingPreferences(defaults.thinkingEffort);
      setAdaptiveThinkingEnabled(nextThinkingPreferences.adaptiveThinkingEnabled);
      setThinkingOverride(nextThinkingPreferences.thinkingOverride);
    })();

    return () => { controller.abort(); cancelRuntimeReadiness(); };
  }, [contextModelDefaults, setAdaptiveThinkingEnabled, setThinkingOverride]);



  useEffect(() => {
    if (!isOrchestratorMode) return;
    if (!orchStream.planText || planText) return;
    setPlanText(orchStream.planText);
  }, [isOrchestratorMode, orchStream.planText, planText]);

  const targetAgent = useMemo(
    () => isOrchestratorMode ? null : (sessionTargets.find((agent) => agent.key === targetAgentKey) ?? null),
    [isOrchestratorMode, sessionTargets, targetAgentKey],
  );
  const targetSessionKey = targetAgent?.key ?? null;
  const selectedWorkspaceTarget = useMemo(
    () => workspaceTargets.find((target) => target.localPath === resolvedRepoPath) ?? null,
    [resolvedRepoPath, workspaceTargets],
  );
  // The empty-state Project chip owns selection until messages arrive.
  const composerRepoLabelBase = selectedWorkspaceTarget?.label
    ?? repoLabel
    ?? repoPathLabel(resolvedRepoPath);
  const applyComposerRepoPath = useCallback((next: string) => {
    setResolvedRepoPath(next);
    setPlanText(null);
    setWaitingForReply(false);
    orchestratorSessionRef.current = null;
    singleRuntimeSessionRef.current = null;
    singleRuntimeLaunchPromiseRef.current = null;
  }, []);
  const { selectRepoPath: handleSelectComposerRepoPath, ensureSelectedRepoPersisted, targetSaveError } = useComposerRepoTarget({
    activeThreadId: threadId,
    applyRepoPath: applyComposerRepoPath,
    ownerTabId,
    scopeTabId,
    threadIdRef,
    workspaceTargets,
  });

  // ── Resolve repo path for orchestrator stream ──
  useEffect(() => {
    if (repoPathProp) {
      setResolvedRepoPath(repoPathProp);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await ipcFetch('/api/panel/repos');
        if (res.ok && !cancelled) {
          const data = await res.json() as { repos?: Array<{ localPath: string }> };
          const path = data.repos?.[0]?.localPath ?? null;
          if (path) setResolvedRepoPath(path);
        }
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [repoPathProp]);

  useEffect(() => {
    orchestratorSessionRef.current = null;
    singleRuntimeSessionRef.current = null;
    singleRuntimeLaunchPromiseRef.current = null;
  }, [resolvedRepoPath, singleRuntime]);

  const resolveRuntimeRepoPath = useCallback(async () => {
    if (resolvedRepoPath) return resolvedRepoPath;
    if (repoPathProp) return repoPathProp;
    try {
      const res = await fetch('/api/panel/repos');
      if (!res.ok) return null;
      const data = await res.json() as { repos?: Array<{ localPath: string }> };
      return data.repos?.[0]?.localPath ?? null;
    } catch {
      return null;
    }
  }, [repoPathProp, resolvedRepoPath]);

  const ensureSingleRuntimeSession = useCallback(async (initialMessage?: string): Promise<{ sessionKey: string; launched: boolean } | null> => {
    if (singleRuntimeSessionRef.current) {
      return { sessionKey: singleRuntimeSessionRef.current, launched: false };
    }
    if (singleRuntimeLaunchPromiseRef.current) {
      const sessionKey = await singleRuntimeLaunchPromiseRef.current;
      return sessionKey ? { sessionKey, launched: false } : null;
    }

    const launchPromise = (async () => {
      const repoPath = await resolveRuntimeRepoPath();
      if (!repoPath) return null;
      const runtimeLabel = orchestratorRuntimeTone(singleRuntime).label;
      const prompt = initialMessage?.trim() || `You are ${runtimeLabel} running as a single-runtime o8 workspace chat. Acknowledge ready.`;
      let receiptUnsettled = false;
      try {
        setSingleRuntimeSpawning(true);
        const { response: launchRes, payload: data } = await fetchRuntimeLaunchReceipt({
          runtime: singleRuntime,
          prompt,
          repoPath,
          cwd: repoPath,
          taskName: initialMessage?.trim() || undefined,
          skipSetup: true,
        });
        if (!launchRes.ok || !data?.ok || !data.surfaceId) {
          // A dead launch must SAY SO — on a plain non-git folder every spawn
          // failed and the chat just sat silent (#1551). Surface the server's
          // actual reason as a system line so the operator is never guessing.
          const reason = (data?.error || data?.note || '').trim();
          setChatMessages((prev) => [
            ...prev,
            {
              id: `local-error-${Date.now()}`,
              role: 'system',
              text: reason
                ? `Couldn't start the ${orchestratorRuntimeTone(singleRuntime).label} session: ${reason}`
                : `Couldn't start the ${orchestratorRuntimeTone(singleRuntime).label} session — the launch failed with no reason given. Check the runtime is installed and try again.`,
              timestamp: Date.now(),
              timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            },
          ]);
          return null;
        }
        singleRuntimeSessionRef.current = data.surfaceId;
        return data.surfaceId;
      } catch (err) {
        if (correlatedActionIsUnsettled(err)) {
          receiptUnsettled = true;
          throw err;
        }
        setChatMessages((prev) => [
          ...prev,
          {
            id: `local-error-${Date.now()}`,
            role: 'system',
            text: `Couldn't start the ${orchestratorRuntimeTone(singleRuntime).label} session: ${err instanceof Error ? err.message : 'network error'}`,
            timestamp: Date.now(),
            timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
        return null;
      } finally {
        if (!receiptUnsettled) setSingleRuntimeSpawning(false);
        singleRuntimeLaunchPromiseRef.current = null;
      }
    })();

    singleRuntimeLaunchPromiseRef.current = launchPromise;
    const sessionKey = await launchPromise;
    return sessionKey ? { sessionKey, launched: true } : null;
  }, [resolveRuntimeRepoPath, singleRuntime]);

  // ── Reuse an idle orchestrator session on mount ──
  useEffect(() => {
    if (!open || suppressRuntimePrewarm || !isOrchestratorMode || !orchestrationSettingsLoaded || isChatMode || orchestratorSessionRef.current) return;

    let cancelled = false;
    (async () => {
      let repoPath = resolvedRepoPath;
      if (!repoPath) {
        try {
          const res = await ipcFetch('/api/panel/repos');
          if (res.ok) {
            const data = await res.json() as { repos?: Array<{ localPath: string }> };
            repoPath = data.repos?.[0]?.localPath ?? null;
          }
        } catch { /* silent */ }
      }
      if (!repoPath || cancelled) return;

      try {
        const invRes = await fetch('/api/runtime/inventory?fresh=1');
        if (invRes.ok && !cancelled) {
          const invData = await invRes.json() as { agents?: Array<{ sessionKey: string; runtime: string; status: string; workspace: string }> };
          const existing = findIdleOrchestratorSession(invData.agents ?? [], repoPath);
          if (existing) {
            orchestratorSessionRef.current = existing.sessionKey;
            return;
          }
        }
      } catch { /* silent */ }

      // Opening a conversation is observation. Runtime creation belongs to
      // the normal send path after the operator submits their request.
    })();
    return () => { cancelled = true; };
  }, [isChatMode, isOrchestratorMode, open, orchestrationSettingsLoaded, resolvedRepoPath, suppressRuntimePrewarm]);

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const showDraftClearedToast = useComposerDraftLifecycle({ open, input, draftInjection, contextualConversation, ownerTabId: scopeTabId, setInput, setPreEnhanceInput, inputRef });

  // Right-click "Add to chat" on an inline o8.md image relays here (via the
  // dashboard, so only the VISIBLE tab consumes it). Apply once per id (ref
  // guard) and tell the dashboard to clear it — the image lands in exactly one
  // composer and never duplicates on tab refocus.
  const appliedImageInjectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !imageInjection?.id) return;
    if (appliedImageInjectionRef.current === imageInjection.id) return;
    appliedImageInjectionRef.current = imageInjection.id;
    addAttachedImage({ name: imageInjection.name, dataUri: imageInjection.dataUri, mimeType: imageInjection.mimeType });
    onImageInjectionConsumed?.();
  }, [open, imageInjection?.id, imageInjection?.name, imageInjection?.dataUri, imageInjection?.mimeType, addAttachedImage, onImageInjectionConsumed]);
  useEffect(() => {
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      if (pollDelayRef.current !== null) window.clearTimeout(pollDelayRef.current);
      if (pollAbortRef.current !== null) pollAbortRef.current.abort();
      if (exportFeedbackTimerRef.current !== null) window.clearTimeout(exportFeedbackTimerRef.current);
    };
  }, []);

  const clearPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (pollDelayRef.current !== null) {
      window.clearTimeout(pollDelayRef.current);
      pollDelayRef.current = null;
    }
    // Drop the in-flight transcript request too — clearing the timer alone
    // leaves a stalled fetch holding its socket open.
    if (pollAbortRef.current !== null) {
      pollAbortRef.current.abort();
      pollAbortRef.current = null;
    }
  }, []);

  const setExportFeedback = useCallback((next: 'idle' | 'copying' | 'copied' | 'error') => {
    setExportState(next);
    if (exportFeedbackTimerRef.current !== null) {
      window.clearTimeout(exportFeedbackTimerRef.current);
      exportFeedbackTimerRef.current = null;
    }
    if (next === 'copied' || next === 'error') {
      exportFeedbackTimerRef.current = window.setTimeout(() => {
        setExportState('idle');
        exportFeedbackTimerRef.current = null;
      }, 1800);
    }
  }, []);

  const transcriptUrl = useCallback((sessionKey: string) => {
    if (isRuntimeSessionKey(sessionKey)) {
      return `/api/runtime/transcript?sessionKey=${encodeURIComponent(sessionKey)}&limit=20`;
    }
    return `/api/mobile/history?sessionKey=${encodeURIComponent(sessionKey)}&limit=20&fresh=1`;
  }, []);

  const captureServerSnapshot = useCallback(async (sessionKey: string) => {
    try {
      const res = await fetchWithLongLivedBudget(transcriptUrl(sessionKey));
      if (!res.ok) return;
      const data = await res.json();
      const entries = (data.transcript ?? data.entries ?? []) as MobileTranscriptEntry[];
      const nextSeen = new Map<string, string>();
      for (const entry of entries) {
        nextSeen.set(entry.id, entrySignature(entry));
      }
      seenServerEntriesRef.current = nextSeen;
    } catch {
      // silent
    }
  }, [transcriptUrl]);

  const isOwnedRuntimeSession = useCallback((sessionKey: string) => (
    sessionKey.startsWith('codex-owned:')
    || sessionKey.startsWith('gemini-owned:')
    || sessionKey.startsWith('opencode-owned:')
  ), []);

  // Owned CLI sessions unlock only after inventory says they can resume; a
  // transcript tail alone can arrive before the next steer is accepted.
  const checkOwnedSessionReady = useCallback(async (sessionKey: string) => {
    try {
      const res = await fetch('/api/runtime/inventory');
      if (!res.ok) return false;
      const data = await res.json();
      const agents = Array.isArray(data?.agents) ? data.agents : [];
      const agent = agents.find((entry: { sessionKey?: string }) => entry?.sessionKey === sessionKey);
      const availability = agent?.runtimeSurface?.lifecycle?.availability;
      const sendInput = agent?.runtimeSurface?.capabilities?.sendInput;
      return availability === 'ready-for-resume' || sendInput === true;
    } catch {
      return false;
    }
  }, []);

  const startPollingForSession = useCallback((sessionKey: string) => {
    clearPolling();
    responseSeenRef.current = false;
    idlePollsRef.current = 0;

    let attempts = 0;
    const maxAttempts = 60;
    const requiresReadiness = isOwnedRuntimeSession(sessionKey);

    const finishPolling = () => {
      clearPolling();
      setWaitingForReply(false);
    };

    const poll = async () => {
      if (!openRef.current) {
        clearPolling();
        return;
      }
      attempts++;
      if (attempts > maxAttempts) {
        finishPolling();
        return;
      }

      // Cancel any still-in-flight tick before starting a new one so a stalled
      // transcript read can't pile up open sockets.
      pollAbortRef.current?.abort();
      const controller = new AbortController();
      pollAbortRef.current = controller;

      try {
        const res = await fetchWithLongLivedBudget(transcriptUrl(sessionKey), { signal: controller.signal });
        if (!res.ok) return;

        const data = await res.json();
        const entries = (data.transcript ?? data.entries ?? []) as MobileTranscriptEntry[];
        const nextSeen = new Map(seenServerEntriesRef.current);
        const incoming: MobileTranscriptEntry[] = [];

        for (const entry of entries) {
          const signature = entrySignature(entry);
          const previousSignature = nextSeen.get(entry.id);
          nextSeen.set(entry.id, signature);

          if (previousSignature === signature) continue;
          if (entry.role === 'user') continue;
          if (!isRenderableThoughtEntry(entry)) continue;
          incoming.push(entry);
        }

        seenServerEntriesRef.current = nextSeen;

        if (incoming.length > 0) {
          responseSeenRef.current = true;
          idlePollsRef.current = 0;
          setChatMessages((prev) => mergeTranscriptEntries(prev, incoming));
          return;
        }

        if (responseSeenRef.current) {
          idlePollsRef.current += 1;
          if (idlePollsRef.current >= 4) {
            if (requiresReadiness) {
              const ready = await checkOwnedSessionReady(sessionKey);
              if (!ready) {
                idlePollsRef.current = 3;
                return;
              }
            }
            finishPolling();
          }
        }
      } catch {
        // silent retry
      }
    };

    pollDelayRef.current = window.setTimeout(() => {
      void poll();
      pollRef.current = window.setInterval(() => {
        void poll();
      }, 2000);
    }, 400);
  }, [checkOwnedSessionReady, clearPolling, isOwnedRuntimeSession, transcriptUrl]);

  const startPolling = useCallback(() => {
    const sessionKey = isOrchestratorMode ? orchestratorSessionRef.current : targetSessionKey;
    if (!sessionKey) {
      setWaitingForReply(false);
      return;
    }
    startPollingForSession(sessionKey);
  }, [isOrchestratorMode, startPollingForSession, targetSessionKey]);

  const previousConnectionOpenRef = useRef(open);
  useEffect(() => {
    const wasOpen = previousConnectionOpenRef.current;
    previousConnectionOpenRef.current = open;
    if (wasOpen && !open) {
      clearPolling();
      chatStreamRequest.abort('inactive');
      return;
    }
    if (!wasOpen && open && waitingForReply && !isChatMode) {
      startPolling();
    }
  }, [chatStreamRequest, clearPolling, isChatMode, open, startPolling, waitingForReply]);

  const resetRemoteSession = useCallback(async (targetThreadId: string | null) => {
    if (!targetThreadId) return false;
    try {
      const response = await fetch('/api/orchestrator/reset-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath: resolvedRepoPath, threadId: targetThreadId }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }, [resolvedRepoPath]);

  const handleReset = useCallback((retainedDraftThreadId?: string) => {
    if (!retainedDraftThreadId) setInput('');
    backendSwitch.reset();
    setPreEnhanceInput(null);
    setChatMessages([]);
    resetThreadHistoryWindow();
    setPlanText(null);
    setWaitingForReply(false);
    clearPolling();
    seenServerEntriesRef.current.clear();
    responseSeenRef.current = false;
    idlePollsRef.current = 0;
    orchStream.reset();
    // A fresh conversation drops any thread-adopted backend back to the
    // operator default (explicit user picks stay).
    if (backendSourceRef.current === 'thread') {
      backendSourceRef.current = 'default';
      setOrchestratorBackend(resolveActiveComposerBackend(operatorDefaults));
    }
    setActiveThreadBackend(composerBackendTurnOverride(orchestratorBackend) ?? null);
    setActiveThreadAgent(null);
    setThreadProjectId(projectIdProp ?? null);
    // #597 minted a fresh threadId AND eagerly persisted an empty placeholder
    // file "so History shows the slot before typing" — but the list route now
    // HIDES empty unpinned threads (and GCs them after an hour), so the eager
    // file was invisible churn: every reset trigger (thread deleted while
    // open, mission rotation, /clear) wrote a junk thoughts-*.json. The id
    // still mints here; the FILE is written by the persist effect on the
    // first real message.
    const placeholderId = retainedDraftThreadId ?? (isOrchestratorMode ? `thoughts-${Date.now()}` : `chat-${Date.now()}`);
    threadIdRef.current = placeholderId;
    setThreadId(placeholderId);
    autoRestoreAttemptedRef.current = true;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('o8:orchestrator:auto-restore-suppressed', '1');
    }
    cancelPendingPersist();
    singleRuntimeSessionRef.current = null;
    singleRuntimeLaunchPromiseRef.current = null;
    setTimeout(() => inputRef.current?.focus(), 50);
    return placeholderId;
  }, [setInput, backendSwitch, resetThreadHistoryWindow, clearPolling, orchStream, orchestratorBackend, projectIdProp, isOrchestratorMode, cancelPendingPersist, operatorDefaults]);

  const handleEnhance = useCallback(async () => {
    if (!input.trim() || enhancing) return;
    const ownsDraft = captureDraftOwner();
    enhancementOwner.current = ownsDraft;
    setEnhancing(true);
    setPreEnhanceInput(input);
    try {
      const res = await fetch('/api/mobile/enhance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: input }),
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.enhanced === 'string' && data.enhanced && ownsDraft()) setInput(current => current === input ? data.enhanced : current);
      }
    } catch {
      // silently fail
    } finally {
      setEnhancing(false);
    }
  }, [input, enhancing, setInput, captureDraftOwner]);

  const handleUndoEnhance = useCallback(() => {
    if (preEnhanceInput !== null && enhancementOwner.current?.()) {
      setInput(preEnhanceInput);
      setPreEnhanceInput(null);
    }
  }, [preEnhanceInput, setInput]);

  // ── Thread persistence ──

  useEffect(() => {
    if (!isOrchestratorMode || isChatMode || orchStream.messages.length === 0) return;
    if (!orchStream.messages.some((entry) => entry.role !== 'system')) return;
    // Keep the restored transcript while syncing the current live turn into
    // retained state. Replacing this state with the stream repeated #1839 one
    // effect earlier than the display resolver could repair it.
    setChatMessages((prev) => resolveDisplayMessages({
      historyEntries: [],
      chatMessages: prev,
      streamMessages: orchStream.messages,
    }));
  }, [isChatMode, isOrchestratorMode, orchStream.messages]);

  useEffect(() => {
    if (!isOrchestratorMode) return;

    // Persist the same composed transcript that the panel renders. Persisting
    // the live stream alone could temporarily overwrite restored history with
    // one new event before retained state caught up.
    const msgs = resolveDisplayMessages({
      historyEntries: [],
      chatMessages,
      streamMessages: orchStream.messages,
    });

    // If a thread already has a placeholder row (minted on + New), keep
    // writing even while empty so History reflects reality. Once a user
    // message arrives, the title auto-upgrades on the list endpoint.
    if (!threadIdRef.current) {
      if (msgs.length === 0) return;
      const hasUserMessage = msgs.some((m) => m.role === 'user');
      if (!hasUserMessage) return;
      const newId = `thoughts-${Date.now()}`;
      threadIdRef.current = newId;
      setThreadId(newId);
      persistThread(msgs, newId, planText);
      return;
    }

    persistThread(msgs, threadIdRef.current, planText);
  }, [chatMessages, orchStream.messages, isOrchestratorMode, persistThread, planText]);

  const autoRestoreAttemptedRef = useRef(false);
  const AUTO_RESTORE_SUPPRESSED_KEY = 'o8:orchestrator:auto-restore-suppressed';
  // #1459 — live view of "has the user done anything yet". The auto-restore
  // guard below is checked when the effect fires (transcript empty at mount),
  // but its fetches can resolve SECONDS later while the post-relaunch server
  // is still booting. A send in that window appends the user bubble and mints
  // a threadId; applying the restore afterwards would clobber the bubble (and
  // any delivery-failure entry) and re-route the live turn — the observed
  // "sent and nothing happened" total silence.
  const transcriptTouchedRef = useRef(false);
  useEffect(() => {
    transcriptTouchedRef.current = orchStream.messages.length > 0 || chatMessages.length > 0 || Boolean(input || attachedImages.length || attachedFiles.length);
  }, [orchStream.messages, chatMessages, input, attachedImages.length, attachedFiles.length]);
  useEffect(() => {
    if (suppressAutoRestore) return;
    if (!isOrchestratorMode || isChatMode) return;
    if (autoRestoreAttemptedRef.current) return;
    if (orchStream.messages.length > 0 || chatMessages.length > 0) return;
    autoRestoreAttemptedRef.current = true;
    if (typeof window !== 'undefined' && window.localStorage.getItem(AUTO_RESTORE_SUPPRESSED_KEY) === '1') {
      window.localStorage.removeItem(AUTO_RESTORE_SUPPRESSED_KEY);
      return;
    }
    void (async () => {
      try {
        const res = await fetch('/api/v2/chat-history/list?include=orchestrator');
        if (!res.ok) return;
        const data = await res.json() as ThoughtsHistoryListResponse;
        const thoughtsThreads = (data.conversations ?? [])
          .filter((t) => t.tabId.startsWith('thoughts-'))
          .sort((a, b) => new Date(b.modifiedAt ?? 0).getTime() - new Date(a.modifiedAt ?? 0).getTime());
        if (thoughtsThreads.length === 0) return;

        const latest = thoughtsThreads[0];
        // Recovery window: only auto-restore if the thread was modified within
        // the last 60s (i.e. accidental reload mid-conversation). Anything
        // older = fresh start; the History sidebar handles intentional resume.
        const modifiedAt = latest.modifiedAt ? new Date(latest.modifiedAt).getTime() : 0;
        const ageMs = Date.now() - modifiedAt;
        if (!modifiedAt || ageMs > 60_000) {
          console.log(`[orchestrator] Skipping auto-restore — latest thread is ${Math.round(ageMs / 1000)}s old (>60s threshold)`);
          return;
        }

        const histRes = await fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(latest.tabId)}`);
        if (!histRes.ok) return;
        const histData = await histRes.json() as ThoughtsHistoryResponse;
        const msgs = mapHistoryMessagesToTranscript(histData.messages ?? [], histData.pendingTurnWorkers);
        // Hard cap: never auto-restore a thread above 100 messages — the user
        // almost certainly didn't want yesterday's giant thread paged back in
        // every reload. They can still pick it up explicitly from History.
        if (msgs.length > 100) {
          console.log(`[orchestrator] Skipping auto-restore — latest thread has ${msgs.length} messages (>100 cap)`);
          return;
        }
        // #1459 — re-check AFTER the awaits: if a send landed (bubble appended
        // and/or threadId minted) while the restore fetches were in flight,
        // applying the restore now would eat the user's message and re-route
        // the in-flight turn. The user acted first — they win; History still
        // offers the old thread explicitly.
        if (!shouldApplyAutoRestoreAfterFetch({
          transcriptTouched: transcriptTouchedRef.current,
          threadId: threadIdRef.current,
        })) {
          console.log('[orchestrator] Skipping auto-restore — user activity landed while restore was in flight (#1459)');
          return;
        }
        setPlanText(histData.planText ?? null);
        setThreadProjectId(histData.projectId ?? latest.projectId ?? null);
        setActiveThreadBackend(histData.backend ?? latest.backend ?? null);
        setActiveThreadAgent(histData.agent ?? latest.agent ?? null);
        if (msgs.length > 0) {
          setChatMessages(msgs);
          orchStream.replaceTranscript(msgs);
          threadIdRef.current = latest.tabId;
          setThreadId(latest.tabId); setHistoryCompleteId(latest.tabId);
        }
      } catch {
        // silent
      }
    })();
  }, [chatMessages.length, isChatMode, isOrchestratorMode, orchStream, suppressAutoRestore]);

  const { showClearToast, handleClearCommand } = useClearCommand({
    isOrchestratorMode,
    orchStreamMessages: orchStream.messages,
    orchStreamPlanText: orchStream.planText,
    chatMessages,
    planText,
    threadIdRef,
    resolvedRepoPath,
    persistThreadNow,
    cancelPendingPersist,
    handleReset,
  });

  const { notice: reloadNotice, dismiss: dismissReloadNotice } = useOrchestratorReloadNotice(
    isOrchestratorMode ? resolvedRepoPath : null, threadId,
  );

  const prependThreadHistoryPage = useCallback((historyMessages: ThoughtsHistoryMessage[]) => {
    suppressNextTranscriptAutoScrollRef.current = true;
    return prependHistoryMessages(historyMessages);
  }, [prependHistoryMessages]);

  const getTranscriptScrollContainer = useCallback(() => chatEndRef.current?.closest('.thoughts-scroll') as HTMLElement | null, []);
  const { startBackfill, cancelBackfill, onScroll: loadOlderHistoryOnScroll } = useThreadHistoryBackfill({
    fetchPage: fetchOlderThreadPage,
    getScrollContainer: getTranscriptScrollContainer,
    onPrepend: prependThreadHistoryPage,
    onComplete: setHistoryCompleteId,
  });
  const loadTranscriptRef = useRef({ stream: orchStream.messages, retained: chatMessages });
  loadTranscriptRef.current = { stream: orchStream.messages, retained: chatMessages };
  const handleLoadThread = useCallback(async (tabId: string) => {
    const now = Date.now();
    if (inFlightLoadKeyRef.current === tabId) return;
    if (lastLoadKeyRef.current === tabId && now - lastLoadAtRef.current < 800) {
      return;
    }
    inFlightLoadKeyRef.current = tabId;
    lastLoadKeyRef.current = tabId;
    lastLoadAtRef.current = now;
    const myGeneration = ++loadGenerationRef.current;
    cancelBackfill(); setHistoryCompleteId(null);
    resetThreadHistoryWindow();
    try {
      let res = await fetchThreadHistoryPage(tabId);
      if (!res || !res.ok) res = await fetchThreadHistoryPage(tabId);
      if (!res || !res.ok) {
        // Loud on purpose: a silent return here leaves the tab wearing the
        // thread's TITLE over an empty transcript (stale-header class).
        console.warn(`[orchestrator] loadThread ${tabId} — history fetch failed twice (server booting?)`);
        return;
      }
      const data = await res.json() as ThoughtsHistoryResponse;
      // A newer loadThread started while this one was awaiting the network — its
      // results are stale and must NOT overwrite the newer thread's state.
      if (loadGenerationRef.current !== myGeneration) {
        console.log(`[orchestrator] loadThread ${tabId} — superseded by a newer load, discarding`);
        return;
      }
      const msgs = mapHistoryMessagesToTranscript(data.messages ?? [], data.pendingTurnWorkers);
      console.log(`[orchestrator] loadThread ${tabId} — applying ${msgs.length} messages`);
      const isSameOpenThread = threadIdRef.current === tabId;
      const currentTranscript = loadTranscriptRef.current;
      const liveTranscript = currentTranscript.stream.length > 0 ? currentTranscript.stream : currentTranscript.retained;
      const mergedLoad = isSameOpenThread
        ? mergeSameThreadHistoryLoad(liveTranscript, msgs)
        : { entries: msgs, preservedLiveEntries: false };
      // RC1 seam 2 — never reset() a live in-flight turn on a same-thread load.
      // reset() bumps the stream epoch + nulls the assistant, and the durable
      // server turn's remaining answer tokens are then discarded. A same-thread
      // (esp. busy) load is merge-only; only a genuine thread switch resets.
      const loadPlan = resolveThreadLoadPlan({
        isSameOpenThread,
        streamBusy: orchStream.status === 'busy',
        merged: mergedLoad,
      });
      setChatMessages(loadPlan.entries);
      setPlanText(data.planText ?? null);
      setThreadProjectId(data.projectId ?? null);
      setActiveThreadBackend(data.backend ?? null);
      setActiveThreadAgent(data.agent ?? null);
      // Continue the conversation where it lives: adopt the thread's stored
      // backend for the next turn (chip + send both follow) unless the user
      // explicitly picked one this session. Not persisted — the operator
      // default is untouched; new sessions still start on it. `acp` is the
      // one OrchestratorBackendId with no composer setting — map it to its
      // hermes surface name.
      const adoptable: OrchestratorBackendSetting | null = data.backend === 'acp' ? 'hermes' : (data.backend ?? null);
      if (adoptable && backendSourceRef.current !== 'user') {
        backendSourceRef.current = 'thread';
        setOrchestratorBackend(adoptable);
      }
      threadIdRef.current = tabId;
      setThreadId(tabId);
      setWaitingForReply(false);
      clearPolling();
      if (loadPlan.reset) {
        orchStream.reset();
      }
      orchStream.replaceTranscript(loadPlan.entries);
      // A thread reload replaces the transcript wholesale, so deliver any
      // pending Mission-complete card owned by this exact loaded thread.
      if (isOrchestratorMode) {
        const missionCards = getPendingMissionCards(resolvedRepoPath, tabId);
        if (missionCards.length > 0) orchStream.appendLocalEntries(missionCards);
      }
      seenServerEntriesRef.current.clear();
      orchestratorSessionRef.current = null;
      singleRuntimeSessionRef.current = null;
      singleRuntimeLaunchPromiseRef.current = null;
      startBackfill(tabId, data.page);
      setTimeout(() => inputRef.current?.focus(), 50);
    } catch {
      // silent
    } finally {
      // Clear in-flight only if we still own the slot for this tabId —
      // a late-completing load shouldn't unblock a newer load that
      // already claimed the slot for a different tabId.
      if (inFlightLoadKeyRef.current === tabId) {
        inFlightLoadKeyRef.current = null;
      }
    }
  }, [cancelBackfill, clearPolling, orchStream, isOrchestratorMode, resolvedRepoPath, resetThreadHistoryWindow, startBackfill]);

  settledAssistantRefetchRef.current = () => {
    const activeThreadId = threadIdRef.current;
    if (!activeThreadId) return;
    lastLoadKeyRef.current = null;
    lastLoadAtRef.current = 0;
    void handleLoadThread(activeThreadId);
  };
  // Turns the operator adds in the Codex app (#3573) reach history through the
  // ws-server. Reload this chat when one arrives for it, unless a turn is
  // streaming here; that turn's own settle reloads the thread.
  const orchestratorBusyRef = useRef(false);
  orchestratorBusyRef.current = orchStream.status === 'busy';
  useEffect(() => {
    const onThreadEvent = (event: Event) => {
      const detail = (event as CustomEvent<{ event?: string; data?: { threadId?: string } }>).detail;
      if (detail?.event !== 'external-turns' || detail.data?.threadId !== threadIdRef.current) return;
      if (orchestratorBusyRef.current) return;
      settledAssistantRefetchRef.current();
    };
    window.addEventListener('o8:orchestrator-threads', onThreadEvent);
    return () => window.removeEventListener('o8:orchestrator-threads', onThreadEvent);
  }, []);
  const suggestions = useMemo(
    () => generateSuggestions(agents.filter(isRunnableCliSession), sessionTargets),
    [agents, sessionTargets],
  );
  const displayMessages = useMemo(() => resolveVisibleChatMessages({
    isOrchestratorMode, isChatMode, historyEntries: threadHistoryEntries, chatMessages, streamMessages: orchStream.messages,
  }), [chatMessages, isChatMode, isOrchestratorMode, orchStream.messages, threadHistoryEntries]);
  useTranscriptAutoScroll({ endRef: chatEndRef, suppressRef: suppressNextTranscriptAutoScrollRef,
    historyComplete: !isOrchestratorMode || historyCompleteId === threadId, messageIds: displayMessages.map(message => message.id),
    scope: (isOrchestratorMode ? threadId : targetSessionKey) ? JSON.stringify([resolvedRepoPath, isOrchestratorMode ? 'thread' : 'session', isOrchestratorMode ? threadId : targetSessionKey]) : null });
  const backendMessages = useMemo(() => displayMessages.filter(message => !message.voice), [displayMessages]);
  useEffect(() => {
    const latestAssistant = [...displayMessages].reverse().find((message) => message.role === 'assistant' && !message.voice);
    latestAssistantBackendRef.current = latestAssistant?.backend ?? null;
    backendSwitch.observeLatestBackend(latestAssistant?.backend ?? null);
  }, [backendSwitch, displayMessages]);
  // See `composerRepoLabelBase` for the rationale — derived here so
  // the empty-state check matches the empty-state-override condition.
  const composerRepoLabel = displayMessages.length === 0 ? null : composerRepoLabelBase;
  const displayWaiting = isChatMode ? false : isOrchestratorMode ? orchStream.status === 'busy' : (waitingForReply || (isSingleMode && singleRuntimeSpawning));
  const displayPlanText = isOrchestratorMode && !isChatMode && planText?.trim() ? planText.trim() : null;
  const hasAssistantActivity = displayMessages.some((message) => message.role !== 'user');
  const activeBackendIdentity = isOrchestratorMode
    ? (composerBackendTurnOverride(orchestratorBackend) ?? orchestratorBackend ?? activeThreadBackend ?? null)
    : null;
  const activeBackendLabel = activeBackendIdentity
    // No agent: the composer chip predicts the NEXT turn, and sends carry no
    // agent — ws-server resolves the backend's DEFAULT. Passing the loaded
    // thread's historical agent (e.g. an old OpenClaw 'mister-scribe' thread)
    // mislabels a turn that will actually run as the default agent (adversarial
    // review 2026-07-15). The label falls back to the default (OpenClaw → 'main').
    ? orchestratorBackendDisplayLabel({ backend: activeBackendIdentity, agent: null })
    : null;
  // A requested history owns its draft before its binding is ready to send.
  // Keep sends blocked and the backend label pending until that history
  // lands (threadId flips non-null). See expectsThreadLoad prop doc.
  const threadBindingPending = expectsThreadLoad && threadId === null;
  const activeTargetLabel = isChatMode
    ? selectedChatModel.label
    : isSingleMode
      ? orchestratorRuntimeTone(singleRuntime).label
      : isOrchestratorMode
        ? (threadBindingPending ? '…' : activeBackendLabel ?? 'Claude Code')
        : (targetAgent?.name ?? orchestratorRuntimeTone(preferredRuntime).label);
  const activeTargetColor = isSingleMode
    ? orchestratorRuntimeTone(singleRuntime).color
    : isOrchestratorMode
      ? '#e07a3a'
      : (targetAgent?.color ?? orchestratorRuntimeTone(preferredRuntime).color);
  // #771 — Augment Intent-style chip row under the last assistant message.
  // Only fires in orchestrator mode; CLI lanes still steer via the composer.
  const {
    lastAssistantId: suggestedReplyMessageId,
    chipsForLastAssistant,
    isDismissedForLastAssistant: suggestedRepliesCollapsed,
    isPlaceholderVisibleForLastAssistant: suggestedRepliesPending,
    dismissChips: dismissSuggestedReplies,
    restoreChips: restoreSuggestedReplies,
  } = useSuggestedReplies({
    // Suggested-reply chips cut 2026-06-22 (operator: "i dont think we need
    // those"). Disabled at the source so the hook generates nothing and every
    // downstream prop stays wired (no dead-code ripple); flip back to
    // `isOrchestratorMode && !isChatMode` to restore.
    enabled: false,
    messages: displayMessages,
    isStreaming: displayWaiting,
  });

  // Memoize so a render triggered by composer state (input typing) doesn't
  // hand ChatMessageList a fresh `topContent` ref each keystroke.
  const transcriptTopContent = useMemo(() => displayPlanText ? <TranscriptPlan text={displayPlanText} threadId={threadId} /> : null, [displayPlanText, threadId]);

  useEffect(() => {
    onChromeChange({
      activeTargetLabel,
      waitingForReply: displayWaiting,
      hasMessages: displayMessages.length > 0,
      threadId,
      messageCount: displayMessages.length,
      orchestratorBusyState: orchStream.busyState,
    });
  }, [activeTargetLabel, displayMessages.length, displayWaiting, onChromeChange, orchStream.busyState, threadId]);

  // Fire onChatSummary whenever the latest user message changes in any chat
  // surface (orchestrator / chat / single runtime). The parent stashes it on
  // the tab record and the tab strip truncates it to ~3 words for the visible
  // label so the user can see at a glance what each tab is about.
  const lastReportedChatSummaryRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onChatSummary) return;
    const source = isOrchestratorMode && !isChatMode ? displayMessages : chatMessages;
    const latestUser = [...source].reverse().find((entry) => (
      entry.role === 'user' && entry.text.trim()
    ));
    const text = latestUser?.text?.trim() ?? '';
    if (!text || text === lastReportedChatSummaryRef.current) return;
    lastReportedChatSummaryRef.current = text;
    onChatSummary(text);
  }, [chatMessages, displayMessages, isChatMode, isOrchestratorMode, onChatSummary]);

  const turnSummary = useTurnSummaryReceipt({
    displayMessages: backendMessages,
    isChatMode,
    isOrchestratorMode,
    missionState,
    repoPath: resolvedRepoPath,
    stream: orchStream,
    threadId: threadIdRef.current ?? threadId,
  });

  // #587 — publish live transcript + running token total into the context
  // residency provider so the ContextInspector side panel (mounted at the
  // OrchestratorTab level) can render rows without prop-drilling.
  const residency = useOrchestratorContextResidency();
  useEffect(() => {
    if (!residency) return;
    if (!isOrchestratorMode || isChatMode) {
      residency.publish({ messages: [], runningTotal: 0, activeAssistantId: null });
      return;
    }
    let activeAssistantId: string | null = null;
    if (orchStream.status === 'busy') {
      for (let index = displayMessages.length - 1; index >= 0; index -= 1) {
        if (displayMessages[index]?.role === 'assistant' && !displayMessages[index]?.voice) {
          activeAssistantId = displayMessages[index].id;
          break;
        }
      }
    }
    residency.publish({
      messages: displayMessages,
      runningTotal: orchStream.runningTotal,
      activeAssistantId,
    });
  }, [displayMessages, isChatMode, isOrchestratorMode, orchStream.runningTotal, orchStream.status, residency]);

  // Ref used so sendNow() can flush the latest input value without a re-render.
  const latestInputRef = useRef('');
  useEffect(() => { latestInputRef.current = input; }, [input]);

  const sendOrchestrator = useCallback((message: string, options: OrchestratorSendOptions) => {
    const sendingThreadId = threadIdRef.current;
    return sendBoundComposerTurn(orchStream.send, message, options, {
      pickedMode: composerModeRef.current, requestContext: contextualConversation?.requestContext,
      handoffMode: backendSwitch.currentHandoffMode(), ensureSelectedRepoPersisted,
      restoreDraft: () => {
        if (threadIdRef.current !== sendingThreadId) return;
        setInput((draft) => draft ? `${message}\n\n${draft}` : message);
        for (const image of options.attachments ?? []) addAttachedImage({ name: image.name ?? 'Image', dataUri: image.dataUri,
          mimeType: image.dataUri.match(/^data:([^;]+);/)?.[1] ?? 'image/png' });
      },
      resolveOptions: (signal) => resolveFreshComposerTurnOptions({ repoPath: resolvedRepoPath, backend: orchestratorBackend,
        localModel: contextualConversation ? orchestratorModel : undefined, backendSourceRef, setBackend: setOrchestratorBackend,
        setModel: setOrchestratorModel, setOperatorDefaults }, signal, options),
    });
  }, [backendSwitch, orchStream, contextualConversation, ensureSelectedRepoPersisted, setInput, addAttachedImage, resolvedRepoPath, orchestratorBackend, orchestratorModel, setOrchestratorModel]);

  const slashAttachments = useMemo(() => attachedImages.length
    ? attachedImages.map(image => ({ dataUri: image.dataUri, name: image.name })) : undefined, [attachedImages]);
  const startSlashOrchestration = useSlashOrchestration(sendOrchestrator, {
    permissionMode, backend: composerBackendTurnOverride(orchestratorBackend), thinkingEffort, model: orchestratorModel,
    orchestrationMode: resolveComposerExecutionMode('multitask', soloOrchestrator), collide: collideEnabled,
    attachments: slashAttachments,
  });

  const runLocalOrchestratorSlash = useCallback(async (rawInput: string) => {
    if (!isOrchestratorMode || isChatMode) return false;

    const commandThreadId = threadIdRef.current;
    const commandGeneration = loadGenerationRef.current;
    const isCurrentThread = () => threadIdRef.current === commandThreadId && loadGenerationRef.current === commandGeneration;
    const parsedCommand = parseOrchestratorSlashCommand(rawInput);
    const suppressCommandEntries = parsedCommand?.command.name === 'clear';
    const handled = await executeOrchestratorSlashCommand(rawInput, {
      repoPath: resolvedRepoPath,
      transcript: displayMessages,
      missionState,
      runningTotal: orchStream.runningTotal,
      currentModel: orchestratorModel,
      setCurrentModel: (model) => { if (!contextualConversation) writeStoredOrchestratorModel(resolvedRepoPath, model); acceptOrchestratorModel(model); },
      replaceTranscript: (entries) => { if (isCurrentThread()) orchStream.replaceTranscript(entries); },
      compactNow: orchStream.compactNow,
      isCurrentThread,
      resetRemoteSession: () => isCurrentThread() ? resetRemoteSession(commandThreadId) : Promise.resolve(false),
      queuePrelude: (prelude, mode) => { if (isCurrentThread()) queueOrchestratorSessionPrelude(resolvedRepoPath, prelude, mode, commandThreadId); },
      searchArchive: (query, limit) => searchOrchestratorArchive(resolvedRepoPath, query, limit),
      fetchTelemetry: async () => {
        const snapshot = await orchStream.fetchTelemetrySnapshot();
        return { totalTokens: snapshot.totalTokens, estimatedCostUsd: snapshot.estimatedCostUsd, model: snapshot.model };
      },
      startOrchestration: startSlashOrchestration,
      appendEntries: suppressCommandEntries ? () => {} : (entries) => { if (isCurrentThread()) orchStream.appendLocalEntries(entries); },
      clearThread: handleClearCommand,
      // `/rule` posts directly; `/rules` opens the manager through window events.
      addSessionRule: async (text: string) => {
        const threadId = threadIdRef.current;
        if (!threadId) return false;
        try {
          const res = await fetch('/api/orchestrator/session-rules', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ threadId, text }),
          });
          const data = await res.json().catch(() => null) as { ok?: boolean } | null;
          if (data?.ok) {
            window.dispatchEvent(new CustomEvent('o8:session-rules-changed'));
            return true;
          }
        } catch { /* ignore */ }
        return false;
      },
      openRulesManager: () => window.dispatchEvent(new CustomEvent('o8:open-session-rules')), openPromptLibrary: () => window.dispatchEvent(new CustomEvent('o8:prompt-library:open')),
    });
    if (!handled.handled) return false;
    if (isCurrentThread()) {
      latestInputRef.current = '';
      if (parsedCommand?.command.name === 'visualization' && parsedCommand.args && resolvedRepoPath) clearAttachments();
    }
    return true;
  }, [
    contextualConversation,
    displayMessages,
    clearAttachments,
    handleClearCommand,
    isChatMode,
    isOrchestratorMode,
    missionState,
    orchStream,
    acceptOrchestratorModel,
    orchestratorModel,
    resetRemoteSession,
    resolvedRepoPath,
    startSlashOrchestration,
  ]);

  const handleTaskSend = useCallback(async (explicitText?: string) => {
    const rawMsg = (explicitText ?? input).trim();
    if (!rawMsg || threadBindingPending) return;
    // The mode directive goes to the model, while bubbles and auto-titles keep
    // the operator's exact words. Slash commands pass through untouched.
    const { displayMessage, wireMessage, orchestrationMode: turnOrchestrationMode } = composeComposerTurnMessage(rawMsg, composerModeRef.current, soloOrchestrator);

    track('orchestrator.message'); // coarse usage signal (analytics epic #1249) — no content

    // Mode-routing slash prefix (`/chat ...`, `/codex ...`, `/gemini ...`,
    // `/opencode ...`) — peel the prefix, stash the body for the spawned
    // tab to pick up on mount, and dispatch to the appropriate spawn
    // handler instead of dispatching on this tab. Only honor when the
    // tab is not lockedMode (Fleet-level Orchestrator tabs only).
    if (!lockedMode) {
      const routing = parseModeRoutingPrefix(wireMessage);
      if (routing) {
        if (routing.target.kind === 'single' && onSpawnSingleTab) {
          stashPendingComposerDraft(routing.target, routing.body);
          onSpawnSingleTab(routing.target.runtime);
          setInput('');
          latestInputRef.current = '';
          return;
        }
        if (routing.target.kind === 'chat' && onSpawnChatTab) {
          stashPendingComposerDraft(routing.target, routing.body);
          onSpawnChatTab();
          setInput('');
          latestInputRef.current = '';
          return;
        }
        if (routing.target.kind === 'fleet') {
          const body = routing.body.trim();
          if (!body) {
            setInput('');
            latestInputRef.current = '';
            return;
          }
          if (orchStream.status === 'busy') return;

          const attachments = attachedImages.length > 0
            ? attachedImages.map((img) => ({ dataUri: img.dataUri, name: img.name }))
            : undefined;
          setInput('');
          latestInputRef.current = '';
          sendOrchestrator(body, {
            permissionMode,
            backend: composerBackendTurnOverride(orchestratorBackend),
            thinkingEffort,
            model: orchestratorModel,
            orchestrationMode: resolveComposerExecutionMode('multitask', soloOrchestrator),
            collide: collideEnabled,
            ...(attachments ? { attachments } : {}),
          });
          clearAttachments();
          return;
        }
        // No spawn handler available — fall through and dispatch as a
        // normal Fleet message so the user isn't silently swallowed.
      }
    }

    const effectiveWaiting = isChatMode ? waitingForReply : isOrchestratorMode ? orchStream.status === 'busy' : waitingForReply;
    if (effectiveWaiting) return;

    if (isChatMode) {
      setInput('');
      latestInputRef.current = '';
      const userEntry = createChatUserEntry(displayMessage);
      const assistantEntry = createChatAssistantEntry(selectedChatModel, (userEntry.timestamp ?? Date.now()) + 1);
      let assistantText = '';
      setChatMessages((prev) => [...prev, userEntry, assistantEntry]);
      clearAttachments();
      setWaitingForReply(true);
      const streamController = chatStreamRequest.begin();
      try {
        // Chat-mode streams through scratch-chat; modelOverride pins the
        // per-tab picker choice server-side.
        await sendScratchChatMessage({
          history: chatMessages,
          message: wireMessage,
          context: resolvedRepoPath ? { repoPath: resolvedRepoPath } : undefined,
          enableTools: true,
          modelOverride: chatOpenrouterModel ?? null,
          signal: streamController.signal,
          onDelta: (text) => {
            assistantText += text;
            setChatMessages((prev) => prev.map((entry) => (
              entry.id === assistantEntry.id ? { ...entry, text: assistantText } : entry
            )));
          },
          onToolCall: (call) => {
            setChatMessages((prev) => prev.map((entry) => (
              entry.id === assistantEntry.id ? mergeToolCallIntoEntry(entry, call) : entry
            )));
          },
          onToolResult: (result) => {
            setChatMessages((prev) => prev.map((entry) => (
              entry.id === assistantEntry.id ? mergeToolResultIntoEntry(entry, result) : entry
            )));
          },
        });
      } catch (error) {
        const message = streamController.signal.aborted || isAbortError(error)
          ? 'Stream paused because this tab became inactive. Send again when you return.'
          : error instanceof Error ? error.message : 'Chat request failed.';
        setChatMessages((prev) => prev.map((entry) => (
          entry.id === assistantEntry.id
            ? { ...entry, text: assistantText ? `${assistantText}\n\n${message}` : message }
            : entry
        )));
      } finally {
        chatStreamRequest.finish(streamController);
        setWaitingForReply(false);
      }
      return;
    }

    if (isSingleMode) {
      setInput('');
      latestInputRef.current = '';

      const userMsg: MobileTranscriptEntry = {
        id: `local-user-${Date.now()}`,
        role: 'user',
        text: displayMessage,
        timestamp: Date.now(),
        timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setChatMessages((prev) => [...prev, userMsg]);
      clearAttachments();
      setWaitingForReply(true);

      try {
        const launch = await ensureSingleRuntimeSession(wireMessage);
        if (!launch?.sessionKey) {
          throw new Error('Unable to launch selected runtime');
        }
        const { sessionKey } = launch;
        await captureServerSnapshot(sessionKey);
        if (!launch.launched) {
          const { response, payload } = await fetchRuntimeSteerReceipt(sessionKey, wireMessage);

          if (!response.ok || payload?.ok === false) {
            const reason = payload?.note?.trim() || payload?.error?.trim();
            throw new Error(reason || 'Send failed');
          }
        }

        startPollingForSession(sessionKey);
      } catch (err) {
        const receiptUnsettled = correlatedActionIsUnsettled(err);
        const runtimeLabel = orchestratorRuntimeTone(singleRuntime).label;
        const rawMessage = err instanceof Error ? err.message.trim() : '';
        const fallback = `Unable to reach the selected ${runtimeLabel} lane. Make sure the runtime is available.`;
        setChatMessages((prev) => [
          ...prev,
          {
            id: `local-error-${Date.now()}`,
            role: 'system',
            text: rawMessage || fallback,
            timestamp: Date.now(),
            timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
        if (!receiptUnsettled) setWaitingForReply(false);
      }
      return;
    }

    const commandThreadId = threadIdRef.current;
    if (isOrchestratorMode && await runLocalOrchestratorSlash(wireMessage)) {
      if (threadIdRef.current === commandThreadId) setInput('');
      return;
    }

    if (isOrchestratorMode) {
      const attachments = attachedImages.length > 0
        ? attachedImages.map((img) => ({ dataUri: img.dataUri, name: img.name }))
        : undefined;
      const orchOptions = {
        permissionMode,
        backend: composerBackendTurnOverride(orchestratorBackend),
        thinkingEffort,
        model: orchestratorModel,
        wireMessage,
        orchestrationMode: turnOrchestrationMode,
        collide: collideEnabled,
        ...(attachments ? { attachments } : {}),
      };
      if (!resolvedRepoPath) {
        // No workspace — orchStream.send() appends a guiding "add a repo" notice.
        // KEEP the composer text so the user's message isn't lost to the void
        // (the fresh-user "I typed and nothing happened" trap). Leave the toggle
        // armed — nothing dispatched, so the clarify intent still stands.
        sendOrchestrator(displayMessage, { ...orchOptions, displayMessage });
        return;
      }
      setInput('');
      sendOrchestrator(displayMessage, { ...orchOptions, displayMessage });
      clearAttachments();
      return;
    }

    setInput('');

    const userMsg: MobileTranscriptEntry = {
      id: `local-user-${Date.now()}`,
      role: 'user',
      text: displayMessage,
      timestamp: Date.now(),
      timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setChatMessages((prev) => [...prev, userMsg]);
    clearAttachments();

    const sessionKey = targetSessionKey;
    if (!sessionKey) return;
    setWaitingForReply(true);

    try {
      await captureServerSnapshot(sessionKey);

      const isRuntimeSession = isRuntimeSessionKey(sessionKey);
      const { response, payload } = isRuntimeSession
        ? await fetchRuntimeSteerReceipt(sessionKey, wireMessage)
        : {
            response: await fetch('/api/mobile/action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'resume', sessionKey, message: wireMessage }),
            }),
            payload: null,
          };

      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.note || payload?.error || 'Send failed');
      }

      startPolling();
    } catch (error) {
      const receiptUnsettled = correlatedActionIsUnsettled(error);
      const laneRuntimeLabel = targetAgent ? getRuntimeCapability(targetAgent.runtime).label : 'CLI';
      setChatMessages((prev) => [
        ...prev,
        {
          id: `local-error-${Date.now()}`,
          role: 'system',
          text: `Unable to reach the selected CLI lane. Make sure the ${laneRuntimeLabel} session is available.`,
          timestamp: Date.now(),
          timestampLabel: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        },
      ]);
      if (!receiptUnsettled) setWaitingForReply(false);
    }
  }, [threadBindingPending, input, soloOrchestrator, lockedMode, isChatMode, waitingForReply, isOrchestratorMode, orchStream.status, isSingleMode, runLocalOrchestratorSlash, setInput, clearAttachments, targetSessionKey, onSpawnSingleTab, onSpawnChatTab, attachedImages, sendOrchestrator, permissionMode, orchestratorBackend, thinkingEffort, orchestratorModel, collideEnabled, selectedChatModel, chatStreamRequest, chatMessages, resolvedRepoPath, chatOpenrouterModel, ensureSingleRuntimeSession, captureServerSnapshot, startPollingForSession, singleRuntime, startPolling, targetAgent]);

  const sendNow = useCallback((text?: string, options?: ThoughtsSendNowOptions) => {
    const msg = (typeof text === 'string' ? text : latestInputRef.current).trim();
    if (!msg || threadBindingPending) return false;
    if (isChatMode) {
      if (waitingForReply) return false;
      setInput(msg);
      latestInputRef.current = msg;
      setTimeout(() => { void handleTaskSend(msg); }, 0);
      return true;
    }
    if (isOrchestratorMode) {
      if (orchStream.status === 'busy') return false;
      const commandThreadId = threadIdRef.current;
      void (async () => {
        if (await runLocalOrchestratorSlash(msg)) {
          if (threadIdRef.current === commandThreadId) {
            setInput('');
            latestInputRef.current = '';
          }
          return;
        }
        setInput('');
        latestInputRef.current = '';
        const attachments = options?.attachments ?? (attachedImages.length > 0
          ? attachedImages.map((img) => ({ dataUri: img.dataUri, name: img.name }))
          : undefined);
        const { displayMessage, wireMessage, orchestrationMode: turnOrchestrationMode } = composeComposerTurnMessage(msg, composerModeRef.current, soloOrchestrator);
        sendOrchestrator(displayMessage, {
          permissionMode,
          backend: composerBackendTurnOverride(orchestratorBackend),
          thinkingEffort,
          model: orchestratorModel,
          wireMessage,
          displayMessage,
          orchestrationMode: turnOrchestrationMode,
          collide: collideEnabled,
          ...(attachments ? { attachments } : {}),
        });
        if (!options?.attachments) clearAttachments();
      })();
      return true;
    }

    setInput(msg);
    latestInputRef.current = msg;
    setTimeout(() => { void handleTaskSend(msg); }, 0);
    return true;
  }, [threadBindingPending, isChatMode, isOrchestratorMode, setInput, waitingForReply, handleTaskSend, orchStream.status, runLocalOrchestratorSlash, attachedImages, soloOrchestrator, sendOrchestrator, permissionMode, orchestratorBackend, thinkingEffort, orchestratorModel, collideEnabled, clearAttachments]);

  // #1699 — interactive task artifacts attached to this thread. Their accepted
  // actions return through the same send path as a typed message, stamped so
  // the realtime server marks the receipt delivered on the exact thread.
  const { artifacts: taskArtifacts } = useTaskArtifacts({
    repoPath: resolvedRepoPath ?? null,
    threadId,
    enabled: isOrchestratorMode,
    transcriptLength: displayMessages.length,
  });
  const deliverTaskArtifactAction = useCallback((input: TaskArtifactDeliverInput): boolean => {
    if (threadBindingPending || !isOrchestratorMode || orchStream.status === 'busy') return false;
    const { wireMessage, orchestrationMode: turnOrchestrationMode } = composeComposerTurnMessage(input.wireMessage, composerModeRef.current, soloOrchestrator);
    track('orchestrator.message');
    sendOrchestrator(input.displayMessage, {
      permissionMode,
      backend: composerBackendTurnOverride(orchestratorBackend),
      thinkingEffort,
      model: orchestratorModel,
      wireMessage,
      displayMessage: input.displayMessage,
      orchestrationMode: turnOrchestrationMode,
      collide: collideEnabled,
      taskArtifactAction: { artifactId: input.artifactId, actionId: input.actionId },
    });
    return true;
  }, [threadBindingPending, collideEnabled, isOrchestratorMode, orchStream.status, orchestratorBackend, orchestratorModel, permissionMode, sendOrchestrator, soloOrchestrator, thinkingEffort]);

  const { dispatch: dispatchBufferedOrchestratorSend, capture: captureQueuedSend } = useBufferedOrchestratorSend({
    active: isOrchestratorMode, backend: orchestratorBackend, model: orchestratorModel, effort: thinkingEffort,
    permissionMode, mode: composerModeRef.current, solo: soloOrchestrator, collide: collideEnabled,
    projectId: threadProjectId, context: contextualConversation?.requestContext, send: sendOrchestrator,
  });

  const { sendBuffer, durable, handleSend: handleComposerSend, handleSteer, saving: queueSaving, attachmentError } = useDefaultComposerSendBuffer({
    active: isOrchestratorMode, backend: orchestratorBackend, blocked: threadBindingPending,
    capabilityBackend: collideEnabled && resolveComposerExecutionMode(composerMode, soloOrchestrator) !== 'single' ? 'collide' : orchestratorBackend,
    busy: displayWaiting,
    threadId,
    repoPath: resolvedRepoPath,
    attachedImages, uploadError, uploading,
    latestInputRef,
    inputRef,
    setInput,
    addAttachedImage,
    clearAttachments,
    dispatch: dispatchBufferedOrchestratorSend, captureQueuedSend,
    interrupt: orchStream.interrupt,
    undoSend: orchStream.undoSend,
    shouldBypass: (text) => Boolean(parseOrchestratorSlashCommand(text) || parseModeRoutingPrefix(text)),
    sendUnbuffered: (text) => { void handleTaskSend(text); },
  });
  const onContextBusyChange = contextualConversation?.onBusyChange;
  useEffect(() => { onContextBusyChange?.(displayWaiting || sendBuffer.undoArmed || sendBuffer.queued.length > 0); }, [displayWaiting, onContextBusyChange, sendBuffer.undoArmed, sendBuffer.queued.length]);

  const handleCopyMarkdownRef = useRef<() => Promise<boolean>>(async () => false);

  const fillInput = useCallback((text: string) => {
    if (!text) return;
    setInput((prev) => {
      const trimmed = prev.trimEnd();
      if (!trimmed) return text;
      const needsSpace = !/\s$/.test(prev);
      return `${prev}${needsSpace ? ' ' : ''}${text}`;
    });
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [setInput]);

  useImperativeHandle(ref, () => ({
    focusInput() {
      inputRef.current?.focus();
    },
    reset: handleReset,
    loadThread: handleLoadThread,
    sendNow,
    fillInput,
    copyAsMarkdown: () => handleCopyMarkdownRef.current(),
  }), [handleReset, handleLoadThread, sendNow, fillInput]);

  const fallbackEmptyState = useMemo(() => (
    <EmptyStateCard
      isOrchestratorMode={isOrchestratorMode}
      targetAgent={targetAgent}
      activeTargetLabel={activeTargetLabel}
      activeTargetColor={activeTargetColor}
      thoughtsElevatedSurface={thoughtsElevatedSurface}
      thoughtsElevatedBorder={thoughtsElevatedBorder}
      thoughtsElevatedShadow={thoughtsElevatedShadow}
      suggestions={suggestions}
      onSelectSuggestion={(suggestion) => {
        setTargetAgentKey(suggestion.agent.key);
        setInput(suggestion.action);
        setTimeout(() => inputRef.current?.focus(), 50);
      }}
    />
  ), [activeTargetColor, activeTargetLabel, isOrchestratorMode, setInput, suggestions, targetAgent, thoughtsElevatedBorder, thoughtsElevatedShadow, thoughtsElevatedSurface]);

  const handleSlashCommand = useCallback((cmd: string) => {
    setInput(cmd);
    latestInputRef.current = cmd;
    void handleTaskSend(cmd);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [handleTaskSend, setInput]);

  const handleEffortChange = useCallback((next: ThinkingEffort) => {
    thinkingPreferenceTouchedRef.current = true;
    const nextOverride = next === 'adaptive' ? null : next;
    setThinkingOverride(nextOverride);
    if (!contextualConversation) writeStoredOrchestratorThinkingOverride(nextOverride);
  }, [contextualConversation, setThinkingOverride]);

  const handleBackendStartFresh = useDraftStartFresh({
    backendSwitch, latestInputRef, handleReset, setInput, draftKey, repoPath: repoPathProp, tabId: scopeTabId, isOrchestratorMode,
  });

  const handleCopyMarkdown = useCallback(async (): Promise<boolean> => {
    if (displayMessages.length === 0) return false;
    if (!navigator.clipboard?.writeText) {
      console.log('[export-thread] Clipboard API unavailable for active thread export');
      setExportFeedback('error');
      return false;
    }

    setExportFeedback('copying');
    try {
      const markdown = serializeThreadToMarkdown(displayMessages, { threadId });
      await navigator.clipboard.writeText(markdown);
      console.log(`[export-thread] Copied active thread ${threadId ?? 'unsaved-thread'} to clipboard`);
      setExportFeedback('copied');
      return true;
    } catch (error) {
      console.log('[export-thread] Failed to copy active thread markdown', error);
      setExportFeedback('error');
      return false;
    }
  }, [displayMessages, setExportFeedback, threadId]);

  useEffect(() => {
    handleCopyMarkdownRef.current = handleCopyMarkdown;
  }, [handleCopyMarkdown]);

  // Keep recorded turn origins; expose live worker status once at the composer.
  const threadWorkerPackets = packetsForOrchestratorThread(missionState?.packets ?? [], threadId);

  const threadWorkers = useThreadWorkers({ threadId: isOrchestratorMode ? threadId : null, repoPath: resolvedRepoPath, busy: displayWaiting, agents });
  const workerGroups = projectThreadWorkerGroups({ entries: isOrchestratorMode ? displayMessages : [], packets: isOrchestratorMode ? threadWorkerPackets : [], sessions: threadWorkers, busy: displayWaiting });
  const workerScouts = [...workerGroups.groups.values(), workerGroups.unattributed].flatMap(group => group.scouts);
  const { selectTranscriptSuggestion, retryTranscriptDelivery, deliverTranscriptArtifact, composerQueue } = useTranscriptActions({ sendNow, retry: orchStream.retryPendingSend, deliver: deliverTaskArtifactAction,
    queue: { items: durable.transcriptItems, canSteer: durable.canSteer, onSteer: id => { void durable.steer(id); }, onCancel: sendBuffer.cancelQueued, removing: durable.removing, promoting: durable.promoting, steerableIds: durable.steerableIds } });
  const composeFirst = !contextualConversation && displayMessages.length === 0 && !displayWaiting;
  return (<WorkerDisclosureProvider key={`${resolvedRepoPath}:${threadId}`}>
    <div
      data-voice-chat-root
      style={{
        containerType: 'size',
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        justifyContent: 'center', position: 'relative',
      } as React.CSSProperties}
    >
      {displayMessages.length > 0 && showInlineExport ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            paddingTop: 10,
            paddingRight: 16,
            paddingBottom: 0,
            paddingLeft: 16,
            flexShrink: 0,
          }}
        >
          <ThreadExportButton state={exportState} onClick={() => { void handleCopyMarkdown(); }} />
        </div>
      ) : null}
      <div
        ref={composerDropHostRef}
        onDragOver={attachmentDragHandlers.onDragOver}
        onDragLeave={attachmentDragHandlers.onDragLeave}
        onDrop={attachmentDragHandlers.onDrop}
        style={{
          position: 'relative',
          display: 'flex',
          flex: composeFirst ? '0 1 auto' : '1 1 auto',
          minHeight: 0,
          transition: 'flex-grow 280ms cubic-bezier(0.22, 1, 0.36, 1)',
          background: thoughtsBodyBackground,
          outline: attachmentDragOver ? '2px solid var(--t-accent)' : 'none',
          outlineOffset: -2,
          boxSizing: 'border-box',
        }}
      >
        {/* Keep the optional rail beside the transcript and the composer below. */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <ChatMessageList threadId={isOrchestratorMode ? threadId : targetSessionKey} active={open}
            ref={chatEndRef}
            displayMessages={displayMessages}
            displayWaiting={displayWaiting}
            composerQueue={composerQueue}
            repoPath={resolvedRepoPath}
            activeTargetLabel={activeTargetLabel}
            activeTargetColor={activeTargetColor}
            thoughtsMutedGlass={thoughtsMutedGlass}
            thoughtsElevatedBorder={thoughtsElevatedBorder}
            thoughtsElevatedShadow={thoughtsElevatedShadow}
            emptyStateOverride={emptyStateOverride}
            emptyStateFallback={fallbackEmptyState}
            composeFirst={composeFirst}
            topContent={transcriptTopContent}
            isOrchestratorMode={isOrchestratorMode}
            suggestedReplyMessageId={suggestedReplyMessageId}
            suggestedReplies={chipsForLastAssistant}
            suggestedRepliesCollapsed={suggestedRepliesCollapsed}
            suggestedRepliesPending={suggestedRepliesPending}
            onSelectSuggestion={selectTranscriptSuggestion}
            onDismissSuggestions={dismissSuggestedReplies}
            onRestoreSuggestions={restoreSuggestedReplies}
            turnSummary={turnSummary}
            onRetryDelivery={retryTranscriptDelivery}
            onScroll={loadOlderHistoryOnScroll}
            taskArtifacts={taskArtifacts}
            taskArtifactThreadBusy={orchStream.status === 'busy'}
            onTaskArtifactDeliver={deliverTranscriptArtifact}
          />
        </div>
        {!composeFirst ? transcriptSideRail : null}
      </div>
      {composeFirst && transcriptSideRail ? <div style={{ position: 'absolute', top: 0, right: 0, height: 'max-content' }}>{transcriptSideRail}</div> : null}
      <ChatToastStack
        projectTargetSaveError={targetSaveError}
        reloadNotice={reloadNotice}
        onDismissReloadNotice={dismissReloadNotice}
        showClearToast={showClearToast}
        showDraftClearedToast={showDraftClearedToast}
        thoughtsBodyBackground={thoughtsBodyBackground}
      />
      <ComposerFrame composeFirst={composeFirst}>
      {backendSwitch.pending ? (
        <BackendSwitchChoice
          target={backendSwitch.pending}
          onHandoff={backendSwitch.acceptHandoff}
          onStartFresh={handleBackendStartFresh}
          onCancel={backendSwitch.clearPending}
        />
      ) : null}
      <SessionCacheProvider enabled={!isChatMode} session={isSingleMode ? singleRuntimeSessionRef.current : threadId ?? null}
        runtime={isSingleMode ? singleRuntime : activeBackendIdentity}
        model={orchestratorModel ?? [...backendMessages].reverse().find(entry => entry.role === 'assistant')?.model ?? null}
        entries={backendMessages} running={displayWaiting}>
      <VisualComposerArea dictationScopeKey={JSON.stringify([workspaceModeKey, lockedMode ?? orchestrationMode, threadId ?? 'draft'])} visual={{ active: open && isOrchestratorMode && !contextualConversation,
        target: threadId && resolvedRepoPath ? { threadId, repoPath: resolvedRepoPath } : null,
        label: `${composerRepoLabel} · current chat`, capture: captureQueuedSend }}
        ref={inputRef} activeComposer={open}
        inputLabel={contextualConversation ? 'Reply preparation message' : undefined}
        placeholder={contextualConversation?.placeholder}
        input={input}
        onInputChange={setInput}
        draftWarning={draftWarning}
        isOrchestratorMode={isOrchestratorMode}
        isChatMode={isChatMode}
        isSingleMode={isSingleMode}
        displayWaiting={displayWaiting}
        chatMessages={displayMessages}
        workerPackets={threadWorkerPackets}
        workerContext={{ packets: threadWorkerPackets, sessions: threadWorkers, scouts: workerScouts, onFocusPacket, onFocusSession }}
        activityContent={isOrchestratorMode ? <TranscriptActivity entries={displayMessages} packets={threadWorkerPackets}
          busy={displayWaiting} repoPath={resolvedRepoPath} onFocusPacket={onFocusPacket} /> : undefined}
        activeTargetLabel={activeTargetLabel}
        targetAgentExists={Boolean(targetAgent)}
        // Use the effective streamed transcript so Working clears when the reply lands.
        thoughtsBodyBackground={thoughtsBodyBackground}
        enhancing={enhancing}
        preEnhanceInput={preEnhanceInput}
        onEnhance={handleEnhance}
        onUndoEnhance={handleUndoEnhance}
        onSubmit={handleComposerSend}
        onStop={sendBuffer.stopOrUndo}
        onSteer={handleSteer} canSteerLive={durable.canSteer} queueSaving={queueSaving || threadBindingPending}
        sendBufferStatus={<ComposerSendStatus attachmentError={attachmentError} sendBuffer={sendBuffer} active={isOrchestratorMode} uploads={{ uploading, failed: failedUploads.length > 0, retry: retryFailedUploads, discard: discardFailedUploads }} />}
        onSlashCommand={handleSlashCommand}
        modelLabel={isChatMode ? selectedChatModel.label : isSingleMode ? activeTargetLabel : isOrchestratorMode ? activeBackendLabel ?? formatComposerBackendLabel(orchestratorBackend, orchestratorModel) : activeTargetLabel}
        modelId={isOrchestratorMode ? orchestratorModel : undefined}
        isolatedModelSelection={Boolean(contextualConversation)}
        onModelRestore={isOrchestratorMode ? restoreOrchestratorModel : undefined}
        onModelChange={isOrchestratorMode ? backendSwitch.selectModel : undefined}
        activeBackend={isOrchestratorMode ? orchestratorBackend : undefined}
        onBackendChange={isOrchestratorMode ? backendSwitch.request : undefined}
        effort={thinkingEffort}
        onEffortChange={handleEffortChange}
        adaptiveEnabled={adaptiveThinkingEnabled}
        operatorDefaultEffort={operatorDefaults.thinkingEffort}
        codexDefaultDispatchModel={operatorDefaults.defaultDispatchModel}
        // Session rules (#1329) — orchestrator threads only. null (not yet
        // minted) still shows the read-only Repo/Global tiers in the chip.
        sessionRulesThreadId={isOrchestratorMode && !isChatMode ? threadId : undefined}
        repoLabel={composerRepoLabel}
        displayMessagesCount={displayMessages.length}
        hasAssistantActivity={hasAssistantActivity}
        footerMeterSlot={footerMeterSlot}
        composerLeadingExtras={composerLeadingExtras}
        voiceControl={isOrchestratorMode && !isChatMode && threadId && resolvedRepoPath ? <ManagedChatVoiceEntry chatRoot={composerDropHostRef} label={`${composerRepoLabel} · ${activeTargetLabel}`}
          visualTarget={{ repoPath: resolvedRepoPath, threadId }}
          identity={[resolvedRepoPath, threadId, orchestratorBackend, orchestratorModel, thinkingEffort, permissionMode, composerMode, threadProjectId, collideEnabled]}
          messages={displayMessages} terminals={orchStream.voiceTerminals} busy={displayWaiting} interrupt={orchStream.interrupt}
          transcript={orchStream.appendLocalEntries}
          queue={durable} capture={text => captureQueuedSend(text, [])}
          send={(text) => sendOrchestrator(text, { pinBackend: true, permissionMode, backend: composerBackendTurnOverride(orchestratorBackend),
            resolveTurnOptions: async () => ({ backend: composerBackendTurnOverride(orchestratorBackend), model: orchestratorModel }),
            thinkingEffort, model: orchestratorModel, orchestrationMode: composeComposerTurnMessage(text, composerModeRef.current, soloOrchestrator).orchestrationMode })}
        /> : null}
        attachedImages={attachedImages}
        attachedFiles={attachedFiles}
        dragOver={attachmentDragOver}
        dragHandlers={attachmentDragHandlers}
        onAttachedImageRemove={removeAttachedImage}
        onAttachedImageAnnotate={setAnnotatingIndex}
        onAttachedFileRemove={removeAttachedFile}
        onUploadDiskFiles={processAttachmentFiles}
        composerMode={isOrchestratorMode && !isChatMode ? composerMode : undefined}
        onComposerModeChange={isOrchestratorMode && !isChatMode ? handleComposerModeChange : undefined}
        composerModeStorageId={composerModeStorageId}
        repoPath={resolvedRepoPath}
        workspaceTargets={workspaceTargets}
        selectedRepoPath={resolvedRepoPath}
        onSelectRepoPath={handleSelectComposerRepoPath}
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
        contextLocationSlot={composeFirst ? composerBelowSlot : undefined}
        promptStash={isOrchestratorMode && !isChatMode ? { repoPath: resolvedRepoPath ?? '~', threadId, onRestore: fillInput } : undefined}
      /></SessionCacheProvider>
      {annotatingIndex !== null && attachedImages[annotatingIndex] ? (() => {
        const idx = annotatingIndex;
        const target = attachedImages[idx];
        if (!target) return null;
        return (
          <ScreenshotAnnotator
            image={target}
            onCancel={() => setAnnotatingIndex(null)}
            onDone={(dataUri) => {
              const mime = dataUri.slice(5, dataUri.indexOf(';')) || 'image/png';
              replaceAttachedImage(idx, { ...target, dataUri, mimeType: mime });
              setAnnotatingIndex(null);
            }}
          />
        );
      })() : null}
      </ComposerFrame>
    </div>
  </WorkerDisclosureProvider>);
});
