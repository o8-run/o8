/**
 * Shared desktop WebSocket context — one connection per dashboard page.
 *
 * Components subscribe to channels by registering callbacks via
 * useSharedDesktopWs(). The provider owns the single WS connection and
 * fans out incoming messages to all registered listeners.
 *
 * This replaces the per-component useDesktopWebSocket() pattern that was
 * opening 5 separate connections from the dashboard.
 */

'use client';

import { terminalProcessExitCode } from '@/lib/terminal/exit-state';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import type { DesktopWsCallbacks } from './useDesktopWebSocket';
import type {
  RealtimeBatchMessage,
  RealtimeEventEnvelope,
  RealtimeStreamKey,
  RealtimeSubscription,
  SessionHistoryRealtimePayload,
} from '@/lib/realtime/types';
import { getBrowserWsPort } from '@/lib/panel/ws-port-client';
import { openSurfaceWebSocket } from '@/lib/connect/open-surface-websocket';
import { TranscriptSessionSubscriptionProvider } from '@/lib/transcripts/useTranscript';
import {
  recordTerminalBenchTransport,
  terminalBenchEnabled,
} from '@/components/desktop/workspace-terminal/terminal-bench-instrumentation';

export type WsConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

const MAX_BACKOFF = 30_000;
const INITIAL_BACKOFF = 1_000;
const PING_INTERVAL = 20_000;

function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const { hostname, port, protocol } = window.location;
  const token = document.querySelector('meta[name="ws-token"]')?.getAttribute('content') ?? '';
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const wsProto = protocol === 'https:' ? 'wss' : 'ws';
  if (isLocal) {
    return `ws://${hostname}:${getBrowserWsPort()}/ws?token=${encodeURIComponent(token)}`;
  }
  const wsPort = port ? `:${port}` : '';
  return `${wsProto}://${hostname}${wsPort}/ws?token=${encodeURIComponent(token)}`;
}

// ── Imperative methods exposed by the shared connection ──

interface SharedWsCommands {
  switchSession: (sessionKey: string) => void;
  sendTerminalCreate: (cols: number, rows: number, requestId?: string, cwd?: string, ownerKey?: string, directPty?: boolean) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number, readOnly?: boolean) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalVisibility: (sessionName: string, visible: boolean, options?: { epoch?: number; needsResync?: boolean; cols?: number; rows?: number }) => void;
  sendTerminalDetach: (sessionName: string) => void;
  sendAgentKill: (sessionName: string, signal?: 'SIGTERM' | 'SIGINT') => void;
}

interface SharedWsState {
  connectionState: WsConnectionState;
  isConnected: boolean;
  connectionEpoch: number;
}

type ListenerId = number;

interface SharedWsContextValue extends SharedWsState, SharedWsCommands {
  /** Register a set of callbacks. Returns an unregister function. */
  addListener: (callbacks: DesktopWsCallbacks) => () => void;
  /** Subscribe the legacy chat/history channel to a focused session. */
  addLegacySessionSubscription: (sessionKey: string) => () => void;
  /** Add a session to the accumulated realtime transcript streams. */
  addRealtimeSessionSubscription: (sessionKey: string) => () => void;
}

// ── WS lifecycle → window event bridge ──
//
// The ws-server broadcasts `agent-lifecycle` / `lane-lifecycle` on every agent
// state change, and six surfaces listen for the matching WINDOW event. Nothing
// ever connected the two: that window event was dispatched only by two local
// kill-buttons, so every one of those surfaces was poll-only for any change that
// did not originate from a click in this window. That missing wire is the reason
// they poll at all.
//
// Every lifecycle payload stays observable on its original channel. Bulk
// refetch listeners use the separate signal below, so a fleet burst reconciles
// once without hiding intermediate terminal or retirement transitions.
const LIFECYCLE_COALESCE_MS = 250;
let lifecycleLastReconcile = 0;
let lifecycleTrailing: ReturnType<typeof setTimeout> | null = null;

function emitWindowLifecycle(
  name: 'o8:agent-lifecycle' | 'o8:lane-lifecycle',
  detail: { channel: string; event: string; data: Record<string, unknown> | undefined },
) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
  const now = Date.now();
  const sinceLast = now - lifecycleLastReconcile;

  if (sinceLast >= LIFECYCLE_COALESCE_MS) {
    lifecycleLastReconcile = now;
    window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
    return;
  }
  if (lifecycleTrailing) return;
  lifecycleTrailing = setTimeout(() => {
    lifecycleTrailing = null;
    lifecycleLastReconcile = Date.now();
    window.dispatchEvent(new Event('o8:lifecycle-reconcile'));
  }, LIFECYCLE_COALESCE_MS - sinceLast);
}

const SharedWsContext = createContext<SharedWsContextValue | null>(null);

/** Lightweight hook for components that only need WS connection state (e.g. approval polling). */
export function useWsConnectionState(): WsConnectionState {
  const ctx = useContext(SharedWsContext);
  return ctx?.connectionState ?? 'disconnected';
}

/** Changes once for each opened transport, including recovery after an offline mount. */
export function useWsConnectionEpoch(): number {
  return useContext(SharedWsContext)?.connectionEpoch ?? 0;
}

// ── Provider ──

export function DesktopWebSocketProvider({ children }: { children: ReactNode }) {
  const [connectionState, setConnectionState] = useState<WsConnectionState>('disconnected');
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const realtimeSubscriptionSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);
  const hasOpenedRef = useRef(false);
  const realtimeBootIdRef = useRef<string | null>(null);
  const realtimeSeqByStreamRef = useRef<Record<string, number>>({});

  // Callback registry — multiple components register their handlers
  const nextIdRef = useRef<ListenerId>(0);
  const listenersRef = useRef<Map<ListenerId, DesktopWsCallbacks>>(new Map());

  // Session subscriptions are reference-counted so multiple panes can observe
  // the same transcript without duplicating realtime streams. The server's
  // legacy history channel remains single-session, while realtime carries all
  // mounted/visible transcript sessions on the one shared socket.
  const sessionSubscriptionCountsRef = useRef<Map<string, number>>(new Map());
  const legacySessionSubscriptionsRef = useRef<Map<ListenerId, string>>(new Map());
  const realtimeSubscribedStreamsRef = useRef<Set<RealtimeStreamKey>>(new Set());
  const activeSessionKeyRef = useRef<string | undefined>(undefined);

  const syncRealtimeSubscriptions = useCallback((
    socket: WebSocket | null = wsRef.current,
    forceBootstrap = false,
  ) => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    const buildSubscription = (stream: RealtimeStreamKey): RealtimeSubscription => {
      const wasSubscribed = realtimeSubscribedStreamsRef.current.has(stream);
      const since = forceBootstrap
        ? undefined
        : (realtimeSeqByStreamRef.current[stream] ?? (wasSubscribed ? 0 : undefined));
      return since === undefined ? { stream } : { stream, since };
    };
    const subscriptions: RealtimeSubscription[] = [buildSubscription('global')];
    for (const sessionKey of sessionSubscriptionCountsRef.current.keys()) {
      subscriptions.push(buildSubscription(`session:${sessionKey}`));
    }
    socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions }));
    realtimeSubscribedStreamsRef.current = new Set(subscriptions.map((subscription) => subscription.stream));
  }, []);

  const scheduleRealtimeSubscriptionSync = useCallback(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    if (realtimeSubscriptionSyncTimerRef.current) return;
    realtimeSubscriptionSyncTimerRef.current = setTimeout(() => {
      realtimeSubscriptionSyncTimerRef.current = null;
      syncRealtimeSubscriptions();
    }, 0);
  }, [syncRealtimeSubscriptions]);

  const addListener = useCallback((callbacks: DesktopWsCallbacks) => {
    const id = nextIdRef.current++;
    listenersRef.current.set(id, callbacks);
    return () => { listenersRef.current.delete(id); };
  }, []);

  const addRealtimeSessionSubscription = useCallback((sessionKey: string) => {
    const currentCount = sessionSubscriptionCountsRef.current.get(sessionKey) ?? 0;
    sessionSubscriptionCountsRef.current.set(sessionKey, currentCount + 1);
    if (currentCount === 0) {
      scheduleRealtimeSubscriptionSync();
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = sessionSubscriptionCountsRef.current.get(sessionKey) ?? 0;
      if (count > 1) {
        sessionSubscriptionCountsRef.current.set(sessionKey, count - 1);
        return;
      }
      sessionSubscriptionCountsRef.current.delete(sessionKey);
      scheduleRealtimeSubscriptionSync();
    };
  }, [scheduleRealtimeSubscriptionSync]);

  const addLegacySessionSubscription = useCallback((sessionKey: string) => {
    const id = nextIdRef.current++;
    legacySessionSubscriptionsRef.current.set(id, sessionKey);
    activeSessionKeyRef.current = sessionKey;
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'switch-session', sessionKey }));
    }
    const releaseRealtime = addRealtimeSessionSubscription(sessionKey);

    return () => {
      legacySessionSubscriptionsRef.current.delete(id);
      releaseRealtime();
      if (activeSessionKeyRef.current !== sessionKey) return;
      const remaining = [...legacySessionSubscriptionsRef.current.values()];
      const nextKey = remaining[remaining.length - 1];
      activeSessionKeyRef.current = nextKey;
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'switch-session', sessionKey: nextKey ?? null }));
      }
    };
  }, [addRealtimeSessionSubscription]);

  // ── Imperative commands ──

  const wsSend = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const switchSession = useCallback((key: string) => {
    activeSessionKeyRef.current = key;
    wsSend({ type: 'switch-session', sessionKey: key });
  }, [wsSend]);

  const sendTerminalCreate = useCallback((cols: number, rows: number, requestId?: string, cwd?: string, ownerKey?: string, directPty?: boolean) => {
    wsSend({ type: 'terminal-create', cols, rows, requestId, cwd, ownerKey, directPty });
  }, [wsSend]);

  const sendTerminalAttach = useCallback((sessionName: string, cols: number, rows: number, readOnly = false) => {
    wsSend({ type: 'terminal-attach', sessionName, cols, rows, readOnly });
  }, [wsSend]);

  const sendTerminalInput = useCallback((sessionName: string, data: string) => {
    wsSend({ type: 'terminal-input', sessionName, data });
  }, [wsSend]);

  const sendTerminalResize = useCallback((sessionName: string, cols: number, rows: number) => {
    wsSend({ type: 'terminal-resize', sessionName, cols, rows });
  }, [wsSend]);

  const sendTerminalVisibility = useCallback((sessionName: string, visible: boolean, options?: { epoch?: number; needsResync?: boolean; cols?: number; rows?: number }) => {
    wsSend({ type: 'terminal-visibility', sessionName, visible, ...options });
  }, [wsSend]);

  const sendTerminalDetach = useCallback((sessionName: string) => {
    wsSend({ type: 'terminal-detach', sessionName });
  }, [wsSend]);

  const sendAgentKill = useCallback((sessionName: string, signal: 'SIGTERM' | 'SIGINT' = 'SIGTERM') => {
    wsSend({ type: 'agent-kill', sessionName, signal });
  }, [wsSend]);

  // ── Connection effect (runs once) ──

  useEffect(() => {
    disposedRef.current = false;
    hasOpenedRef.current = false;
    const url = getWsUrl();
    if (!url) return;

    function dispatch(method: keyof DesktopWsCallbacks, ...args: unknown[]) {
      for (const cb of listenersRef.current.values()) {
        const fn = cb[method] as ((...a: unknown[]) => void) | undefined;
        if (fn) {
          try { fn(...args); } catch { /* listener error */ }
        }
      }
    }

    function handleMessage(event: MessageEvent) {
      let msg: Record<string, unknown>;
      if (terminalBenchEnabled()) {
        const raw = typeof event.data === 'string' ? event.data : '';
        const parseStartedAt = performance.now();
        try { msg = JSON.parse(raw); } catch { return; }

        const channel = msg.channel as string;
        const eventType = msg.event as string;
        const data = msg.data as Record<string, unknown> | undefined;
        if (channel === 'terminal' && eventType === 'data' && typeof data?.data === 'string') {
          recordTerminalBenchTransport({
            rawBytes: raw.length,
            encodedBytes: data.data.length,
            jsonParseMs: performance.now() - parseStartedAt,
          });
        }
      } else {
        try { msg = JSON.parse(typeof event.data === 'string' ? event.data : ''); } catch { return; }
      }

      const channel = msg.channel as string;
      const eventType = msg.event as string;
      const data = msg.data as Record<string, unknown> | undefined;

      // Bridge WS events to window CustomEvents for TanStack Query invalidation.
      // Any useReactiveQuery({ wsEvents: ['lane-lifecycle'] }) will hear this.
      if (channel && channel !== 'system' && channel !== 'pong' && channel !== 'agent-lifecycle' && channel !== 'lane-lifecycle') {
        window.dispatchEvent(new CustomEvent(`o8:${channel}`, {
          detail: { channel, event: eventType, data },
        }));
      }

      switch (channel) {
        case 'system':
          if (eventType === 'connected') {
            const bootId = typeof data?.bootId === 'string' ? data.bootId : null;
            if (bootId && realtimeBootIdRef.current && realtimeBootIdRef.current !== bootId) {
              realtimeSeqByStreamRef.current = {};
            }
            if (bootId) realtimeBootIdRef.current = bootId;
            setConnectionState('connected');
            backoffRef.current = INITIAL_BACKOFF;
          }
          break;
        case 'realtime':
          if (eventType === 'batch' && Array.isArray(data?.events)) {
            const events = data.events as RealtimeEventEnvelope[];
            for (const realtimeEvent of events) {
              const previousStreamSeq = realtimeSeqByStreamRef.current[realtimeEvent.stream] ?? 0;
              const isNewerEvent = realtimeEvent.seq > previousStreamSeq;
              const capturedBeforeCurrentState = realtimeEvent.capturedSeq != null
                && previousStreamSeq > realtimeEvent.capturedSeq;
              realtimeSeqByStreamRef.current[realtimeEvent.stream] = Math.max(
                previousStreamSeq,
                realtimeEvent.seq,
              );
              dispatch('onRealtimeEvent', { ...realtimeEvent, delivery: (data as unknown as RealtimeBatchMessage).delivery ?? realtimeEvent.delivery });
              if (
                realtimeEvent.event === 'history.snapshot'
                && isNewerEvent
                && !capturedBeforeCurrentState
              ) {
                const payload = realtimeEvent.data as SessionHistoryRealtimePayload;
                const replace = Boolean(payload.replace);
                if (
                  payload.sessionKey
                  && Array.isArray(payload.entries)
                  && (payload.entries.length > 0 || replace)
                ) {
                  dispatch(
                    'onHistoryUpdate',
                    payload.sessionKey,
                    payload.entries as unknown as Array<Record<string, unknown>>,
                    replace,
                  );
                }
              }
            }
          }
          break;
        case 'inbox':
          if (eventType === 'update' && data) dispatch('onInboxUpdate', data);
          break;
        case 'history':
          if (eventType === 'update' && data) {
            const sk = data.sessionKey as string;
            const entries = data.entries as Array<Record<string, unknown>>;
            const replace = Boolean(data.replace);
            if (sk && Array.isArray(entries) && (entries.length > 0 || replace)) {
              dispatch('onHistoryUpdate', sk, entries, replace);
            }
          }
          break;
        case 'chat':
          if (eventType === 'delta' && data?.text) {
            dispatch('onChatDelta', data.text as string, (data.runId as string) ?? '');
          } else if (eventType === 'done') {
            dispatch('onChatDone', (data?.text as string) ?? '', (data?.runId as string) ?? '');
          } else if (eventType === 'error') {
            dispatch('onChatError', (data?.error as string) ?? 'Unknown error');
          }
          break;
        case 'review':
          if (data) dispatch('onReviewUpdate', { event: eventType, ...data });
          break;
        case 'terminal':
          if (eventType === 'created' && data) dispatch('onTerminalCreated', data.sessionName as string, data.requestId as string | undefined);
          else if (eventType === 'data' && data) dispatch('onTerminalData', data.sessionName as string, data.data as string, data.historical === true);
          else if (eventType === 'attached' && data) {
            dispatch('onTerminalAttached', data.sessionName as string);
            if (typeof data.cols === 'number' && typeof data.rows === 'number') {
              dispatch('onTerminalDimensions', data.sessionName as string, data.cols, data.rows);
            }
          }
          else if (eventType === 'dimensions' && data) dispatch('onTerminalDimensions', data.sessionName as string, data.cols as number, data.rows as number);
          else if (eventType === 'visibility-ready' && data) dispatch('onTerminalVisibilityReady', data.sessionName as string, data.epoch as number);
          else if (eventType === 'resync' && data) dispatch(
            'onTerminalResync',
            data.sessionName as string,
            data.data as string,
            data.epoch as number,
            data.historyTruncated === true,
            data.source === 'tmux' ? 'tmux' : 'scrollback',
          );
          else if (eventType === 'diagnostic' && data) dispatch('onTerminalDiagnostic', data);
          else if (eventType === 'exited' && data) dispatch('onTerminalExited', data.sessionName as string, terminalProcessExitCode(data.exitCode, data.exitCodeSource));
          else if (eventType === 'error' && data) dispatch('onTerminalError', data.sessionName as string, (data.error as string) ?? 'Unknown error');
          else if (eventType === 'image' && data) dispatch('onTerminalImage', data.sessionName as string, data.imageB64 as string, (data.filename as string) ?? 'image.png');
          break;
        case 'agent-lifecycle':
          if (data) dispatch('onAgentLifecycle', data.sessionName as string, data.state as string, data.exitCode as number | undefined);
          // The ws-server has always broadcast this. Six surfaces have always
          // listened for the matching WINDOW event (useAgentPanelState x3,
          // AgentPanelExtraAgents, footer-ports, OrchestratorRunStrip) — but
          // nothing ever bridged the two, so that window event was only fired by
          // two local kill-buttons. Every one of those surfaces was therefore
          // poll-only for any lifecycle change that did not originate from a
          // click in this window, which is exactly why they poll at all.
          emitWindowLifecycle('o8:agent-lifecycle', { channel, event: eventType, data });
          break;
        case 'lane-lifecycle':
          if (data) dispatch('onLaneLifecycle', data);
          emitWindowLifecycle('o8:lane-lifecycle', { channel, event: eventType, data });
          break;
        case 'pong':
          break;
      }
    }

    function connect() {
      if (disposedRef.current) return;
      setConnectionState(prev => prev === 'disconnected' ? 'connecting' : 'reconnecting');

      const ws = openSurfaceWebSocket(url);
      if (!ws) {
        setConnectionState('disconnected');
        return;
      }

      ws.onopen = () => {
        if (disposedRef.current) { ws.close(); return; }
        const isReconnect = hasOpenedRef.current;
        hasOpenedRef.current = true;
        wsRef.current = ws;
        setConnectionEpoch((epoch) => epoch + 1);
        // Keep durable inbox/transcript streams connected while a hidden
        // dashboard stops requesting background Git review scans.
        lastReviewVisible = undefined;
        syncReviewVisibility();
        // The legacy history channel can follow one session. Realtime carries
        // every ref-counted session through the accumulated subscription set.
        const key = activeSessionKeyRef.current;
        if (key) {
          ws.send(JSON.stringify({ type: 'subscribe', sessionKey: key }));
        }
        // Omitting `since` after reconnect requests one fresh bootstrap for
        // every active stream. Normal subscription changes retain sequence
        // cursors and only replay missed events.
        syncRealtimeSubscriptions(ws, isReconnect);
        pingTimerRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, PING_INTERVAL);
      };

      ws.onmessage = handleMessage;

      ws.onclose = () => {
        wsRef.current = null;
        if (pingTimerRef.current) { clearInterval(pingTimerRef.current); pingTimerRef.current = null; }
        if (!disposedRef.current) {
          setConnectionState('reconnecting');
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, backoffRef.current);
          backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF);
        }
      };

      ws.onerror = () => { /* onclose handles reconnect */ };
    }

    let lastReviewVisible: boolean | undefined;
    function syncReviewVisibility() {
      const socket = wsRef.current;
      if (socket?.readyState !== WebSocket.OPEN) return;
      const visible = document.visibilityState !== 'hidden';
      if (visible === lastReviewVisible) return;
      socket.send(JSON.stringify({ type: 'review-visibility', visible }));
      lastReviewVisible = visible;
    }

    document.addEventListener('visibilitychange', syncReviewVisibility);
    connect();

    return () => {
      disposedRef.current = true;
      document.removeEventListener('visibilitychange', syncReviewVisibility);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      if (realtimeSubscriptionSyncTimerRef.current) clearTimeout(realtimeSubscriptionSyncTimerRef.current);
      if (wsRef.current) wsRef.current.close();
      setConnectionState('disconnected');
    };
  }, [syncRealtimeSubscriptions]);

  const value = useMemo<SharedWsContextValue>(() => ({
    connectionState,
    connectionEpoch,
    isConnected: connectionState === 'connected',
    addListener,
    addLegacySessionSubscription,
    addRealtimeSessionSubscription,
    switchSession,
    sendTerminalCreate,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalVisibility,
    sendTerminalDetach,
    sendAgentKill,
  }), [
    connectionState, connectionEpoch, addListener, addLegacySessionSubscription, addRealtimeSessionSubscription,
    switchSession, sendTerminalCreate, sendTerminalAttach,
    sendTerminalInput, sendTerminalResize, sendTerminalVisibility, sendTerminalDetach,
    sendAgentKill,
  ]);

  return (
    <SharedWsContext.Provider value={value}>
      <TranscriptSessionSubscriptionProvider subscribe={addRealtimeSessionSubscription}>
        {children}
      </TranscriptSessionSubscriptionProvider>
    </SharedWsContext.Provider>
  );
}

// ── Consumer hook — drop-in replacement for useDesktopWebSocket ──

interface UseSharedDesktopWsResult {
  connectionState: WsConnectionState;
  isConnected: boolean;
  switchSession: (sessionKey: string) => void;
  sendTerminalCreate: (cols: number, rows: number, requestId?: string, cwd?: string, ownerKey?: string, directPty?: boolean) => void;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number, readOnly?: boolean) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalVisibility: (sessionName: string, visible: boolean, options?: { epoch?: number; needsResync?: boolean; cols?: number; rows?: number }) => void;
  sendTerminalDetach: (sessionName: string) => void;
  sendAgentKill: (sessionName: string, signal?: 'SIGTERM' | 'SIGINT') => void;
}

/**
 * Subscribe to the shared desktop WebSocket connection.
 * Same API as the old useDesktopWebSocket — callbacks are registered
 * with the shared provider and called when matching messages arrive.
 *
 * If sessionKey is provided, the connection is subscribed to that session
 * for chat/history events.
 */
export function useSharedDesktopWs(
  sessionKey: string | undefined,
  callbacks: DesktopWsCallbacks,
): UseSharedDesktopWsResult {
  const ctx = useContext(SharedWsContext);
  if (!ctx) throw new Error('useSharedDesktopWs must be used within DesktopWebSocketProvider');
  const { addListener, addLegacySessionSubscription } = ctx;

  // Register callbacks (synced via effect to avoid render-time ref mutation)
  const cbRef = useRef(callbacks);
  useEffect(() => { cbRef.current = callbacks; });

  // Stable wrapper so the listener registration doesn't change on every render
  const stableCallbacks = useMemo<DesktopWsCallbacks>(() => ({
    onChatDelta: (...args: Parameters<NonNullable<DesktopWsCallbacks['onChatDelta']>>) => cbRef.current.onChatDelta?.(...args),
    onChatDone: (...args: Parameters<NonNullable<DesktopWsCallbacks['onChatDone']>>) => cbRef.current.onChatDone?.(...args),
    onChatError: (...args: Parameters<NonNullable<DesktopWsCallbacks['onChatError']>>) => cbRef.current.onChatError?.(...args),
    onRealtimeEvent: (...args: Parameters<NonNullable<DesktopWsCallbacks['onRealtimeEvent']>>) => cbRef.current.onRealtimeEvent?.(...args),
    onInboxUpdate: (...args: Parameters<NonNullable<DesktopWsCallbacks['onInboxUpdate']>>) => cbRef.current.onInboxUpdate?.(...args),
    onHistoryUpdate: (...args: Parameters<NonNullable<DesktopWsCallbacks['onHistoryUpdate']>>) => cbRef.current.onHistoryUpdate?.(...args),
    onReviewUpdate: (...args: Parameters<NonNullable<DesktopWsCallbacks['onReviewUpdate']>>) => cbRef.current.onReviewUpdate?.(...args),
    onTerminalCreated: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalCreated']>>) => cbRef.current.onTerminalCreated?.(...args),
    onTerminalData: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalData']>>) => cbRef.current.onTerminalData?.(...args),
    onTerminalAttached: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalAttached']>>) => cbRef.current.onTerminalAttached?.(...args),
    onTerminalDimensions: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalDimensions']>>) => cbRef.current.onTerminalDimensions?.(...args),
    onTerminalVisibilityReady: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalVisibilityReady']>>) => cbRef.current.onTerminalVisibilityReady?.(...args),
    onTerminalResync: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalResync']>>) => cbRef.current.onTerminalResync?.(...args),
    onTerminalDiagnostic: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalDiagnostic']>>) => cbRef.current.onTerminalDiagnostic?.(...args),
    onTerminalExited: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalExited']>>) => cbRef.current.onTerminalExited?.(...args),
    onTerminalError: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalError']>>) => cbRef.current.onTerminalError?.(...args),
    onTerminalImage: (...args: Parameters<NonNullable<DesktopWsCallbacks['onTerminalImage']>>) => cbRef.current.onTerminalImage?.(...args),
    onAgentLifecycle: (...args: Parameters<NonNullable<DesktopWsCallbacks['onAgentLifecycle']>>) => cbRef.current.onAgentLifecycle?.(...args),
    onLaneLifecycle: (...args: Parameters<NonNullable<DesktopWsCallbacks['onLaneLifecycle']>>) => cbRef.current.onLaneLifecycle?.(...args),
  }), []);

  useEffect(() => addListener(stableCallbacks), [addListener, stableCallbacks]);

  // Subscribe to session for chat/history
  useEffect(() => {
    if (!sessionKey) return;
    return addLegacySessionSubscription(sessionKey);
  }, [addLegacySessionSubscription, sessionKey]);

  return {
    connectionState: ctx.connectionState,
    isConnected: ctx.isConnected,
    switchSession: ctx.switchSession,
    sendTerminalCreate: ctx.sendTerminalCreate,
    sendTerminalAttach: ctx.sendTerminalAttach,
    sendTerminalInput: ctx.sendTerminalInput,
    sendTerminalResize: ctx.sendTerminalResize,
    sendTerminalVisibility: ctx.sendTerminalVisibility,
    sendTerminalDetach: ctx.sendTerminalDetach,
    sendAgentKill: ctx.sendAgentKill,
  };
}
