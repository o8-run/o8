'use client';

/**
 * useCanvasOrchestrator — the canvas's line to the REAL orchestrator (#1232).
 *
 * Speaks the same ws-server orchestrator channel the OrchestratorTab does
 * (orchestrator-subscribe / -send / -interrupt; output / tool-use / status /
 * error events) through its own socket, scoped to one repo at a time. The
 * production useOrchestratorStream carries the full desktop transcript
 * model; the canvas only needs send → deltas → done, so this stays small.
 *
 * Thread ids are minted per repo (`thoughts-<ts>` — the ws-server persists
 * that prefix to chat history) and kept for the page's lifetime, so
 * switching repos and back resumes the same conversation.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getWsUrl } from '@/components/desktop/thoughts/use-orchestrator-stream/shared';
import { isOrchestratorBackendId, type OrchestratorBackendId } from '@/lib/lane/orchestrator-backends/types';
import { skipDuplicateBySeq } from '@/lib/orchestrator/replay-cursor';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';

export type CanvasOrchStatus = 'idle' | 'connecting' | 'ready' | 'busy' | 'dead' | 'unreported';

/** Thread ids survive reloads — same conversation, same repo, every visit. */
const THREADS_KEY = 'o8:canvas-threads';
/** Pre-rename key — read-only fallback so saved threads survive the rename. */
const LEGACY_THREADS_KEY = 'o8:canvas-threads';

function loadThreadMap(): Map<string, string> {
  if (typeof window === 'undefined') return new Map();
  try {
    const raw = window.localStorage.getItem(THREADS_KEY) ?? window.localStorage.getItem(LEGACY_THREADS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      return new Map(Object.entries(parsed as Record<string, string>).filter(([, value]) => typeof value === 'string'));
    }
  } catch {
    // corrupt entry — start fresh
  }
  return new Map();
}

function saveThreadMap(map: Map<string, string>) {
  try {
    window.localStorage.setItem(THREADS_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // non-critical
  }
}

/** Narrow an event's `args`/payload (it arrives as `unknown` off the wire). */
const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined);

export interface CanvasOrchCallbacks {
  onOutput?: (repoPath: string, text: string, thinking: boolean) => void;
  onToolUse?: (repoPath: string, name: string, args?: Record<string, unknown>) => void;
  /** A tool finished — carries its output (the PR-card wire reads `gh pr` URLs). */
  onToolResult?: (repoPath: string, name: string, args: Record<string, unknown> | undefined, output: string | undefined) => void;
  onStatus?: (repoPath: string, status: CanvasOrchStatus, reason?: string) => void;
  onNotice?: (repoPath: string, message: string) => void;
  onError?: (repoPath: string, error: string) => void;
  /** A lane changed state somewhere (agent spawned, review-ready, merged…)
   *  — the ws-server broadcasts these to every client. The canvas uses it
   *  to keep the Agents badge + Review drawer live instead of 90s stale. */
  onLaneLifecycle?: () => void;
}

/** One streamed orchestrator event, surface-agnostic — chat cards forward
 *  these up to the page's shared entry pipeline. */
export type CanvasThreadEvent =
  | { type: 'output'; text: string; thinking: boolean }
  | { type: 'tool'; name: string; args?: Record<string, unknown> }
  | { type: 'tool-result'; name: string; args?: Record<string, unknown>; output?: string }
  | { type: 'status'; status: CanvasOrchStatus; reason?: string }
  | { type: 'notice'; message: string }
  | { type: 'error'; error: string };

export function useCanvasOrchestrator(repoPath: string | null, callbacks: CanvasOrchCallbacks) {
  const wsRef = useRef<WebSocket | null>(null);
  // Replay cursor — highest event seq applied for the current session view.
  const lastSeqRef = useRef(0);
  const cbRef = useRef(callbacks);
  useLayoutEffect(() => {
    cbRef.current = callbacks;
  }, [callbacks]);
  const [threadIds] = useState(loadThreadMap);
  const backendByThreadRef = useRef(new Map<string, OrchestratorBackendId>());
  const [statusState, setStatusState] = useState<{
    repoPath: string | null;
    value: CanvasOrchStatus;
  }>(() => ({ repoPath, value: repoPath ? 'connecting' : 'idle' }));
  const status = statusState.repoPath === repoPath
    ? statusState.value
    : repoPath ? 'connecting' : 'idle';
  const setStatus = useCallback((value: CanvasOrchStatus) => {
    setStatusState({ repoPath, value });
  }, [repoPath]);

  useEffect(() => {
    if (!repoPath) return;
    // New repo = new session view → reset the replay cursor.
    lastSeqRef.current = 0;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (disposed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(getWsUrl());
      } catch {
        retryTimer = setTimeout(connect, 2000);
        return;
      }
      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }
        wsRef.current = ws;
        const threadId = threadIds.get(repoPath) ?? null;
        const backend = threadId ? backendByThreadRef.current.get(threadId) : undefined;
        ws.send(JSON.stringify({
          type: 'orchestrator-subscribe',
          repoPath,
          threadId,
          ...(backend ? { backend } : {}),
          // Replay anything missed since our cursor — recovers in-flight tokens
          // on a reconnect instead of stalling with no stream.
          since: lastSeqRef.current,
        }));
      };
      ws.onmessage = (event) => {
        let msg: { channel?: string; event?: string; data?: Record<string, unknown>; seq?: number };
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        } catch {
          return;
        }
        if (msg.channel === 'lane-lifecycle') {
          cbRef.current.onLaneLifecycle?.();
          return;
        }
        if (msg.channel !== 'orchestrator' || !msg.data) return;
        const data = msg.data;
        const eventThreadId = typeof data.threadId === 'string'
          ? data.threadId
          : threadIds.get(repoPath);
        if (eventThreadId && isOrchestratorBackendId(data.backend)) {
          const previous = backendByThreadRef.current.get(eventThreadId);
          if (previous && previous !== data.backend) lastSeqRef.current = 0;
          backendByThreadRef.current.set(eventThreadId, data.backend);
        }
        // Skip replayed events we've already applied (no double tokens).
        if (skipDuplicateBySeq(msg, lastSeqRef)) return;
        if (msg.event === 'output' && typeof data.text === 'string') {
          cbRef.current.onOutput?.(repoPath, data.text, data.thinking === true);
        } else if (msg.event === 'tool-use' && typeof data.name === 'string') {
          cbRef.current.onToolUse?.(repoPath, data.name, asRecord(data.args));
        } else if (msg.event === 'tool-result' && typeof data.name === 'string') {
          cbRef.current.onToolResult?.(repoPath, data.name, asRecord(data.args), typeof data.output === 'string' ? data.output : undefined);
        } else if (msg.event === 'status' && typeof data.status === 'string') {
          const next = data.status === 'unreported' ? 'unreported' : data.status === 'busy' ? 'busy' : data.status === 'dead' ? 'dead' : 'ready';
          setStatus(next);
          cbRef.current.onStatus?.(repoPath, next, next === 'unreported'
            ? (typeof data.reason === 'string' ? data.reason : 'turn ended without an outcome report') : undefined);
        } else if (msg.event === 'notice' && typeof data.message === 'string') {
          cbRef.current.onNotice?.(repoPath, data.message);
        } else if (msg.event === 'error' && typeof data.error === 'string') {
          cbRef.current.onError?.(repoPath, data.error);
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (!disposed) {
          setStatus('connecting');
          retryTimer = setTimeout(connect, 2000);
        }
      };
      ws.onerror = () => { /* onclose retries */ };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [repoPath, setStatus, threadIds]);

  /** Send one user turn. Returns the threadId, or null if the socket
   *  isn't ready (caller surfaces "not connected"). */
  const send = useCallback((message: string, opts?: { model?: string; thinkingEffort?: string; orchestrationMode?: OrchestratorExecutionMode; attachments?: Array<{ dataUri: string; name?: string }> }) => {
    if (!repoPath) return null;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    let threadId = threadIds.get(repoPath);
    const orchestrationMode = opts?.orchestrationMode ?? 'fleet';
    if (!threadId) {
      threadId = `thoughts-${Date.now()}`;
      threadIds.set(repoPath, threadId);
      saveThreadMap(threadIds);
      // First turn on this repo: the connect-time subscribe used the null-thread
      // route, but the turn runs under the thread route. Re-subscribe onto it
      // BEFORE sending so the dock actually receives this turn's stream
      // (otherwise it streamed nothing until a reload re-loaded the threadId).
      lastSeqRef.current = 0;
      ws.send(JSON.stringify({
        type: 'orchestrator-subscribe', repoPath, threadId, since: 0,
      }));
    }
    backendByThreadRef.current.delete(threadId);
    ws.send(JSON.stringify({
      type: 'orchestrator-send',
      surface: 'canvas-agent',
      repoPath,
      threadId,
      message,
      permissionMode: 'full',
      orchestrationMode,
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.thinkingEffort && opts.thinkingEffort !== 'adaptive' ? { thinkingEffort: opts.thinkingEffort } : {}),
      ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
    }));
    return threadId;
  }, [repoPath, threadIds]);

  const interrupt = useCallback(() => {
    if (!repoPath) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const threadId = threadIds.get(repoPath) ?? null;
    const backend = threadId ? backendByThreadRef.current.get(threadId) : undefined;
    ws.send(JSON.stringify({
      type: 'orchestrator-interrupt',
      repoPath,
      threadId,
      ...(backend ? { backend } : {}),
    }));
  }, [repoPath, threadIds]);

  /** Resume a PAST thread on a repo — history picks route through here.
   *  Re-subscribes the live socket when the repo is the active one. */
  const adoptThread = useCallback((repo: string, threadId: string) => {
    threadIds.set(repo, threadId);
    saveThreadMap(threadIds);
    const ws = wsRef.current;
    if (repo === repoPath && ws && ws.readyState === WebSocket.OPEN) {
      // Switching threads = new session view → reset the cursor and pull the
      // adopted thread's in-flight turn from the start.
      lastSeqRef.current = 0;
      ws.send(JSON.stringify({ type: 'orchestrator-subscribe', repoPath: repo, threadId, since: 0 }));
    }
  }, [repoPath, threadIds]);

  /** The persisted thread for a repo, if any — the dock uses this to
   *  re-seed its transcript from history after a reload. */
  const threadIdFor = useCallback((repo: string) => threadIds.get(repo) ?? null, [threadIds]);

  return { status, send, interrupt, adoptThread, threadIdFor };
}

/** A live line to ONE specific thread — chat cards talk through this, so a
 *  past session is conversable right where it floats (no dock required).
 *  Each card holds its own socket; the ws-server routes orchestrator events
 *  per (connection, thread), so card lines never fight the dock's line. */
export function useThreadOrchestrator(
  repoPath: string | null,
  threadId: string,
  onEvent: (event: CanvasThreadEvent) => void,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef(0);
  const activeBackendRef = useRef<OrchestratorBackendId | null>(null);
  const onEventRef = useRef(onEvent);
  useLayoutEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);
  const connectionKey = repoPath && threadId ? `${repoPath}\u0000${threadId}` : null;
  const [statusState, setStatusState] = useState<{
    connectionKey: string | null;
    value: CanvasOrchStatus;
  }>(() => ({ connectionKey, value: connectionKey ? 'connecting' : 'idle' }));
  const status = statusState.connectionKey === connectionKey
    ? statusState.value
    : connectionKey ? 'connecting' : 'idle';
  const setStatus = useCallback((value: CanvasOrchStatus) => {
    setStatusState({ connectionKey, value });
  }, [connectionKey]);

  useEffect(() => {
    if (!repoPath || !threadId) return;
    // New thread = new session view → reset the replay cursor.
    lastSeqRef.current = 0;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (disposed) return;
      let ws: WebSocket;
      try {
        ws = new WebSocket(getWsUrl());
      } catch {
        retryTimer = setTimeout(connect, 2000);
        return;
      }
      ws.onopen = () => {
        if (disposed) {
          ws.close();
          return;
        }
        wsRef.current = ws;
        ws.send(JSON.stringify({
          type: 'orchestrator-subscribe', repoPath, threadId, since: lastSeqRef.current,
          ...(activeBackendRef.current ? { backend: activeBackendRef.current } : {}),
        }));
      };
      ws.onmessage = (event) => {
        let msg: { channel?: string; event?: string; data?: Record<string, unknown>; seq?: number };
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
        } catch {
          return;
        }
        if (msg.channel !== 'orchestrator' || !msg.data) return;
        const data = msg.data;
        if (isOrchestratorBackendId(data.backend)) {
          if (activeBackendRef.current && activeBackendRef.current !== data.backend) lastSeqRef.current = 0;
          activeBackendRef.current = data.backend;
        }
        // Skip replayed events we've already applied (no double tokens).
        if (skipDuplicateBySeq(msg, lastSeqRef)) return;
        if (msg.event === 'output' && typeof data.text === 'string') {
          onEventRef.current({ type: 'output', text: data.text, thinking: data.thinking === true });
        } else if (msg.event === 'tool-use' && typeof data.name === 'string') {
          onEventRef.current({ type: 'tool', name: data.name, args: asRecord(data.args) });
        } else if (msg.event === 'tool-result' && typeof data.name === 'string') {
          onEventRef.current({ type: 'tool-result', name: data.name, args: asRecord(data.args), output: typeof data.output === 'string' ? data.output : undefined });
        } else if (msg.event === 'status' && typeof data.status === 'string') {
          const next: CanvasOrchStatus = data.status === 'unreported' ? 'unreported' : data.status === 'busy' ? 'busy' : data.status === 'dead' ? 'dead' : 'ready';
          setStatus(next);
          onEventRef.current({ type: 'status', status: next, ...(next === 'unreported'
            ? { reason: typeof data.reason === 'string' ? data.reason : 'turn ended without an outcome report' } : {}) });
        } else if (msg.event === 'notice' && typeof data.message === 'string') {
          onEventRef.current({ type: 'notice', message: data.message });
        } else if (msg.event === 'error' && typeof data.error === 'string') {
          onEventRef.current({ type: 'error', error: data.error });
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (!disposed) {
          setStatus('connecting');
          retryTimer = setTimeout(connect, 2000);
        }
      };
      ws.onerror = () => { /* onclose retries */ };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [repoPath, setStatus, threadId]);

  const send = useCallback((message: string, opts?: { model?: string; thinkingEffort?: string }) => {
    if (!repoPath || !threadId) return false;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    activeBackendRef.current = null;
    ws.send(JSON.stringify({
      type: 'orchestrator-send',
      surface: 'canvas-agent',
      repoPath,
      threadId,
      message,
      permissionMode: 'full',
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.thinkingEffort && opts.thinkingEffort !== 'adaptive' ? { thinkingEffort: opts.thinkingEffort } : {}),
    }));
    return true;
  }, [repoPath, threadId]);

  /** Halt this card's running turn — same interrupt the dock line has, scoped
   *  to this thread (powers the chat card's stop / undo-send). */
  const interrupt = useCallback(() => {
    if (!repoPath || !threadId) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'orchestrator-interrupt', repoPath, threadId }));
  }, [repoPath, threadId]);

  return { status, send, interrupt };
}
