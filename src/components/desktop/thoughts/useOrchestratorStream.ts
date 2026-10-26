'use client';

import { useImageSendAdmissions } from './use-orchestrator-stream/image-send-admission';
import { useOrchestratorThreadBinding } from './use-orchestrator-stream/thread-binding';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { stopRunningTools } from '@/components/desktop/transcript/activity';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { retainedTranscriptReducer, retainTranscriptEntries } from '@/lib/transcripts/retained-state';
import { extractPlanFromTranscript } from '@/lib/llm/plan-extractor';
import type { OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import {
  clearQueuedOrchestratorSessionPrelude,
  consumeOrchestratorSessionPrelude,
  subscribeOrchestratorMissionCompleted,
  type OrchestratorMissionCompletedDetail,
} from '@/lib/orchestrator/store';
import {
  buildOrchestratorSendPayload,
  createOrchestratorClientMessageId,
  deliverOrchestratorPayload,
  type PendingOrchestratorSend,
} from './use-orchestrator-stream/delivery';
import { useTranscriptTextFlush } from './use-orchestrator-stream/text-flush';
import { useDurablePendingSend } from './use-orchestrator-stream/durable-pending-send';
import { trackComposerSubmission } from './use-orchestrator-stream/track-submission';
import { canReadSessionContext } from './use-orchestrator-stream/session-context-preflight';
import { optimisticUserEntry } from './use-orchestrator-stream/optimistic-user-entry';
import { withSessionPrelude } from '@/lib/orchestrator/composer-wire';
import { archiveMissionThread as archiveCompletedMissionThread } from './use-orchestrator-stream/mission-history';
import { primeCompactedOrchestratorSession, requestOrchestratorCompaction } from './use-orchestrator-stream/session';
import {
  appendSnapshotTurnFailure,
  useNoSnapshotBusyFallback,
} from './use-orchestrator-stream/snapshot-reconcile';
import {
  ORCHESTRATOR_COMPACTION_STATUS_MIN_MS,
  ORCHESTRATOR_FORCE_COMPACT_THRESHOLD,
  ORCHESTRATOR_NEXT_TURN_BUFFER_TOKENS,
  ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS,
  approxTokens,
  createIdleBusyState,
  emitTokenUsage,
  formatTimestampLabel,
  normalizeRepoPath,
  openOrchestratorWebSocket,
  refreshWsCredentials,
  sortTranscriptEntries,
  type OrchestratorStreamStatus,
} from './use-orchestrator-stream/shared';
import { useOrchestratorAutoCompaction } from './use-orchestrator-stream/auto-compaction';
import { useOrchestratorTokenTelemetry } from './use-orchestrator-stream/token-telemetry';
import {
  createOrchestratorMessageHandler,
  type CurrentAssistantStreamState,
  type OrchestratorSnapshotTurn,
} from './use-orchestrator-stream/socket';
import { prepareOrchestratorTurn, useTurnOptionResolution } from './use-orchestrator-stream/turn-option-resolution';
import type {
  ActiveTurnState,
  OrchestratorSendHandle,
  OrchestratorSendOptions,
  OrchestratorStreamOptions,
  OrchestratorStreamResult,
} from './use-orchestrator-stream/types';
export type { OrchestratorSendHandle } from './use-orchestrator-stream/types';
export {
  DEFAULT_ORCHESTRATOR_MODEL,
  ORCHESTRATOR_TOKEN_EVENT,
} from './use-orchestrator-stream/shared';
export type {
  OrchestratorPermissionMode,
  OrchestratorStreamStatus,
  OrchestratorTokenUsageDetail,
} from './use-orchestrator-stream/shared';

// Mission ids whose completed-thread rotation already ran this app session.
// Module scope prevents remounts from re-rotating on boot-time state oscillation.
const rotatedMissionIds = new Set<string>();

/**
 * Subscribes to the selected orchestrator backend and accumulates output into
 * renderable transcript entries. Connection details use the runtime resolver.
 */
export function useOrchestratorStream(
  repoPath: string | null,
  options?: OrchestratorStreamOptions,
): OrchestratorStreamResult {
  const [messages, setMessages] = useReducer(retainedTranscriptReducer, []);
  const [voiceTerminals, setVoiceTerminals] = useState<Record<string, { outcome: 'completed' | 'failed' | 'interrupted' | 'unconfirmed'; text: string }>>({});
  const [planText, setPlanText] = useState<string | null>(null);
  const [status, setStatus] = useState<OrchestratorStreamStatus>('connecting');
  const [busyState, setBusyState] = useState(() => createIdleBusyState());
  const [connected, setConnected] = useState(false);
  const [tokenCount, setTokenCount] = useState(0);
  const [runningTotal, setRunningTotal] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const resetEpochRef = useRef(0);
  const currentAssistantRef = useRef<CurrentAssistantStreamState | null>(null);
  // Highest orchestrator event seq applied for the current session view —
  // drives the replay `since` cursor + client-side de-dup (see socket.ts).
  const lastSeqRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const telemetryBindingRef = useRef<string | null>(null);
  const telemetryTotalRef = useRef<number | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const repoPathRef = useRef(repoPath);
  repoPathRef.current = repoPath;
  const projectIdRef = useRef<string | null>(options?.projectId ?? null);
  projectIdRef.current = options?.projectId ?? null;
  const threadId = options?.threadId ?? null;
  const { threadIdRef, allowUnboundRecoveryRef } = useOrchestratorThreadBinding(threadId, options?.allowUnboundRecovery);
  const onThreadIdMintRef = useRef(options?.onThreadIdMint);
  onThreadIdMintRef.current = options?.onThreadIdMint;
  const onSettledAssistantMissingRef = useRef(options?.onSettledAssistantMissing);
  onSettledAssistantMissingRef.current = options?.onSettledAssistantMissing;
  const runningTotalRef = useRef(runningTotal);
  runningTotalRef.current = runningTotal;
  const mountedRef = useRef(false);
  const messagesRef = useRef<MobileTranscriptEntry[]>([]);
  const planTextRef = useRef<string | null>(null);
  const hasHistory = options?.hasHistory ?? false;
  const seededPlanText = options?.seededPlanText ?? null;

  const hasHistoryRef = useRef(Boolean(hasHistory));
  const captureFirstTurnPlanRef = useRef(false);
  const firstTurnPlanStartedRef = useRef(false);
  const firstTurnPlanChunksRef = useRef<string[]>([]);
  const activeTurnRef = useRef<ActiveTurnState | null>(null);
  const autoCompactInFlightRef = useRef(false);
  const autoCompactArmedRef = useRef(true);
  // Fable Slice 4 — last backend id seen on the stream (socket.ts stamps it
  // from every event). Read by the auto-compact effect to pick the metered
  // window target vs the global one.
  const lastBackendRef = useRef<string | null>(null);
  // Per-turn override used for backend-scoped subscribe + interrupt messages.
  // It must be set before the send ACK because the operator can press Stop
  // while the selected backend is still resolving its CLI (#1557).
  const activeTurnBackendRef = useRef<OrchestratorBackendId | null>(null);
  const turnOptionResolution = useTurnOptionResolution(repoPath);
  const missionRotationInFlightRef = useRef(false);
  const pendingMissionCompletionRef = useRef<OrchestratorMissionCompletedDetail | null>(null);
  const transitionStripTimerRef = useRef<number | null>(null);
  const pendingSendWatchdogRef = useRef<PendingOrchestratorSend | null>(null);
  const pendingActivityHandlerRef = useRef<(event: {
    event: string;
    data?: Record<string, unknown>;
    observedAt: number;
  }) => void>(() => {});
  const imageAdmissions = useImageSendAdmissions(pendingActivityHandlerRef);

  // Server turn truth on subscribe snapshots is the primary reconciliation
  // seam. These elapsed/event refs remain only as a compatibility fallback
  // when a subscription receives no snapshot at all.
  const eventCountRef = useRef(0);
  const snapshotSeenRef = useRef(false);
  const turnTranscriptEventCountRef = useRef(0);
  const lastEventAtRef = useRef<number>(Date.now());
  // Wall-clock of the most recent local send(). The 3s reconnect heal uses this
  // to avoid clearing a freshly-started turn's "busy" state: a send that fired
  // after the socket opened means the turn is legitimately starting (and may be
  // cold-starting the orchestrator before its first event), not stale carryover.
  const lastSendAtRef = useRef(0);
  const suppressTurnEventsRef = useRef(false);
  const RECONNECT_HEAL_DELAY_MS = 3000;
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    hasHistoryRef.current = Boolean(hasHistory);
  }, [hasHistory]);

  useEffect(() => {
    const trimmed = seededPlanText?.trim();
    if (!trimmed || planTextRef.current === trimmed) {
      return;
    }

    planTextRef.current = trimmed;
    setPlanText(trimmed);
  }, [seededPlanText]);

  const resetFirstTurnPlanCapture = useCallback(() => {
    captureFirstTurnPlanRef.current = false;
    firstTurnPlanStartedRef.current = false;
    firstTurnPlanChunksRef.current = [];
  }, []);

  const finalizeFirstTurnPlanCapture = useCallback(() => {
    if (!captureFirstTurnPlanRef.current || planTextRef.current) {
      resetFirstTurnPlanCapture();
      return;
    }

    const nextPlanText = extractPlanFromTranscript([{
      role: 'assistant',
      text: firstTurnPlanChunksRef.current.join(''),
    }]);
    resetFirstTurnPlanCapture();

    if (!nextPlanText) {
      return;
    }

    planTextRef.current = nextPlanText;
    setPlanText(nextPlanText);
  }, [resetFirstTurnPlanCapture]);

  const syncMessages = useCallback((entries: MobileTranscriptEntry[]) => {
    messagesRef.current = retainTranscriptEntries(entries);
    setMessages(messagesRef.current);
  }, [setMessages]);

  const updateRunningTotal = useCallback((value: number) => {
    runningTotalRef.current = value;
    setRunningTotal(value);
  }, []);

  const { refreshTokenTelemetry, requestCompaction } = useOrchestratorTokenTelemetry({
    repoPathRef, threadIdRef, lastBackendRef, messagesRef, updateRunningTotal, setTokenCount,
    telemetryBindingRef, telemetryTotalRef,
  });

  const primeCompactedSession = useCallback(async (
    activeRepoPath: string,
    payload: Awaited<ReturnType<typeof requestOrchestratorCompaction>>,
    options?: { threadId?: string | null },
  ) => {
    if (!payload) return null;
    const compactThreadId = options?.threadId ?? threadIdRef.current;
    if (!compactThreadId) return null;
    return await primeCompactedOrchestratorSession({
      messagesRef,
      payload,
      repoPath: activeRepoPath,
      threadId: compactThreadId,
      setMessages: syncMessages,
      setRunningTotal: updateRunningTotal,
      setTokenCount,
      telemetrySessionKeyRef: telemetryBindingRef,
      telemetryTotalRef,
      isCurrent: () => mountedRef.current && repoPathRef.current === activeRepoPath && threadIdRef.current === compactThreadId,
    });
  }, [syncMessages, updateRunningTotal]);

  const estimateNextTurnTokens = useCallback((message: string) => (
    runningTotalRef.current
    + ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS
    + ORCHESTRATOR_NEXT_TURN_BUFFER_TOKENS
    + approxTokens(message)
  ), []);

  const replaceTranscript = useCallback((entries: MobileTranscriptEntry[]) => {
    const next = sortTranscriptEntries(entries);
    syncMessages(next);
  }, [syncMessages]);

  const appendLocalEntries = useCallback((entries: MobileTranscriptEntry[]) => {
    if (entries.length === 0) return;
    setMessages((prev) => {
      const next = [...prev];
      const indexById = new Map(next.map((entry, index) => [entry.id, index] as const));
      for (const entry of entries) {
        const existingIndex = indexById.get(entry.id);
        if (existingIndex == null) {
          indexById.set(entry.id, next.length);
          next.push(entry);
        } else {
          next[existingIndex] = entry;
        }
      }
      const sorted = sortTranscriptEntries(next);
      messagesRef.current = sorted;
      return sorted;
    });
  }, []);

  const reset = useCallback(() => {
    turnOptionResolution.abort();
    const nextStatus = connected ? 'ready' : 'connecting';
    resetEpochRef.current += 1;
    lastSeqRef.current = 0;
    activeTurnBackendRef.current = null;
    turnTranscriptEventCountRef.current = 0;
    syncMessages([]);
    planTextRef.current = null;
    setPlanText(null);
    setBusyState(createIdleBusyState());
    activeTurnRef.current = null;
    setTokenCount(0);
    updateRunningTotal(0);
    currentAssistantRef.current = null;
    hasHistoryRef.current = false;
    telemetryBindingRef.current = null;
    telemetryTotalRef.current = null;
    autoCompactInFlightRef.current = false;
    autoCompactArmedRef.current = true;
    resetFirstTurnPlanCapture();
    statusRef.current = nextStatus;
    lastEventAtRef.current = Date.now();
    setStatus(nextStatus);
    if (transitionStripTimerRef.current) {
      clearTimeout(transitionStripTimerRef.current);
      transitionStripTimerRef.current = null;
    }
    if (pendingSendWatchdogRef.current) {
      window.clearTimeout(pendingSendWatchdogRef.current.timeoutId);
      pendingSendWatchdogRef.current = null;
    }
    clearQueuedOrchestratorSessionPrelude(repoPathRef.current, threadIdRef.current);
    emitTokenUsage({ repoPath: repoPathRef.current, tokenCount: 0, runningTotal: 0 });
  }, [connected, resetFirstTurnPlanCapture, syncMessages, turnOptionResolution, updateRunningTotal]);

  const archiveMissionThread = useCallback(async (detail: OrchestratorMissionCompletedDetail) => {
    const activeRepoPath = repoPathRef.current;
    if (!activeRepoPath) return;
    await archiveCompletedMissionThread(detail, {
      planText: planTextRef.current,
      replaceTranscript,
      getTranscript: () => messagesRef.current,
      repoPath: activeRepoPath,
      reset,
      transcript: messagesRef.current,
      transitionStripTimerRef,
    });
  }, [replaceTranscript, reset]);

  const rotateMissionThread = useCallback(async (detail: OrchestratorMissionCompletedDetail) => {
    const activeRepoPath = normalizeRepoPath(repoPathRef.current);
    const eventRepoPath = normalizeRepoPath(detail.repoPath);
    if (!activeRepoPath || (eventRepoPath && eventRepoPath !== activeRepoPath)) {
      return;
    }
    // A mission completes ONCE — rotate at most once per missionId per app
    // session. The completed event re-fires when mission state oscillates
    // non-terminal→terminal on boot (WS reconnect / incremental packet load);
    // without this, a re-fire against a RESTORED transcript archived and
    // deleted the live thread again (the 2026-07-14 storm's second casualty).
    const missionId = detail.missionId?.trim();
    if (missionId && rotatedMissionIds.has(missionId)) return;
    if (missionRotationInFlightRef.current) {
      // Stash WITHOUT marking — the drain re-enters here and must pass the
      // dedupe; duplicate storms of the same id collapse on the check above.
      pendingMissionCompletionRef.current = detail;
      return;
    }
    if (missionId) rotatedMissionIds.add(missionId);

    missionRotationInFlightRef.current = true;
    try {
      await archiveMissionThread(detail);
      if (pendingMissionCompletionRef.current === detail) {
        pendingMissionCompletionRef.current = null;
      }
    } catch (error) {
      console.error('[orchestrator-stream] Failed to rotate completed mission thread.', error);
    } finally {
      missionRotationInFlightRef.current = false;
      const pending = pendingMissionCompletionRef.current;
      if (pending && pending !== detail && statusRef.current !== 'busy') {
        pendingMissionCompletionRef.current = null;
        queueMicrotask(() => {
          void rotateMissionThread(pending);
        });
      }
    }
  }, [archiveMissionThread]);

  const endTurn = useCallback(() => {
    activeTurnRef.current = null;
    setBusyState(createIdleBusyState());
  }, []);

  // Clear stale local running state after authoritative server reconciliation
  // (or the no-snapshot compatibility fallback). Idempotent — safe to call
  // when nothing needs healing.
  const healStaleBusyState = useCallback((reason: string) => {
    const hasStaleStatus = statusRef.current === 'busy';
    const hasOrphanAssistant = currentAssistantRef.current !== null;
    const hasActiveTurn = activeTurnRef.current !== null;
    const hasRunningTools = messagesRef.current.some((m) =>
      m.toolCalls?.some((t) => t.status === 'running'),
    );
    if (!hasStaleStatus && !hasOrphanAssistant && !hasActiveTurn && !hasRunningTools) return;

    console.warn(`[orchestrator-stream] Healing stale busy state: ${reason}`);
    if (hasStaleStatus) {
      statusRef.current = 'ready';
      setStatus('ready');
    }
    if (hasOrphanAssistant) currentAssistantRef.current = null;
    endTurn();
    if (hasRunningTools) {
      setMessages((prev) =>
        prev.map((m) =>
          m.toolCalls?.some((t) => t.status === 'running')
            ? { ...m, toolCalls: m.toolCalls.map((t) => (t.status === 'running' ? { ...t, status: 'done' as const } : t)) }
            : m,
        ),
      );
    }
  }, [endTurn]);

  const reconcileSnapshotTerminalTurn = useCallback((
    turn: OrchestratorSnapshotTurn | null,
    wasRunning: boolean,
  ) => {
    const wasLocallyRunning = wasRunning || activeTurnRef.current !== null;
    healStaleBusyState(turn
      ? `server turn ${turn.id} settled (${turn.outcome ?? 'unknown outcome'})`
      : 'server reports no turn for this thread');
    if (!wasLocallyRunning || turn?.outcome !== 'failed') return;

    appendSnapshotTurnFailure(turn.id, setMessages, messagesRef);
  }, [healStaleBusyState]);

  const settlePendingSend = imageAdmissions.observe;

  const commitCurrentAssistant = useCallback(() => {
    const current = currentAssistantRef.current;
    if (!current || (current.chunks.length === 0 && current.thinkingChunks.length === 0)) return;

    // Token-streaming backends (verbatimStream) send slices of one continuous
    // string — concatenate verbatim. Block-emitting backends (Claude REPL,
    // Codex items) send complete segments that need the '\n' glue.
    const joiner = current.verbatimStream ? '' : '\n';
    const text = current.chunks.join(joiner);
    const thinking = current.thinkingChunks.length > 0 ? current.thinkingChunks.join(joiner) : undefined;
    // Reasoning-phase fields (see CurrentAssistantStreamState): the frozen
    // duration drives the "Thought for Ns" line; `thinkingActive` stays true
    // only while reasoning is still the ONLY thing that has happened.
    const thinkingDurationMs = current.thinkingDurationMs ?? undefined;
    const thinkingActive = current.thinkingStartedAt != null && current.thinkingDurationMs == null
      && current.chunks.length === 0;
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === current.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          text: text || (thinking ? '' : ''),
          thinking, backend: current.backend ?? next[idx].backend, model: current.model ?? next[idx].model,
          ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
          thinkingActive,
          timestamp: next[idx].timestamp ?? Date.now(),
          timestampLabel: next[idx].timestampLabel ?? formatTimestampLabel(Date.now()),
        };
        messagesRef.current = next;
        return next;
      }
      const assistantEntry: MobileTranscriptEntry = {
        id: current.id,
        role: 'assistant',
        text: text || (thinking ? '' : ''),
        thinking, backend: current.backend, model: current.model,
        ...(thinkingDurationMs !== undefined ? { thinkingDurationMs } : {}),
        thinkingActive,
        timestamp: Date.now(),
        timestampLabel: formatTimestampLabel(Date.now()),
      };
      const next = [...prev, assistantEntry];
      messagesRef.current = next;
      return next;
    });
  }, []);

  const { flush: flushCurrentAssistant, schedule: scheduleFlushCurrentAssistant, cancel: cancelTextFlush } =
    useTranscriptTextFlush(commitCurrentAssistant, options?.visible ?? true);

  const connect = useCallback(() => {
    if (!repoPathRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;
    const ws = openOrchestratorWebSocket();
    if (!ws) return;
    wsRef.current = ws;
    // Distinguishes "connection dropped" from "handshake never succeeded" —
    // the latter means our baked credentials are stale (app restarted under
    // this page) and the reconnect must refresh them first.
    let everOpened = false;

    ws.onopen = () => {
      everOpened = true;
      setConnected(true);
      snapshotSeenRef.current = false;
      // Don't clobber a live turn's "busy" on a mid-turn reconnect. Downgrading
      // to 'connecting' here made the working indicator (and the streaming reply,
      // via socket.ts's currentAssistant guard) vanish on a network flap. A
      // genuinely stale busy is reconciled by the subscribe snapshot's turn
      // ledger, with the elapsed fallback reserved for no-snapshot servers.
      setStatus(statusRef.current === 'busy' ? 'busy' : 'connecting');

      // Subscribe to orchestrator channel
      ws.send(JSON.stringify({
        type: 'orchestrator-subscribe',
        repoPath: repoPathRef.current,
        ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
        ...(activeTurnBackendRef.current ? { backend: activeTurnBackendRef.current } : {}),
        // Replay anything we missed since the last event we applied — on a
        // reconnect mid-turn this recovers the in-flight tokens instead of
        // leaving us stuck on a "Working" pill with no stream.
        since: lastSeqRef.current,
      }));

      console.log('[orchestrator-stream] Connected, subscribing...');

      // Reconnect compatibility heal. If this is a fresh connect, status is already
      // 'connecting' and the heal is a no-op. If we're reconnecting after a
      // ws-server restart or a network flap, any "busy" state we carried over
      // is potentially stale. Give the server 3 seconds to push events for a
      // genuinely active turn; if nothing arrives, clear the stale indicators.
      const countAtOpen = eventCountRef.current;
      const openedAt = Date.now();
      setTimeout(() => {
        if (ws !== wsRef.current) return;
        if (snapshotSeenRef.current) return;
        if (eventCountRef.current !== countAtOpen) return;
        // A send fired after this socket opened → the busy is fresh (the
        // orchestrator may still be cold-starting before its first event), not
        // stale carryover. Leave it; server turn truth is the backstop.
        if (lastSendAtRef.current >= openedAt) return;
        if (statusRef.current === 'busy' || currentAssistantRef.current) {
          healStaleBusyState('reconnect with no follow-up events after 3s');
        }
      }, RECONNECT_HEAL_DELAY_MS);
    };

    ws.onmessage = createOrchestratorMessageHandler({
      captureFirstTurnPlanRef,
      activeTurnBackendRef,
      currentWs: ws,
      currentAssistantRef,
      eventCountRef,
      snapshotSeenRef,
      threadIdRef,
      allowUnboundRecoveryRef,
      finalizeFirstTurnPlanCapture,
      firstTurnPlanChunksRef,
      firstTurnPlanStartedRef,
      flushCurrentAssistant,
      scheduleFlushCurrentAssistant,
      lastBackendRef,
      lastSeqRef,
      lastEventAtRef,
      messagesRef,
      onVoiceTerminal: (receipt) => setVoiceTerminals(previous => Object.fromEntries([...Object.entries(previous).slice(-63), [receipt.userMessageId, receipt]])),
      onOrchestratorActivity: settlePendingSend,
      onSnapshotTurnTerminal: reconcileSnapshotTerminalTurn,
      onSettledAssistantMissing: (turn) => {
        if (turn.assistantMessageId) {
          onSettledAssistantMissingRef.current?.(turn.assistantMessageId);
        }
      },
      resetEpochRef,
      setMessages,
      setStatus,
      statusRef,
      suppressTurnEventsRef,
      turnTranscriptEventCountRef,
      wsRef,
    });

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      console.log('[orchestrator-stream] Disconnected');

      // Auto-reconnect after 2s — but only if still mounted. A close WITHOUT a
      // successful open means the handshake was rejected — the page's baked
      // token/port are stale (app restarted underneath us, live-hit
      // 2026-07-12) — so pull fresh credentials before the retry instead of
      // failing identically forever until a manual reload.
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (!mountedRef.current) return;
      const refresh = everOpened ? Promise.resolve(false) : refreshWsCredentials();
      reconnectTimerRef.current = setTimeout(() => {
        void refresh.then(() => {
          if (repoPathRef.current && mountedRef.current) connect();
        });
      }, 2000);
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }, [finalizeFirstTurnPlanCapture, flushCurrentAssistant, scheduleFlushCurrentAssistant, healStaleBusyState, reconcileSnapshotTerminalTurn, settlePendingSend]);

  const setPendingStatusReady = useCallback(() => {
    const nextStatus = wsRef.current?.readyState === WebSocket.OPEN || connected ? 'ready' : 'connecting';
    statusRef.current = nextStatus;
    setStatus(nextStatus);
    setBusyState(createIdleBusyState());
    activeTurnRef.current = null;
    currentAssistantRef.current = null;
    resetFirstTurnPlanCapture();
  }, [connected, resetFirstTurnPlanCapture]);
  const setPendingStatusBusy = useCallback(() => {
    statusRef.current = 'busy';
    setStatus('busy');
  }, []);
  const durablePendingSend = useDurablePendingSend({
    repoPath, threadId, pendingRef: pendingSendWatchdogRef, messagesRef, setMessages,
    getWebSocket: () => wsRef.current, connect,
    setStatusBusy: setPendingStatusBusy, setStatusReady: setPendingStatusReady,
  });
  pendingActivityHandlerRef.current = durablePendingSend.observeActivity;

  useEffect(() => {
    if (!repoPath || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    // repoPath/threadId changed → this is a new session view (e.g. the
    // first-turn threadId mint, which re-subscribes onto the turn's real
    // session). Reset the replay cursor and ask for the whole in-flight turn so
    // a clobbered/raced status can't leave us with no stream.
    lastSeqRef.current = 0;
    snapshotSeenRef.current = false;
    wsRef.current.send(JSON.stringify({
      type: 'orchestrator-subscribe',
      repoPath,
      ...(threadId ? { threadId } : {}),
      ...(activeTurnBackendRef.current ? { backend: activeTurnBackendRef.current } : {}),
      since: 0,
    }));
  }, [repoPath, threadId]);

  // Connect on mount / repoPath change
  useEffect(() => {
    if (!repoPath) return;

    mountedRef.current = true;
    telemetryBindingRef.current = null;
    telemetryTotalRef.current = null;
    setTokenCount(0);
    updateRunningTotal(0);
    emitTokenUsage({ repoPath, tokenCount: 0, runningTotal: 0 });
    connect();
    if (tokenRefreshTimerRef.current) clearTimeout(tokenRefreshTimerRef.current);
    tokenRefreshTimerRef.current = setTimeout(() => {
      void refreshTokenTelemetry();
    }, 1200);

    return () => {
      mountedRef.current = false;
      cancelTextFlush();
      if (tokenRefreshTimerRef.current) {
        clearTimeout(tokenRefreshTimerRef.current);
        tokenRefreshTimerRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        // Unsubscribe before closing
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'orchestrator-unsubscribe' }));
        }
        wsRef.current.close();
        wsRef.current = null;
      }
      if (pendingSendWatchdogRef.current) {
        window.clearTimeout(pendingSendWatchdogRef.current.timeoutId);
        pendingSendWatchdogRef.current = null;
      }
    };
  }, [repoPath, connect, refreshTokenTelemetry, updateRunningTotal, cancelTextFlush]);

  useEffect(() => {
    telemetryBindingRef.current = null;
    telemetryTotalRef.current = null;
    setTokenCount(0);
    updateRunningTotal(0);
    emitTokenUsage({ repoPath, tokenCount: 0, runningTotal: 0 });
    if (!repoPath || !threadId) return;
    if (tokenRefreshTimerRef.current) clearTimeout(tokenRefreshTimerRef.current);
    tokenRefreshTimerRef.current = setTimeout(() => {
      void refreshTokenTelemetry();
    }, 900);
  }, [repoPath, threadId, refreshTokenTelemetry, updateRunningTotal]);

  useEffect(() => {
    if (!repoPath) return () => {};

    return subscribeOrchestratorMissionCompleted((detail) => {
      const activeRepoPath = normalizeRepoPath(repoPathRef.current);
      const eventRepoPath = normalizeRepoPath(detail.repoPath);
      if (!activeRepoPath || (eventRepoPath && eventRepoPath !== activeRepoPath)) return;
      pendingMissionCompletionRef.current = detail;
      if (statusRef.current !== 'busy') {
        void rotateMissionThread(detail);
      }
    });
  }, [repoPath, rotateMissionThread]);

  useEffect(() => {
    if (!repoPath || status !== 'ready') return;
    if (tokenRefreshTimerRef.current) clearTimeout(tokenRefreshTimerRef.current);
    tokenRefreshTimerRef.current = setTimeout(() => {
      void refreshTokenTelemetry();
    }, 900);
    return () => {
      if (tokenRefreshTimerRef.current) {
        clearTimeout(tokenRefreshTimerRef.current);
        tokenRefreshTimerRef.current = null;
      }
    };
  }, [repoPath, refreshTokenTelemetry, status]);

  useEffect(() => {
    if (status === 'busy' || missionRotationInFlightRef.current || !pendingMissionCompletionRef.current) return;
    void rotateMissionThread(pendingMissionCompletionRef.current);
  }, [rotateMissionThread, status]);

  useOrchestratorAutoCompaction({
    repoPath,
    threadId,
    runningTotal,
    status,
    lastBackendRef,
    threadIdRef,
    statusRef,
    inFlightRef: autoCompactInFlightRef,
    armedRef: autoCompactArmedRef,
    requestCompaction,
    primeCompactedSession,
  });

  useNoSnapshotBusyFallback({
    repoPath, snapshotSeenRef, statusRef, lastEventAtRef,
    turnTranscriptEventCountRef, messagesRef, setMessages, healStaleBusyState,
  });

  const compactNow = useCallback(async (_options?: { keepTailCount?: number; source?: 'manual' | 'handoff' }) => {
    const activeRepoPath = repoPathRef.current;
    if (!activeRepoPath) return null;
    const activeThreadId = threadIdRef.current;
    if (!activeThreadId) return null;
    const payload = await requestCompaction(activeRepoPath, runningTotalRef.current, {
      keepTailCount: _options?.keepTailCount,
      trigger: _options?.source ?? 'manual',
      threadId: activeThreadId,
    });
    if (!payload?.ok) return null;
    if (!payload.applied || !Array.isArray(payload.transcript)) {
      return {
        applied: false,
        transcript: messagesRef.current,
        resumePrelude: null,
        tokensAfter: runningTotalRef.current,
      };
    }
    if (threadIdRef.current !== activeThreadId) return null;
    const primed = await primeCompactedSession(activeRepoPath, payload, {
      threadId: activeThreadId,
    });
    if (!mountedRef.current || repoPathRef.current !== activeRepoPath || threadIdRef.current !== activeThreadId) return null;
    if (!primed) return null;
    return {
      applied: true,
      transcript: payload.transcript,
      resumePrelude: primed.resumePrelude,
      tokensAfter: primed.nextTotal,
    };
  }, [primeCompactedSession, requestCompaction]);

  // #624 — User clicked the stop pill. Fire-and-forget the interrupt message
  // to ws-server and optimistically flip status back to ready/connecting so
  // the composer unlocks immediately. The server's abort path emits a normal
  // 'done' event within 1-2s which reinforces the idle state. Partial events
  // already accumulated in the transcript stay intact.
  const interrupt = useCallback(() => {
    turnOptionResolution.abort();
    const activeRepoPath = repoPathRef.current;
    if (!activeRepoPath) return;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'orchestrator-interrupt',
        repoPath: activeRepoPath,
        ...(threadIdRef.current ? { threadId: threadIdRef.current } : {}),
        ...(activeTurnBackendRef.current ? { backend: activeTurnBackendRef.current } : {}),
      }));
    }
    // Later events for this turn no longer reach its reply, so its in-flight calls end now (#3659).
    const stoppedTools = stopRunningTools(messagesRef.current);
    if (stoppedTools !== messagesRef.current) syncMessages(stoppedTools);
    if (statusRef.current === 'busy') {
      const nextStatus = connected ? 'ready' : 'connecting';
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      setBusyState(createIdleBusyState());
      activeTurnRef.current = null;
      currentAssistantRef.current = null;
    }
  }, [connected, syncMessages, turnOptionResolution]);
  const send = useCallback((message: string, options?: OrchestratorSendOptions) => {
    if (!canReadSessionContext(repoPathRef.current, threadIdRef.current, setMessages, messagesRef)) return null;
    suppressTurnEventsRef.current = false;
    const clientMessageId = createOrchestratorClientMessageId();
    const sentAtMs = Date.now();
    const transcriptBeforeSend = messagesRef.current;
    const repoPathAtSend = repoPathRef.current;

    // Mint before returning the handle so undo always targets the exact durable
    // thread even when this is the first message on a fresh tab.
    if (!threadIdRef.current) {
      const minted = `thoughts-${Date.now()}`;
      threadIdRef.current = minted;
      try { onThreadIdMintRef.current?.(minted); } catch { /* parent owns the consequence */ }
    }
    const sendHandle: OrchestratorSendHandle = {
      clientMessageId,
      userMessageId: `orch-user-${clientMessageId}`,
      threadId: threadIdRef.current,
      backend: options?.backend ?? null,
      transcriptBeforeSend,
      ...(options?.attachments?.length ? { admission: imageAdmissions.register(clientMessageId) } : {}),
    };
    lastSendAtRef.current = sentAtMs;
    lastEventAtRef.current = sentAtMs;
    setPendingStatusBusy();

    void trackComposerSubmission(sendHandle.userMessageId, imageAdmissions.onFailure(clientMessageId, (receipt) => setVoiceTerminals(previous => ({ ...previous, [receipt.userMessageId]: receipt }))), async (markDispatch) => {
      const turnOptions = await turnOptionResolution.resolve(clientMessageId, options);
      if (turnOptions === null || repoPathRef.current !== repoPathAtSend || threadIdRef.current !== sendHandle.threadId) {
        activeTurnBackendRef.current = null;
        if (statusRef.current === 'busy') {
          const nextStatus = connected ? 'ready' : 'connecting';
          statusRef.current = nextStatus;
          setStatus(nextStatus);
          setBusyState(createIdleBusyState());
        }
        return;
      }
      const {
        permissionMode, thinkingEffort, serviceTier, model, displayMessage, wireMessage,
        localEntriesAfterUser, collideBaseBackend, backend, orchestrationMode, pickedMode,
      } = prepareOrchestratorTurn(message, turnOptions);
      activeTurnBackendRef.current = backend ?? null;
      sendHandle.backend = backend ?? null;
      const activeRepoPath = repoPathRef.current;
      if (!activeRepoPath) {
        activeTurnBackendRef.current = null;
        return;
      }
      const transcriptSnapshot = transcriptBeforeSend;
      let planCaptureSource = transcriptSnapshot;
      if (backend && lastBackendRef.current !== backend) {
        lastBackendRef.current = backend;
        telemetryBindingRef.current = null;
        telemetryTotalRef.current = null;
        setTokenCount(0);
        updateRunningTotal(0);
      }
      const projectedTokens = estimateNextTurnTokens(wireMessage);
      if (projectedTokens >= ORCHESTRATOR_FORCE_COMPACT_THRESHOLD) {
        const compactingId = `orch-compacting-${Date.now()}`;
        const compactingAt = Date.now();
        statusRef.current = 'busy';
        setStatus('busy');
        setMessages((prev) => [...prev, {
          id: compactingId,
          role: 'system',
          text: 'Compacting to keep turn fast…',
          timestamp: compactingAt,
          timestampLabel: formatTimestampLabel(compactingAt),
        }]);
        try {
          const payload = await requestCompaction(activeRepoPath, runningTotalRef.current, {
            threadId: sendHandle.threadId,
          });
          if (threadIdRef.current !== sendHandle.threadId) return;
          const primed = payload ? await primeCompactedSession(activeRepoPath, payload, {
            threadId: sendHandle.threadId,
          }) : null;
          if (!mountedRef.current || repoPathRef.current !== activeRepoPath || threadIdRef.current !== sendHandle.threadId) return;
          const remaining = ORCHESTRATOR_COMPACTION_STATUS_MIN_MS - (Date.now() - compactingAt);
          if (remaining > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, remaining));
          }
          if (!mountedRef.current || repoPathRef.current !== activeRepoPath || threadIdRef.current !== sendHandle.threadId) return;
          if (!primed) {
            throw new Error(`Compaction failed before send. Re-send this message:\n\n${displayMessage}`);
          }
          if (!primed.resumePrelude) {
            throw new Error(`Compaction finished without a resume prelude. Re-send this message:\n\n${displayMessage}`);
          }
          const postCompactProjection = primed.nextTotal
            + ORCHESTRATOR_SYSTEM_PROMPT_ESTIMATE_TOKENS
            + ORCHESTRATOR_NEXT_TURN_BUFFER_TOKENS
            + approxTokens(wireMessage);
          if (postCompactProjection >= ORCHESTRATOR_FORCE_COMPACT_THRESHOLD) {
            clearQueuedOrchestratorSessionPrelude(activeRepoPath, threadIdRef.current);
            throw new Error(`Context is still above the 85% safety cap after compaction. Re-send this message:\n\n${displayMessage}`);
          }
          planCaptureSource = primed.transcript;
          setMessages((previous) => previous.filter(entry => entry.id !== compactingId));
        } catch (error) {
          activeTurnBackendRef.current = null;
          setMessages((prev) => [
            ...prev.filter((entry) => entry.id !== compactingId),
            {
              id: `orch-compacting-error-${Date.now()}`,
              role: 'system',
              text: error instanceof Error ? error.message : `Compaction failed before send. Re-send this message:\n\n${displayMessage}`,
              timestamp: Date.now(),
              timestampLabel: formatTimestampLabel(Date.now()),
            },
          ]);
          statusRef.current = connected ? 'ready' : 'connecting';
          setStatus(connected ? 'ready' : 'connecting');
          return;
        }
      }
      if (!mountedRef.current || repoPathRef.current !== activeRepoPath || threadIdRef.current !== sendHandle.threadId) return;
      const userEntry = optimisticUserEntry({
        id: sendHandle.userMessageId, text: displayMessage,
        timestamp: sentAtMs, timestampLabel: formatTimestampLabel(sentAtMs),
        attachments: turnOptions?.attachments,
      });
      messagesRef.current = [...messagesRef.current, userEntry, ...localEntriesAfterUser];
      setMessages((prev) => [...prev, userEntry, ...localEntriesAfterUser]);
      currentAssistantRef.current = null;
      captureFirstTurnPlanRef.current = !planTextRef.current
        && !hasHistoryRef.current
        && !planCaptureSource.some((entry) => !entry.voice && (entry.role === 'assistant' || entry.role === 'system' || entry.role === 'tool'));
      firstTurnPlanStartedRef.current = false;
      firstTurnPlanChunksRef.current = [];
      const outboundMessage = withSessionPrelude(
        wireMessage,
        consumeOrchestratorSessionPrelude(activeRepoPath, sendHandle.threadId),
        orchestrationMode,
      );
      turnTranscriptEventCountRef.current = 0;
      const payload = buildOrchestratorSendPayload({
        pinBackend: turnOptions?.pinBackend, repoPath: activeRepoPath,
        projectId: projectIdRef.current,
        threadId: sendHandle.threadId,
        clientMessageId,
        wireMessage: outboundMessage,
        // What the TRANSCRIPT stores/shows — the user's own words, never the
        // mode directives or resume prelude baked into the wire for the model.
        displayMessage,
        permissionMode,
        orchestrationMode, pickedMode,
        thinkingEffort, serviceTier,
        model,
        // Per-turn override stays truthful while the global default write settles.
        backend,
        collideBaseBackend,
        handoffMode: turnOptions?.handoffMode,
        attachments: turnOptions?.attachments,
        taskArtifactAction: turnOptions?.taskArtifactAction,
      });
      const pendingRecord = {
        text: outboundMessage,
        displayMessage,
        threadId: sendHandle.threadId,
        clientMessageId,
        sentAtMs,
        wirePayload: payload, attachmentsRequired: Boolean(turnOptions?.attachments?.length),
      };
      markDispatch(); durablePendingSend.recordPending(pendingRecord);
      const delivered = await deliverOrchestratorPayload({
        payload,
        getWebSocket: () => wsRef.current,
        connect: () => { console.warn('[orchestrator-stream] WS not open, attempting reconnect...'); connect(); },
      });

      if (!delivered) {
        activeTurnBackendRef.current = null;
        durablePendingSend.failPending(pendingRecord);
        return;
      }

      const deliveredAt = Date.now();
      lastSendAtRef.current = deliveredAt;
      lastEventAtRef.current = deliveredAt;
      durablePendingSend.armRecord(pendingRecord, deliveredAt);
      setPendingStatusBusy();
    });
    return sendHandle;
  }, [connect, connected, durablePendingSend, imageAdmissions, estimateNextTurnTokens, primeCompactedSession, requestCompaction, setPendingStatusBusy, turnOptionResolution, updateRunningTotal]);

  const undoSend = useCallback((handle: OrchestratorSendHandle) => {
    imageAdmissions.settle(handle.clientMessageId, { status: 'cancelled' });
    turnOptionResolution.abort(handle.clientMessageId);
    const activeRepoPath = repoPathRef.current;
    durablePendingSend.cancelPending(handle.clientMessageId);
    syncMessages(handle.transcriptBeforeSend);
    currentAssistantRef.current = null;
    activeTurnRef.current = null;
    activeTurnBackendRef.current = null;
    suppressTurnEventsRef.current = true;
    turnTranscriptEventCountRef.current = 0;
    resetFirstTurnPlanCapture();
    const nextStatus = connected ? 'ready' : 'connecting';
    statusRef.current = nextStatus;
    setStatus(nextStatus);
    setBusyState(createIdleBusyState());

    if (!activeRepoPath) return;
    const payload = JSON.stringify({
      type: 'orchestrator-undo-send',
      repoPath: activeRepoPath,
      threadId: handle.threadId,
      clientMessageId: handle.clientMessageId,
      userMessageId: handle.userMessageId,
      ...(handle.backend ? { backend: handle.backend } : {}),
    });
    void deliverOrchestratorPayload({
      payload,
      getWebSocket: () => wsRef.current,
      connect: () => { console.warn('[orchestrator-stream] WS not open, reconnecting to undo send...'); connect(); },
    });
  }, [connect, connected, durablePendingSend, imageAdmissions, resetFirstTurnPlanCapture, syncMessages, turnOptionResolution]);

  return {
    voiceTerminals,
    messages,
    planText,
    status,
    busyState,
    tokenCount,
    runningTotal,
    estimateNextTurnTokens,
    send,
    interrupt,
    undoSend,
    appendLocalEntries,
    replaceTranscript,
    fetchTelemetrySnapshot: async () => (
      await refreshTokenTelemetry() ?? { totalTokens: runningTotalRef.current, estimatedCostUsd: null, model: null }
    ),
    compactNow,
    reset,
    retryPendingSend: (clientMessageId) => { void durablePendingSend.retryPending(clientMessageId); },
    connected,
  };
}
