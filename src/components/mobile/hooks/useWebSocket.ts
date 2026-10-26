/**
 * Unified WebSocket hook for o8 mobile.
 *
 * Connects to the WS server (port 3002) and receives all real-time data
 * over a single connection. Falls back to polling if WS is unavailable.
 *
 * Channels received:
 *   system  — connection status
 *   inbox   — session list updates
 *   history — transcript updates
 *   chat    — streaming deltas
 *   pong    — keepalive
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { getBrowserWsPort } from '@/lib/panel/ws-port-client';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type {
  MobileInboxSnapshot,
  MobileTranscriptEntry,
} from '@/lib/mobile/types';
import { formatStreamingPreview } from '../utils';
import { sameMobileInboxSnapshot } from '@/lib/mobile/inbox-signature';
import { getMobileWsToken } from '@/lib/mobile/ws-token-client';
import { skipDuplicateBySeq } from '@/lib/orchestrator/replay-cursor';
import { isWebMachineBrowserSurface } from '@/lib/connect/web-machine-surface';
import { openSurfaceWebSocket } from '@/lib/connect/open-surface-websocket';
import type {
  MobileInboxRealtimeSnapshotPayload,
  RealtimeEventEnvelope,
  RealtimeMutationRecord,
  RealtimeSubscription,
  SessionHistoryRealtimePayload,
} from '@/lib/realtime/types';
import type { MobileOrchestratorStatus } from '../types';

export type WsConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface UseWebSocketArgs {
  selectedSessionKey?: string;
  selectedRepoPath?: string | null;
  setSnapshot: Dispatch<SetStateAction<MobileInboxSnapshot>>;
  setRefreshError: Dispatch<SetStateAction<string | null>>;
  setHistoryBySession: Dispatch<SetStateAction<Record<string, MobileTranscriptEntry[]>>>;
  setStreamingText: Dispatch<SetStateAction<string>>;
  streamingTextRef: MutableRefObject<string>;
  setActionStateBySession: Dispatch<SetStateAction<Record<string, 'idle' | 'steering' | 'stopping' | 'reviewing'>>>;
  setActionNoteBySession: Dispatch<SetStateAction<Record<string, string | null>>>;
  setRealtimeMutationsById: Dispatch<SetStateAction<Record<string, RealtimeMutationRecord>>>;
  setPendingMutationIdBySession: Dispatch<SetStateAction<Record<string, string>>>;
  pendingMutationIdBySessionRef: MutableRefObject<Record<string, string>>;
}

interface UseWebSocketResult {
  connectionState: WsConnectionState;
  isConnected: boolean;
  orchestratorStatus: MobileOrchestratorStatus;
  orchestratorNote: string | null;
  sendTerminalAttach: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalInput: (sessionName: string, data: string) => void;
  sendTerminalResize: (sessionName: string, cols: number, rows: number) => void;
  sendTerminalDetach: (sessionName: string) => void;
}

const MAX_BACKOFF = 30_000;
const INITIAL_BACKOFF = 1_000;
const PING_INTERVAL = 20_000;

function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  if (isWebMachineBrowserSurface()) return '';
  const { hostname, protocol } = window.location;
  // Auth token — prevents random network clients from connecting
  const token = getMobileWsToken();

  // [mobile-lan] Connect directly to the ws-server port on the same host as
  // the page. We used to try the same-port `/ws` rewrite for LAN/Tailscale
  // hosts, but Next.js's standalone server does NOT proxy WebSocket upgrades
  // through `next.config.ts:rewrites()` — only HTTP. The upgrade returns 404
  // and the client retries forever.
  //
  // With O8_LAN_ACCESS=1 the ws-server binds 0.0.0.0:<wsPort> (see
  // src/lib/panel/listen-host.ts; default is 127.0.0.1), so the LAN IP from
  // the phone's perspective is reachable on the ws port directly. The token query param
  // is verified by ws-server's verifyClient before the upgrade completes.
  const wsProto = protocol === 'https:' ? 'wss' : 'ws';
  return `${wsProto}://${hostname}:${getBrowserWsPort()}/ws?token=${encodeURIComponent(token)}`;
}

export function useWebSocket({
  selectedSessionKey,
  selectedRepoPath,
  setSnapshot,
  setRefreshError,
  setHistoryBySession,
  setStreamingText,
  streamingTextRef,
  setActionStateBySession,
  setActionNoteBySession,
  setRealtimeMutationsById,
  setPendingMutationIdBySession,
  pendingMutationIdBySessionRef,
}: UseWebSocketArgs): UseWebSocketResult {
  const [connectionState, setConnectionState] = useState<WsConnectionState>('disconnected');
  const [orchestratorStatus, setOrchestratorStatus] = useState<MobileOrchestratorStatus>('hidden');
  const [orchestratorNote, setOrchestratorNote] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const disposedRef = useRef(false);
  const sessionKeyRef = useRef(selectedSessionKey);
  const repoPathRef = useRef<string | null>(selectedRepoPath ?? null);
  const subscribedRepoPathRef = useRef<string | null>(null);
  // Replay cursor for the orchestrator channel — sent as `since` on
  // (re)subscribe; reset to 0 on a repo switch. (Distinct from the realtime
  // channel's per-stream seq tracked in realtimeSeqByStreamRef.)
  const lastOrchSeqRef = useRef(0);
  const realtimeSeqByStreamRef = useRef<Record<string, number>>({});

  // Stable refs for state setters so the connection effect never re-fires
  const setSnapshotRef = useRef(setSnapshot);
  const setRefreshErrorRef = useRef(setRefreshError);
  const setHistoryBySessionRef = useRef(setHistoryBySession);
  const setStreamingTextRef = useRef(setStreamingText);
  const setActionStateBySessionRef = useRef(setActionStateBySession);
  const setActionNoteBySessionRef = useRef(setActionNoteBySession);
  const setRealtimeMutationsByIdRef = useRef(setRealtimeMutationsById);
  const streamingTextRefRef = useRef(streamingTextRef);

  useEffect(() => { setSnapshotRef.current = setSnapshot; }, [setSnapshot]);
  useEffect(() => { setRefreshErrorRef.current = setRefreshError; }, [setRefreshError]);
  useEffect(() => { setHistoryBySessionRef.current = setHistoryBySession; }, [setHistoryBySession]);
  useEffect(() => { setStreamingTextRef.current = setStreamingText; }, [setStreamingText]);
  useEffect(() => { setActionStateBySessionRef.current = setActionStateBySession; }, [setActionStateBySession]);
  useEffect(() => { setActionNoteBySessionRef.current = setActionNoteBySession; }, [setActionNoteBySession]);
  useEffect(() => { setRealtimeMutationsByIdRef.current = setRealtimeMutationsById; }, [setRealtimeMutationsById]);
  useEffect(() => { streamingTextRefRef.current = streamingTextRef; }, [streamingTextRef]);

  // Keep session key ref current
  useEffect(() => {
    sessionKeyRef.current = selectedSessionKey;
  }, [selectedSessionKey]);
  useEffect(() => {
    repoPathRef.current = selectedRepoPath ?? null;
  }, [selectedRepoPath]);

  const applyInboxSnapshot = useCallback((inbox: MobileInboxSnapshot) => {
    setSnapshotRef.current((prev) => {
      if (sameMobileInboxSnapshot(prev, inbox)) return prev;
      return inbox;
    });
  }, []);

  const mergeHistoryEntries = useCallback((sessionKey: string, entries: MobileTranscriptEntry[], replace = false) => {
    if (!entries?.length && !replace) return;
    setHistoryBySessionRef.current((current) => {
      const prev = current[sessionKey] ?? [];
      if (replace) {
        const optimistic = prev.filter((entry) => entry.id.startsWith('optimistic-'));
        const serverIds = new Set(entries.map((entry) => entry.id));
        const serverTexts = new Set(entries.map((entry) => `${entry.role}:${entry.text}`));
        const pendingOptimistic = optimistic.filter((entry) => (
          !serverIds.has(entry.id)
          && !serverTexts.has(`${entry.role}:${entry.text}`)
        ));
        return {
          ...current,
          [sessionKey]: pendingOptimistic.length > 0 ? [...entries, ...pendingOptimistic] : entries,
        };
      }
      const existingIds = new Set(prev.map((entry) => entry.id));
      const existingTexts = new Set(prev.filter((entry) => entry.id.startsWith('stream:')).map((entry) => entry.text));
      const genuinelyNew = entries.filter((entry) => (
        !existingIds.has(entry.id)
        && !(entry.role === 'assistant' && existingTexts.has(entry.text))
      ));
      if (!genuinelyNew.length) return current;
      const cleaned = prev.filter((entry) => (
        !entry.id.startsWith('stream:')
        || !genuinelyNew.some((next) => next.role === 'assistant' && next.text === entry.text)
      ));
      return { ...current, [sessionKey]: [...cleaned, ...genuinelyNew] };
    });
  }, []);

  // Send session switch when selected session changes
  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      if (selectedSessionKey) {
        wsRef.current.send(JSON.stringify({ type: 'switch-session', sessionKey: selectedSessionKey }));
      }
      const subscriptions: RealtimeSubscription[] = [{ stream: 'global', since: realtimeSeqByStreamRef.current.global }];
      if (selectedSessionKey) {
        subscriptions.push({
          stream: `session:${selectedSessionKey}`,
          since: realtimeSeqByStreamRef.current[`session:${selectedSessionKey}`],
        });
      }
      wsRef.current.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions }));
    }
  }, [selectedSessionKey]);

  useEffect(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;

    const nextRepoPath = selectedRepoPath?.trim() || null;
    const currentRepoPath = subscribedRepoPathRef.current;

    if (currentRepoPath && currentRepoPath !== nextRepoPath) {
      wsRef.current.send(JSON.stringify({ type: 'orchestrator-unsubscribe' }));
      subscribedRepoPathRef.current = null;
      lastOrchSeqRef.current = 0; // repo switch → new session view
    }

    if (!nextRepoPath) {
      /* eslint-disable react-hooks/set-state-in-effect -- clearing the selected repo should immediately clear the visible orchestrator state to avoid stale cross-repo status. */
      setOrchestratorStatus('hidden');
      setOrchestratorNote(null);
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }

    if (currentRepoPath === nextRepoPath) {
      wsRef.current.send(JSON.stringify({ type: 'orchestrator-status', repoPath: nextRepoPath }));
      return;
    }

    setOrchestratorStatus('connecting');
    setOrchestratorNote('Linking mobile to the desktop orchestrator.');
    wsRef.current.send(JSON.stringify({ type: 'orchestrator-subscribe', repoPath: nextRepoPath, since: lastOrchSeqRef.current }));
    wsRef.current.send(JSON.stringify({ type: 'orchestrator-status', repoPath: nextRepoPath }));
    subscribedRepoPathRef.current = nextRepoPath;
  }, [selectedRepoPath]);

  const sendTerminalAttach = useCallback((sessionName: string, cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'terminal-attach', sessionName, cols, rows }));
    }
  }, []);

  const sendTerminalInput = useCallback((sessionName: string, data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'terminal-input', sessionName, data }));
    }
  }, []);

  const sendTerminalResize = useCallback((sessionName: string, cols: number, rows: number) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'terminal-resize', sessionName, cols, rows }));
    }
  }, []);

  const sendTerminalDetach = useCallback((sessionName: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'terminal-detach', sessionName }));
    }
  }, []);

  // Main connection effect — runs once on mount, never re-fires
  useEffect(() => {
    disposedRef.current = false;
    const url = getWsUrl();
    if (!url && !isWebMachineBrowserSurface()) return;

    function handleMessage(event: MessageEvent) {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : ''); } catch { return; }

      const channel = msg.channel as string;
      const eventType = msg.event as string;
      const data = msg.data as Record<string, unknown> | undefined;

      switch (channel) {
        case 'system':
          if (eventType === 'connected') {
            setConnectionState('connected');
            setRefreshErrorRef.current(null);
            backoffRef.current = INITIAL_BACKOFF;
            reconnectAttemptRef.current = 0;
          }
          break;

        case 'realtime':
          if (eventType === 'batch' && Array.isArray(data?.events)) {
            const events = data.events as RealtimeEventEnvelope[];
            for (const realtimeEvent of events) {
              realtimeSeqByStreamRef.current[realtimeEvent.stream] = Math.max(
                realtimeSeqByStreamRef.current[realtimeEvent.stream] ?? 0,
                realtimeEvent.seq,
              );
              switch (realtimeEvent.event) {
                case 'mobile.inbox.snapshot':
                  applyInboxSnapshot((realtimeEvent.data as MobileInboxRealtimeSnapshotPayload).inbox);
                  setRefreshErrorRef.current(null);
                  break;
                case 'history.snapshot':
                  {
                    const payload = realtimeEvent.data as SessionHistoryRealtimePayload;
                    mergeHistoryEntries(payload.sessionKey, payload.entries, Boolean(payload.replace));
                  }
                  break;
                case 'mutation.record':
                case 'mutation.settled': {
                  const mutation = (realtimeEvent.data as { mutation: RealtimeMutationRecord }).mutation;
                  setRealtimeMutationsByIdRef.current((current) => ({
                    ...current,
                    [mutation.mutationId]: mutation,
                  }));
                  if (mutation.sessionKey) {
                    const activeMutationId = pendingMutationIdBySessionRef.current[mutation.sessionKey];
                    const affectsCurrentSessionUi = !activeMutationId || activeMutationId === mutation.mutationId;
                    if (affectsCurrentSessionUi) {
                      setActionNoteBySessionRef.current((current) => ({
                        ...current,
                        [mutation.sessionKey!]: mutation.note ?? current[mutation.sessionKey!] ?? null,
                      }));
                      setActionStateBySessionRef.current((current) => ({
                        ...current,
                        [mutation.sessionKey!]:
                          mutation.status === 'pending'
                            ? (mutation.action === 'stop' ? 'stopping' : mutation.action === 'watch' || mutation.action === 'resolve' ? 'reviewing' : 'steering')
                            : 'idle',
                      }));
                    }
                    if (mutation.settledAt) {
                      if (pendingMutationIdBySessionRef.current[mutation.sessionKey] === mutation.mutationId) {
                        const nextPending = { ...pendingMutationIdBySessionRef.current };
                        delete nextPending[mutation.sessionKey];
                        pendingMutationIdBySessionRef.current = nextPending;
                      }
                      setPendingMutationIdBySession((current) => {
                        if (current[mutation.sessionKey!] !== mutation.mutationId) return current;
                        const next = { ...current };
                        delete next[mutation.sessionKey!];
                        return next;
                      });
                    }
                  }
                  break;
                }
                default:
                  break;
              }
            }
          }
          break;

        case 'inbox':
          if (eventType === 'update' && data) {
            const inbox = data as unknown as MobileInboxSnapshot;
            applyInboxSnapshot(inbox);
            setRefreshErrorRef.current(null);
          }
          break;

        case 'history':
          if (eventType === 'update' && data) {
            const { sessionKey, entries, replace } = data as { sessionKey: string; entries: MobileTranscriptEntry[]; replace?: boolean };
            mergeHistoryEntries(sessionKey, entries, Boolean(replace));
          }
          break;

        case 'chat':
          if (eventType === 'delta' && data?.text) {
            streamingTextRefRef.current.current = data.text as string;
            setStreamingTextRef.current(data.text as string);
          } else if (eventType === 'done') {
            const doneText = (data?.text as string) ?? '';
            streamingTextRefRef.current.current = '';
            setStreamingTextRef.current('');
            // Inject final message into history
            if (doneText && sessionKeyRef.current) {
              const sk = sessionKeyRef.current;
              setHistoryBySessionRef.current((current) => {
                const prev = current[sk] ?? [];
                if (prev.length > 0 && prev[prev.length - 1]?.text === doneText) return current;
                const entry: MobileTranscriptEntry = {
                  id: `stream:${(data?.runId as string) ?? Date.now()}`,
                  role: 'assistant',
                  text: doneText,
                  timestampLabel: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
                };
                return { ...current, [sk]: [...prev, entry] };
              });
            }
          } else if (eventType === 'error') {
            streamingTextRefRef.current.current = '';
            setStreamingTextRef.current('');
          }
          break;

        case 'pong':
          // Keepalive acknowledged
          break;

        case 'orchestrator':
          // Skip replayed events already applied. This surface is ambient
          // status only, but a reconnect replay shouldn't re-show stale notes.
          if (skipDuplicateBySeq(msg, lastOrchSeqRef)) break;
          if (eventType === 'status') {
            const nextStatus = data?.status;
            if (
              nextStatus === 'ready'
              || nextStatus === 'busy'
              || nextStatus === 'dead'
            ) {
              setOrchestratorStatus(nextStatus);
              setOrchestratorNote(
                nextStatus === 'busy'
                  ? 'Desktop orchestrator is routing work.'
                  : nextStatus === 'ready'
                    ? 'Desktop orchestrator is linked and idle.'
                    : 'Desktop orchestrator is unavailable for this repo.',
              );
            } else {
              setOrchestratorStatus('connecting');
            }
          } else if (eventType === 'tool-use') {
            const toolName = typeof data?.name === 'string' ? data.name : 'tool';
            setOrchestratorStatus('busy');
            setOrchestratorNote(`Orchestrator is using ${toolName}.`);
          } else if (eventType === 'output') {
            const text = typeof data?.text === 'string' ? data.text : '';
            const thinking = data?.thinking === true;
            if (text) {
              setOrchestratorStatus('busy');
              setOrchestratorNote(
                thinking
                  ? 'Desktop orchestrator is planning the next move.'
                  : formatStreamingPreview(text),
              );
            }
          } else if (eventType === 'error') {
            const error = typeof data?.error === 'string' ? data.error : 'Desktop orchestrator error.';
            setOrchestratorStatus('error');
            setOrchestratorNote(error);
          }
          break;

        case 'supervisor':
          // #529 — Agent lifecycle events are notifications, not orchestrator
          // transcript. Surface them as the ambient status note (not the full
          // codex sentence — ws-server strips transcript prose before fanout)
          // so the mobile operator knows a watched agent updated without
          // hearing a mid-stream monologue.
          if (eventType === 'agent-update') {
            const name = typeof data?.name === 'string' ? data.name : 'Agent';
            const statusText = typeof data?.status === 'string' ? data.status : 'updated';
            setOrchestratorStatus('busy');
            setOrchestratorNote(`${name} ${statusText}.`);
          }
          break;
      }
    }

    function connect() {
      if (disposedRef.current) return;
      setConnectionState((prev) => prev === 'disconnected' ? 'connecting' : 'reconnecting');

      const ws = openSurfaceWebSocket(url);
      if (!ws) {
        setConnectionState('disconnected');
        setRefreshErrorRef.current('The web-machine realtime transport is unavailable.');
        return;
      }

      ws.onopen = () => {
        if (disposedRef.current) { ws.close(); return; }
        wsRef.current = ws;
        backoffRef.current = INITIAL_BACKOFF;
        reconnectAttemptRef.current = 0;
        // Subscribe to current session
        if (sessionKeyRef.current) {
          ws.send(JSON.stringify({ type: 'subscribe', sessionKey: sessionKeyRef.current }));
        }
        if (repoPathRef.current) {
          setOrchestratorStatus('connecting');
          setOrchestratorNote('Linking mobile to the desktop orchestrator.');
          ws.send(JSON.stringify({ type: 'orchestrator-subscribe', repoPath: repoPathRef.current, since: lastOrchSeqRef.current }));
          ws.send(JSON.stringify({ type: 'orchestrator-status', repoPath: repoPathRef.current }));
          subscribedRepoPathRef.current = repoPathRef.current;
        } else {
          setOrchestratorStatus('hidden');
          setOrchestratorNote(null);
          subscribedRepoPathRef.current = null;
        }
        const subscriptions: RealtimeSubscription[] = [{ stream: 'global', since: realtimeSeqByStreamRef.current.global }];
        if (sessionKeyRef.current) {
          subscriptions.push({
            stream: `session:${sessionKeyRef.current}`,
            since: realtimeSeqByStreamRef.current[`session:${sessionKeyRef.current}`],
          });
        }
        ws.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions }));
        // Start keepalive
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
          if (repoPathRef.current) {
            setOrchestratorStatus('connecting');
            setOrchestratorNote('Reconnecting mobile to the desktop orchestrator.');
          } else {
            setOrchestratorStatus('hidden');
            setOrchestratorNote(null);
          }
          subscribedRepoPathRef.current = null;
          streamingTextRefRef.current.current = '';
          setStreamingTextRef.current('');
          const nextDelay = backoffRef.current;
          const nextAttempt = reconnectAttemptRef.current + 1;
          reconnectAttemptRef.current = nextAttempt;
          console.info(`[ws-mobile] reconnect attempt ${nextAttempt} in ${nextDelay}ms`);
          if (reconnectTimerRef.current) {
            clearTimeout(reconnectTimerRef.current);
          }
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, nextDelay);
          backoffRef.current = Math.min(nextDelay * 2, MAX_BACKOFF);
        }
      };

      ws.onerror = () => {
        // onclose will fire after this
      };
    }

    connect();

    return () => {
      disposedRef.current = true;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      if (pingTimerRef.current) { clearInterval(pingTimerRef.current); pingTimerRef.current = null; }
      if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
      setConnectionState('disconnected');
      setOrchestratorStatus('hidden');
      setOrchestratorNote(null);
      subscribedRepoPathRef.current = null;
    };
  }, [
    applyInboxSnapshot,
    mergeHistoryEntries,
    pendingMutationIdBySessionRef,
    setPendingMutationIdBySession,
  ]);

  return {
    connectionState,
    isConnected: connectionState === 'connected',
    orchestratorStatus,
    orchestratorNote,
    sendTerminalAttach,
    sendTerminalInput,
    sendTerminalResize,
    sendTerminalDetach,
  };
}
