'use client';

/**
 * useOrchestratorMobile — dedicated WS + history hook for the mobile
 * Orchestrator tab.
 *
 * Why a second WS connection: the main mobile useWebSocket hook subscribes
 * to the `orchestrator` channel on the *currently selected session's*
 * repoPath, which is fine for the inline orchestrator status pill on the
 * chat surface. The Orchestrator tab needs to subscribe to whatever repo
 * the user picked from the thread list — independently of session focus.
 * Opening a parallel client is the cleanest way to do that without
 * threading state through the existing hook.
 *
 * Channels handled (mirrors src/ws-server.ts):
 *   orchestrator/output       text + thinking deltas
 *   orchestrator/tool-use     name + args
 *   orchestrator/tool-result  output preview
 *   orchestrator/status       ready | busy | dead
 *   orchestrator/error        error string
 *
 * Output deltas accumulate into the LAST assistant entry until a `done`
 * status arrives, at which point the buffer is committed and the next
 * delta starts a new entry.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { serializeTranscriptForStorage, type StoredTranscriptMessage } from '@/lib/transcripts/history-serde';
import { historyToMobileTranscript as historyToTranscript, placeMobileTranscript, rememberMobileToolBoundary, useMobileSteerHistory, type MobileToolBoundary } from './orchestrator-mobile-history';
import { getBrowserWsPort } from '@/lib/panel/ws-port-client';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import { skipDuplicateBySeq } from '@/lib/orchestrator/replay-cursor';
import type {
  MobileOrchestratorThread,
  MobileOrchestratorTranscriptEntry,
  MobileTranscriptEntry,
} from '@/lib/mobile/types';
import {
  enqueuePending,
  generatePendingId,
  getPendingQueue,
  isPendingStale,
  removePending,
  refreshPending,
  PENDING_QUEUE_MAX,
  type PendingQueueItem,
} from '@/lib/mobile/pending-queue';
import {
  buildMobileOrchestratorInterrupt,
  buildMobileOrchestratorSend,
  buildMobileOrchestratorStatus,
  buildMobileOrchestratorSubscribe,
  buildMobileOrchestratorUnsubscribe,
  mobileOrchestratorRouteFromThread,
  mobileOrchestratorRouteKey,
  type MobileOrchestratorRoute,
} from '@/lib/mobile/orchestrator-wire';

export type MobileOrchestratorConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

export type MobileOrchestratorTurnStatus = 'idle' | 'busy' | 'error';

interface UseOrchestratorMobileArgs {
  /** Active thread (already loaded from threads list). null = no thread picked. */
  activeThread: MobileOrchestratorThread | null;
}

interface UseOrchestratorMobileResult {
  connectionState: MobileOrchestratorConnectionState;
  turnStatus: MobileOrchestratorTurnStatus;
  transcript: MobileOrchestratorTranscriptEntry[];
  transcriptLoading: boolean;
  errorNote: string | null;
  sendMessage: (text: string) => void;
  interrupt: () => void;
  resetTranscript: () => void;
  retryQueued: (queueId: string) => void;
  discardQueued: (queueId: string) => void;
}

const INITIAL_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;
const PING_INTERVAL = 20_000;
const STREAM_FLUSH_MS = 60;
const PERSIST_DEBOUNCE_MS = 800;

function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const { hostname, protocol } = window.location;
  const token = getMobileWsToken();
  // [mobile-lan] Always hit the ws-server port directly. Next.js's
  // /ws rewrite does not proxy WebSocket upgrades — see useWebSocket.ts
  // for the full explanation.
  const wsProto = protocol === 'https:' ? 'wss' : 'ws';
  return `${wsProto}://${hostname}:${getBrowserWsPort()}/ws?token=${encodeURIComponent(token)}`;
}

function transcriptIdFor(prefix: 'user' | 'assistant' | 'tool' | 'system') {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function toolPreviewFromOutput(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine) return undefined;
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}


export function useOrchestratorMobile({
  activeThread,
}: UseOrchestratorMobileArgs): UseOrchestratorMobileResult {
  const [connectionState, setConnectionState] = useState<MobileOrchestratorConnectionState>('disconnected');
  const [turnStatus, setTurnStatus] = useState<MobileOrchestratorTurnStatus>('idle');
  const [transcript, setTranscript] = useState<MobileOrchestratorTranscriptEntry[]>([]);
  const [toolBoundaries, setToolBoundaries] = useState<ReadonlyMap<string, MobileToolBoundary>>(new Map());
  const [historySources, setHistorySources] = useState<ReadonlyMap<string, MobileTranscriptEntry>>(new Map());
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [errorNote, setErrorNote] = useState<string | null>(null);
  const transcriptRef = useRef(transcript);
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);

  const wsRef = useRef<WebSocket | null>(null);
  const disposedRef = useRef(false);
  const backoffRef = useRef(INITIAL_BACKOFF);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The full thread route we're currently subscribed to on the WS. A repo can
  // host several orchestrator threads with different backends, so repoPath
  // alone is not a safe subscription identity.
  const subscribedRouteRef = useRef<MobileOrchestratorRoute | null>(null);
  const routeRef = useRef<MobileOrchestratorRoute | null>(
    mobileOrchestratorRouteFromThread(activeThread),
  );
  // Replay cursor — highest orchestrator event seq applied for the current
  // session view. Sent as `since` on (re)subscribe so a reconnect recovers the
  // in-flight turn's missed tokens; reset to 0 on a repo switch.
  const lastSeqRef = useRef(0);

  // Streaming buffer for the current assistant turn. Output deltas append to
  // .text and we flush to the React transcript on a 60ms interval to keep
  // re-renders cheap on phone.
  const streamingBufferRef = useRef<{
    id: string;
    text: string;
    thinking: boolean;
    flushed: boolean;
  } | null>(null);
  const sealedOutputRef = useRef<{ id: string; text: string } | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    routeRef.current = mobileOrchestratorRouteFromThread(activeThread);
  }, [activeThread]);

  // ── Persistence (debounced) ──
  // Mobile transcripts must round-trip to disk so they survive reloads,
  // process restarts, and switching back from desktop. The desktop persists
  // via usePersistChatThread; mobile owns the same job here. We POST the
  // user/assistant entries to /api/v2/chat-history under the active thread's
  // tabId, keyed off the thread metadata so the threads-list endpoint can
  // surface it on the next fetch.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistThread = useCallback((entries: MobileOrchestratorTranscriptEntry[], thread: MobileOrchestratorThread) => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      const messages = serializeTranscriptForStorage(entries
        // Skip queued entries — they live in the pending-queue localStorage
        // until reconnect commits them; persisting both would duplicate the
        // bubble on reload (once from chat-history, once from queue).
        .filter((entry) => (entry.role === 'user' || entry.role === 'assistant') && !entry.queued)
        .map((entry) => ({
          ...historySources.get(entry.id),
          id: entry.id,
          role: entry.role,
          text: entry.text,
          timestamp: entry.timestamp ?? Date.now(),
        })));
      if (messages.length === 0) return;
      const firstUserText = entries.find((entry) => entry.role === 'user')?.text ?? '';
      const fallbackTitle = firstUserText
        ? firstUserText.slice(0, 60).replace(/\n/g, ' ') + (firstUserText.length > 60 ? '...' : '')
        : undefined;
      const wsToken = getMobileWsToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (wsToken) headers.Authorization = `Bearer ${wsToken}`;
      void fetch('/api/v2/chat-history', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tabId: thread.id,
          messages,
          model: 'claude-code',
          repoPath: thread.repoPath ?? undefined,
          repoName: thread.repoName ?? undefined,
          repoBranch: thread.repoBranch ?? undefined,
          title: thread.title && thread.title !== 'New conversation' ? thread.title : fallbackTitle,
        }),
      }).catch((error) => console.log('[mobile-orchestrator] persist failed', error));
    }, PERSIST_DEBOUNCE_MS);
  }, [historySources]);

  const flushStreamingBuffer = useCallback(() => {
    const buffer = streamingBufferRef.current;
    if (!buffer || buffer.flushed) return;
    buffer.flushed = true;

    setTranscript((current) => {
      const index = current.findIndex(entry => entry.id === buffer.id);
      const last = current[index];
      if (last) {
        if (last.text === buffer.text && last.thinking === buffer.thinking) return current;
        const next = current.slice();
        next[index] = { ...last, text: buffer.text, thinking: buffer.thinking };
        return next;
      }
      return [
        ...current,
        {
          id: buffer.id,
          role: 'assistant',
          text: buffer.text,
          thinking: buffer.thinking,
          timestamp: Date.now(),
        },
      ];
    });
  }, []);

  const sealStreamingBuffer = useCallback(() => {
    // A later event can arrive before the flushed prefix reaches the transcript.
    const buffer = streamingBufferRef.current;
    if (buffer) sealedOutputRef.current = { id: buffer.id, text: buffer.text };
    flushStreamingBuffer();
    streamingBufferRef.current = null;
  }, [flushStreamingBuffer]);

  // ── Load thread history when the active thread changes ──
  // IMPORTANT: depend on activeThread?.id (not the object). The threads
  // strip polls every 8s which produces a fresh `threads` array → new
  // `activeThread` object reference → if we depend on the object we
  // re-fetch history and clobber the in-memory transcript (including the
  // user message + streaming assistant reply that haven't been persisted
  // server-side yet). Keying on .id keeps the transcript stable across
  // polling refreshes for the same thread.
  const activeThreadId = activeThread?.id ?? null;
  const receiveSteerHistory = useMobileSteerHistory(activeThreadId, setHistorySources, setTranscript);
  useEffect(() => {
    sealedOutputRef.current = null;
    setToolBoundaries(new Map());
    if (!activeThreadId) {
      setHistorySources(new Map());
      setTranscript([]);
      setTranscriptLoading(false);

      streamingBufferRef.current = null;
      return;
    }

    let cancelled = false;
    setTranscriptLoading(true);
    setErrorNote(null);

    fetch(`/api/v2/chat-history?tabId=${encodeURIComponent(activeThreadId)}`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { messages?: StoredTranscriptMessage[] };
        if (cancelled) return;
        const { entries, sources } = historyToTranscript(data.messages ?? []);
        setHistorySources(sources);
        setTranscript(entries);
      })
      .catch((error) => {
        console.log('[mobile-orchestrator] history load failed', error);
        if (!cancelled) {
          setHistorySources(new Map());
          setTranscript([]);
          setErrorNote('Unable to load thread history.');
        }
      })
      .finally(() => {
        if (!cancelled) setTranscriptLoading(false);
      });

    streamingBufferRef.current = null;

    return () => {
      cancelled = true;
    };
  }, [activeThreadId]);

  // ── Persist transcript whenever it changes for the active thread ──
  // Skip while the initial history fetch is in flight (otherwise we'd race
  // the load and write a blank file before the prior messages arrive).
  useEffect(() => {
    if (!activeThread) return;
    if (transcriptLoading) return;
    if (transcript.length === 0) return;
    persistThread(transcript, activeThread);
  }, [transcript, activeThread, transcriptLoading, persistThread]);

  // Cancel any pending persist on unmount.
  useEffect(() => () => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
  }, []);

  // ── Subscribe / re-subscribe to the active orchestrator thread route ──
  const sendSubscription = useCallback((ws: WebSocket | null) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const next = routeRef.current;
    const prev = subscribedRouteRef.current;
    const nextKey = mobileOrchestratorRouteKey(next);
    const prevKey = mobileOrchestratorRouteKey(prev);
    if (prev && prevKey !== nextKey) {
      ws.send(JSON.stringify(buildMobileOrchestratorUnsubscribe(prev)));
      subscribedRouteRef.current = null;
      lastSeqRef.current = 0;
    }
    if (!next) return;
    if (prevKey !== nextKey) {
      // since=lastSeq: 0 on a repo switch (reset above), or the live cursor on a
      // reconnect (onclose nulls the subscribed route) so we replay missed events.
      ws.send(JSON.stringify(buildMobileOrchestratorSubscribe(next, lastSeqRef.current)));
      ws.send(JSON.stringify(buildMobileOrchestratorStatus(next)));
      subscribedRouteRef.current = next;
    } else {
      ws.send(JSON.stringify(buildMobileOrchestratorStatus(next)));
    }
  }, []);

  useEffect(() => {
    sendSubscription(wsRef.current);
  }, [
    activeThread?.agent,
    activeThread?.backend,
    activeThread?.id,
    activeThread?.repoPath,
    sendSubscription,
  ]);

  // ── WS connection lifecycle ──
  useEffect(() => {
    disposedRef.current = false;
    const url = getWsUrl();
    if (!url) return;

    function handleMessage(event: MessageEvent) {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }

      const channel = raw.channel as string;
      if (channel === 'system' && raw.event === 'connected') {
        setConnectionState('connected');
        backoffRef.current = INITIAL_BACKOFF;
        // Flush any pending offline-queued user sends in FIFO order.
        // Defer one tick so the subscription send above lands first.
        setTimeout(() => drainQueueRef.current?.(), 0);
      }
      if (channel === 'realtime') { receiveSteerHistory(raw); return; }
      if (channel !== 'orchestrator') return;
      // Skip replayed events we've already applied (no double tokens).
      if (skipDuplicateBySeq(raw, lastSeqRef)) return;

      const eventType = raw.event as string;
      const data = (raw.data as Record<string, unknown> | undefined) ?? {};
      const currentRoute = routeRef.current;
      const eventThreadId = typeof data.threadId === 'string' ? data.threadId : null;
      const eventRepoPath = typeof data.repoPath === 'string' ? data.repoPath : null;
      if (currentRoute && (
        (eventThreadId && eventThreadId !== currentRoute.threadId)
        || (eventRepoPath && eventRepoPath !== currentRoute.repoPath)
      )) {
        return;
      }

      switch (eventType) {
        case 'send-ack': {
          const clientMessageId = typeof data.clientMessageId === 'string'
            ? data.clientMessageId
            : typeof data.clientMutationId === 'string'
              ? data.clientMutationId
              : null;
          const ackThreadId = typeof data.threadId === 'string'
            ? data.threadId
            : currentRoute?.threadId ?? null;
          if (!clientMessageId || !ackThreadId) break;
          removePending('orchestrator', ackThreadId, clientMessageId);
          pendingItemsRef.current.delete(clientMessageId);
          setTranscript((current) => current.map((entry) =>
            entry.queueId === clientMessageId
              ? { ...entry, queued: false, queueId: undefined, queueStale: undefined }
              : entry,
          ));
          break;
        }
        case 'output': {
          const text = typeof data.text === 'string' ? data.text : '';
          const thinking = data.thinking === true;
          if (!text) return;
          setTurnStatus('busy');
          const messageId = typeof data.assistantMessageId === 'string' ? data.assistantMessageId : null;
          let buffer = streamingBufferRef.current;
          if (buffer && messageId && buffer.id !== messageId) { sealStreamingBuffer(); buffer = null; }
          if (!buffer) {
            const id = messageId ?? transcriptIdFor('assistant');
            const previous = sealedOutputRef.current?.id === id
              ? sealedOutputRef.current
              : transcriptRef.current.find(entry => entry.id === id);
            streamingBufferRef.current = {
              id,
              text: (previous?.text ?? '') + text,
              thinking,
              flushed: false,
            };
          } else {
            buffer.text = `${buffer.text}${text}`;
            buffer.thinking = thinking;
            buffer.flushed = false;
          }
          break;
        }
        case 'tool-use': {
          const name = typeof data.name === 'string' ? data.name : 'tool';
          const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : null;
          // Seal any in-flight assistant buffer so the tool entry slots in
          // after the assistant's prose, not before it.
          const output = streamingBufferRef.current;
          const assistantId = typeof data.assistantMessageId === 'string' ? data.assistantMessageId : output?.id;
          const entryId = toolUseId ? `tool:${toolUseId}` : transcriptIdFor('tool');
          if (assistantId) {
            const prefix = output?.text ?? transcriptRef.current.find(entry => entry.id === assistantId)?.text ?? '';
            setToolBoundaries(current => rememberMobileToolBoundary(current, entryId, assistantId, prefix));
          }
          sealStreamingBuffer();
          // Stable id keyed off toolUseId when we have one, so tool-result
          // can find the matching entry deterministically.
          setTranscript((current) => [
            ...current,
            {
              id: entryId,
              role: 'tool',
              text: name,
              toolName: name,
              toolDone: false,
              timestamp: Date.now(),
            },
          ]);
          setTurnStatus('busy');
          break;
        }
        case 'tool-result': {
          // Flip the matching tool entry from "running" to "done" and attach
          // a tiny preview so the user gets confirmation the tool finished.
          // Match by toolUseId when present (deterministic), otherwise fall
          // back to the most recent unfinished tool entry with the same name.
          const name = typeof data.name === 'string' ? data.name : null;
          const toolUseId = typeof data.toolUseId === 'string' ? data.toolUseId : null;
          const preview = toolPreviewFromOutput(data.output);
          setTranscript((current) => {
            const targetId = toolUseId ? `tool:${toolUseId}` : null;
            // Walk backwards looking for the first matching unfinished tool entry.
            for (let i = current.length - 1; i >= 0; i -= 1) {
              const entry = current[i];
              if (entry.role !== 'tool') continue;
              if (entry.toolDone) continue;
              const idMatches = targetId ? entry.id === targetId : true;
              const nameMatches = name ? entry.toolName === name : true;
              if (idMatches && nameMatches) {
                const next = current.slice();
                next[i] = { ...entry, toolDone: true, toolPreview: preview };
                return next;
              }
              // First-fail-fast: if we have a toolUseId but it didn't match,
              // keep walking — the matching entry may be earlier in history.
              if (targetId) continue;
              // No toolUseId: only match the most recent unfinished entry.
              break;
            }
            return current;
          });
          break;
        }
        case 'status': {
          const status = data.status;
          if (status === 'ready') {
            sealStreamingBuffer();
            setTurnStatus('idle');
          } else if (status === 'busy') {
            setTurnStatus('busy');
          } else if (status === 'dead') {
            sealStreamingBuffer();
            setTurnStatus('idle');
            setErrorNote('Orchestrator session ended.');
          }
          break;
        }
        case 'error': {
          const message = typeof data.error === 'string' ? data.error : 'Orchestrator error.';
          sealStreamingBuffer();
          setTurnStatus('error');
          setErrorNote(message);
          break;
        }
        default:
          break;
      }
    }

    function connect() {
      if (disposedRef.current) return;
      setConnectionState((prev) => (prev === 'disconnected' ? 'connecting' : 'reconnecting'));
      const ws = new WebSocket(url);

      ws.onopen = () => {
        if (disposedRef.current) {
          ws.close();
          return;
        }
        wsRef.current = ws;
        backoffRef.current = INITIAL_BACKOFF;
        sendSubscription(ws);
        ws.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, PING_INTERVAL);
      };

      ws.onmessage = handleMessage;

      ws.onclose = () => {
        wsRef.current = null;
        subscribedRouteRef.current = null;
        if (pingTimerRef.current) {
          clearInterval(pingTimerRef.current);
          pingTimerRef.current = null;
        }
        if (disposedRef.current) {
          setConnectionState('disconnected');
          return;
        }
        setConnectionState('reconnecting');
        const delay = backoffRef.current;
        backoffRef.current = Math.min(delay * 2, MAX_BACKOFF);
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
      };

      ws.onerror = () => {
        // onclose follows automatically.
      };
    }

    flushTimerRef.current = setInterval(() => {
      flushStreamingBuffer();
    }, STREAM_FLUSH_MS);

    connect();

    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (pingTimerRef.current) {
        clearInterval(pingTimerRef.current);
        pingTimerRef.current = null;
      }
      if (flushTimerRef.current) {
        clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      subscribedRouteRef.current = null;
      setConnectionState('disconnected');
    };
  }, [flushStreamingBuffer, receiveSteerHistory, sealStreamingBuffer, sendSubscription]);

  // ── Pending offline-queue (packet #646) ──
  // When the WS is disconnected/reconnecting, user sends are persisted to
  // localStorage under `o8:mobile:orchestrator-pending:<tabId>` and replayed
  // on the next `system/connected` event. The transcript also carries a
  // `queued` flag so the user sees their message immediately with a "queued"
  // pill, and stale-queued items (>1h) surface Retry/Discard.
  const activeThreadIdForQueue = activeThread?.id ?? null;
  const pendingItemsRef = useRef<Map<string, PendingQueueItem>>(new Map());

  const buildQueuedTranscriptEntry = useCallback(
    (item: PendingQueueItem): MobileOrchestratorTranscriptEntry => ({
      id: `queued:${item.id}`,
      role: 'user',
      text: item.text,
      timestamp: item.queuedAt,
      queued: true,
      queueId: item.id,
      queueStale: isPendingStale(item),
    }),
    [],
  );

  // Load any persisted queued items into transcript so a page reload
  // mid-offline-state still shows the queued bubbles. Wait for the history
  // fetch to settle (transcriptLoading flips false) so we don't race the
  // history setTranscript() and lose the appended queued bubbles.
  useEffect(() => {
    if (!activeThreadIdForQueue) {
      pendingItemsRef.current = new Map();
      return;
    }
    if (transcriptLoading) return;
    const stored = getPendingQueue('orchestrator', activeThreadIdForQueue);
    pendingItemsRef.current = new Map(stored.map((item) => [item.id, item]));
    if (stored.length === 0) return;
    setTranscript((current) => {
      const existingIds = new Set(
        current
          .flatMap((entry) => [
            ...(entry.queueId ? [entry.queueId] : []),
            ...(entry.id.startsWith('orch-user-') ? [entry.id.slice('orch-user-'.length)] : []),
          ]),
      );
      const additions = stored
        .filter((item) => !existingIds.has(item.id))
        .map(buildQueuedTranscriptEntry);
      return additions.length > 0 ? [...current, ...additions] : current;
    });
  }, [activeThreadIdForQueue, buildQueuedTranscriptEntry, transcriptLoading]);

  const dispatchOverWs = useCallback((message: string, queueId: string | null) => {
    const ws = wsRef.current;
    const route = routeRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !route) return false;
    if (mobileOrchestratorRouteKey(subscribedRouteRef.current) !== mobileOrchestratorRouteKey(route)) {
      sendSubscription(ws);
    }
    ws.send(JSON.stringify(buildMobileOrchestratorSend(route, message, queueId)));
    return true;
  }, [sendSubscription]);

  const drainQueueRef = useRef<(() => void) | null>(null);
  const drainQueue = useCallback(() => {
    const tabId = activeThreadIdForQueue;
    if (!tabId) return;
    const pending = getPendingQueue('orchestrator', tabId);
    if (pending.length === 0) return;
    let drainedAny = false;
    let promotedBusy = false;
    for (const item of pending) {
      if (isPendingStale(item)) continue;
      const sent = dispatchOverWs(item.text, item.id);
      if (!sent) break;
      drainedAny = true;
      if (!promotedBusy) {
        setTurnStatus('busy');
        promotedBusy = true;
      }
    }
    if (drainedAny) {
      setErrorNote(null);
      streamingBufferRef.current = null;
    }
  }, [activeThreadIdForQueue, dispatchOverWs]);

  // ── Imperative actions ──
  const sendMessage = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const route = routeRef.current;
    const tabId = activeThreadIdForQueue;
    if (!route) {
      setErrorNote('Pick a thread with a repo first.');
      return;
    }
    if (!tabId) {
      setErrorNote('Not connected — try again in a moment.');
      return;
    }
    const item = enqueuePending('orchestrator', tabId, trimmed, generatePendingId());
    if (!item) {
      setErrorNote(`Queue full (${PENDING_QUEUE_MAX}). Wait for reconnect.`);
      return;
    }
    pendingItemsRef.current.set(item.id, item);
    setErrorNote(null);
    setTranscript((current) => [...current, buildQueuedTranscriptEntry(item)]);
    streamingBufferRef.current = null;
    if (dispatchOverWs(item.text, item.id)) {
      setTurnStatus('busy');
    }
  }, [activeThreadIdForQueue, buildQueuedTranscriptEntry, dispatchOverWs]);

  const retryQueued = useCallback((queueId: string) => {
    const tabId = activeThreadIdForQueue;
    if (!tabId) return;
    const item = pendingItemsRef.current.get(queueId)
      ?? getPendingQueue('orchestrator', tabId).find((entry) => entry.id === queueId)
      ?? null;
    if (!item) return;
    // Reset queuedAt while preserving the idempotency identity, then retry.
    const replacement = refreshPending('orchestrator', tabId, queueId);
    if (!replacement) {
      setErrorNote('This queued message is no longer available.');
      return;
    }
    pendingItemsRef.current.set(replacement.id, replacement);
    setTranscript((current) => current.map((entry) =>
      entry.queueId === queueId
        ? { ...entry, queueStale: false, timestamp: replacement.queuedAt }
        : entry,
    ));
    drainQueue();
  }, [activeThreadIdForQueue, drainQueue]);

  const discardQueued = useCallback((queueId: string) => {
    const tabId = activeThreadIdForQueue;
    if (!tabId) return;
    removePending('orchestrator', tabId, queueId);
    pendingItemsRef.current.delete(queueId);
    setTranscript((current) => current.filter((entry) => entry.queueId !== queueId));
  }, [activeThreadIdForQueue]);

  // Keep the latest drainQueue closure addressable from the WS message handler
  // (which only closes over the initial render's value).
  useEffect(() => {
    drainQueueRef.current = drainQueue;
  }, [drainQueue]);

  const interrupt = useCallback(() => {
    const ws = wsRef.current;
    const route = routeRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !route) return;
    ws.send(JSON.stringify(buildMobileOrchestratorInterrupt(route)));
    setTurnStatus('idle');
    sealStreamingBuffer();
  }, [sealStreamingBuffer]);

  const resetTranscript = useCallback(() => {
    sealedOutputRef.current = null;
    setTranscript([]);
    setErrorNote(null);
    streamingBufferRef.current = null;
  }, []);

  // Split only the returned view. Persistence above retains each aggregate and
  // its original metadata, using the same placement as the desktop renderer.
  const presentedTranscript = useMemo(() => placeMobileTranscript(transcript, historySources, toolBoundaries),
    [transcript, historySources, toolBoundaries]);
  return {
    connectionState,
    turnStatus,
    transcript: presentedTranscript,
    transcriptLoading,
    errorNote,
    sendMessage,
    interrupt,
    resetTranscript,
    retryQueued,
    discardQueued,
  };
}
