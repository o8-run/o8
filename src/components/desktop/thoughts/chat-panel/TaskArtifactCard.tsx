'use client';

/**
 * Host for one interactive task artifact (#1699) inside the orchestrator
 * transcript. Renders the agent's HTML in an opaque-origin sandbox, owns the
 * capability token, validates every frame message, and is the only party that
 * talks to the return-channel route. The frame never sees o8.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { mintBridgeToken, validateFrameMessage, type HostToFrameMessage } from '@/lib/task-artifacts/bridge-protocol';
import { buildTaskArtifactSrcdoc, type TaskArtifactSrcdocTheme } from '@/lib/task-artifacts/srcdoc';
import type { TaskArtifactActionRecord, TaskArtifactView } from '@/lib/task-artifacts/types';
import { MissionCard } from './MissionCard';

const UI_FONT = 'var(--font-sans-system)';
const MONO_FONT = 'var(--font-mono-system, ui-monospace, "SF Mono", Menlo, monospace)';
const MIN_FRAME_HEIGHT = 96;
const MAX_FRAME_HEIGHT = 1200;
const WRITABILITY_POLL_MS = 15_000;

export interface TaskArtifactDeliverInput {
  artifactId: string;
  actionId: string;
  wireMessage: string;
  displayMessage: string;
}

interface TaskArtifactCardProps {
  artifactId: string;
  /** True while the owning thread is mid-turn; submissions wait rather than queue. */
  threadBusy: boolean;
  /**
   * Deliver an accepted thread-target action through the panel's own send
   * path. Returns false when the thread could not take the turn right now; the
   * card keeps the receipt and offers a retry with the same action id.
   */
  onDeliverToThread: (input: TaskArtifactDeliverInput) => boolean;
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; action: TaskArtifactActionRecord; note: string }
  | { kind: 'undelivered'; deliver: TaskArtifactDeliverInput; reason: string }
  | { kind: 'rejected'; reason: string };

function draftKey(artifactId: string): string {
  return `o8:task-artifact:draft:${artifactId}`;
}

function readDraft(artifactId: string): unknown {
  try {
    const raw = window.localStorage.getItem(draftKey(artifactId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeDraft(artifactId: string, draft: unknown): void {
  try {
    if (draft === null || draft === undefined) window.localStorage.removeItem(draftKey(artifactId));
    else window.localStorage.setItem(draftKey(artifactId), JSON.stringify(draft));
  } catch {
    // Storage can be unavailable; the draft is a convenience, not a record.
  }
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function readTheme(): TaskArtifactSrcdocTheme {
  return {
    background: cssVar('--t-chat-surface-card-bg', cssVar('--t-bg-card', '#ffffff')),
    text: cssVar('--t-chat-surface-text', cssVar('--t-text', '#1b1e23')),
    textMuted: cssVar('--t-chat-surface-text-muted', cssVar('--t-text-muted', '#6b727c')),
    border: cssVar('--t-chat-surface-border', cssVar('--t-border', 'rgba(127,127,127,0.24)')),
    accent: cssVar('--t-accent', '#e8a33d'),
    fontFamily: cssVar('--font-sans-system', '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif'),
  };
}

function ShieldIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z" />
    </svg>
  );
}

function ReturnIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 14l-4-4 4-4" />
      <path d="M5 10h9a5 5 0 0 1 0 10h-3" />
    </svg>
  );
}

export function TaskArtifactCard({ artifactId, threadBusy, onDeliverToThread }: TaskArtifactCardProps) {
  const [view, setView] = useState<TaskArtifactView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [frameHeight, setFrameHeight] = useState(MIN_FRAME_HEIGHT);
  const [frameReady, setFrameReady] = useState(false);
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const tokenRef = useRef<string>(mintBridgeToken());
  const viewRef = useRef<TaskArtifactView | null>(null);
  const inflightRef = useRef(false);
  const theme = useMemo(readTheme, []);

  useEffect(() => { viewRef.current = view; }, [view]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/task-artifacts/${encodeURIComponent(artifactId)}`, { cache: 'no-store' });
      const body = await response.json().catch(() => null) as { ok?: boolean; result?: TaskArtifactView; error?: { message?: string } } | null;
      if (!response.ok || !body?.ok || !body.result) {
        setLoadError(body?.error?.message ?? `Could not load artifact (${response.status}).`);
        return;
      }
      setLoadError(null);
      setView((previous) => {
        // Keep the HTML from the first load so the frame never re-mounts on a
        // writability poll; only the state around it refreshes.
        if (previous?.artifact.html && !body.result!.artifact.html) {
          return { ...body.result!, artifact: { ...body.result!.artifact, html: previous.artifact.html } };
        }
        return body.result!;
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [artifactId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, WRITABILITY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const postToFrame = useCallback((message: HostToFrameMessage) => {
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    // The frame is an opaque origin, so '*' is the only valid target origin.
    // The message never carries anything the frame did not already hold,
    // except the token, which the frame needs to speak at all.
    target.postMessage(message, '*');
  }, []);

  const srcdoc = useMemo(() => (view?.artifact.html ? buildTaskArtifactSrcdoc(view.artifact.html, theme) : null), [view?.artifact.html, theme]);

  const declaredActions = useMemo(() => (view?.artifact.actions ?? []).map((a) => a.name), [view?.artifact.actions]);
  const primaryAction = view?.artifact.actions[0] ?? null;
  const writable = view?.writability.writable ?? false;
  const readOnlyReason = view?.writability.reason ?? null;

  // Tell the frame when writability flips so it can disable its own controls.
  useEffect(() => {
    if (!frameReady || !view) return;
    postToFrame({ type: 'o8:state', writable, reason: readOnlyReason });
  }, [frameReady, view, writable, readOnlyReason, postToFrame]);

  const submitAction = useCallback(async (action: string, payload: unknown, requestId: string | null) => {
    const current = viewRef.current;
    if (!current || inflightRef.current) return;
    const reply = (ok: boolean, error: string | null, actionRecord: TaskArtifactActionRecord | null) => {
      if (requestId) postToFrame({ type: 'o8:result', requestId, ok, error, actionId: actionRecord?.id ?? null, delivery: actionRecord?.delivery ?? null });
    };
    if (!current.writability.writable) {
      reply(false, current.writability.reason ?? 'artifact is read-only', null);
      setSubmit({ kind: 'rejected', reason: current.writability.reason ?? 'artifact is read-only' });
      return;
    }
    if (current.artifact.target.kind === 'thread' && threadBusy) {
      reply(false, 'The thread is busy. Send when it finishes.', null);
      setSubmit({ kind: 'rejected', reason: 'The thread is busy. Send when the current turn finishes.' });
      return;
    }
    inflightRef.current = true;
    setSubmit({ kind: 'sending' });
    try {
      const nonce = mintBridgeToken().slice(0, 32);
      const response = await fetch(`/api/task-artifacts/${encodeURIComponent(current.artifact.id)}/actions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, payload, nonce, target: current.artifact.target }),
      });
      const body = await response.json().catch(() => null) as {
        ok?: boolean;
        error?: { code?: string; message?: string };
        result?: { accepted: boolean; action: TaskArtifactActionRecord | null; deliverVia?: 'packet' | 'thread'; wireMessage?: string; displayMessage?: string; reason?: string };
      } | null;
      const result = body?.result;
      if (!result) {
        const reason = body?.error?.message ?? `Submission failed (${response.status}).`;
        reply(false, reason, null);
        setSubmit({ kind: 'rejected', reason });
        return;
      }
      if (!result.accepted || !result.action) {
        const reason = result.reason ?? body?.error?.message ?? 'rejected';
        reply(false, reason, result.action);
        setSubmit({ kind: 'rejected', reason });
        return;
      }
      if (result.deliverVia === 'thread' && result.wireMessage && result.displayMessage) {
        const deliver: TaskArtifactDeliverInput = {
          artifactId: current.artifact.id,
          actionId: result.action.id,
          wireMessage: result.wireMessage,
          displayMessage: result.displayMessage,
        };
        const sent = onDeliverToThread(deliver);
        if (!sent) {
          reply(false, 'Accepted, but the thread could not take the turn. Retry from the card.', result.action);
          setSubmit({ kind: 'undelivered', deliver, reason: 'The thread could not take the turn. The receipt is kept; retry when it is idle.' });
          return;
        }
        writeDraft(current.artifact.id, null);
        reply(true, null, result.action);
        setSubmit({ kind: 'sent', action: result.action, note: 'Returned to the thread.' });
      } else {
        writeDraft(current.artifact.id, null);
        const delivered = result.action.delivery === 'delivered';
        reply(delivered, delivered ? null : (result.action.deliveryNote ?? 'delivery failed'), result.action);
        setSubmit(delivered
          ? { kind: 'sent', action: result.action, note: 'Delivered to the packet session.' }
          : { kind: 'rejected', reason: result.action.deliveryNote ?? 'Delivery to the packet failed.' });
      }
      void load();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      reply(false, reason, null);
      setSubmit({ kind: 'rejected', reason });
    } finally {
      inflightRef.current = false;
    }
  }, [load, onDeliverToThread, postToFrame, threadBusy]);

  // The single gate for everything the frame says.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow ?? null;
      const verdict = validateFrameMessage({
        data: event.data,
        sourceIsFrame: Boolean(frameWindow) && event.source === frameWindow,
        token: frameReady ? tokenRef.current : null,
        declaredActions,
      });
      if (!verdict.ok) {
        // Messages from other frames on the page are routine; only log when it
        // was our frame misbehaving.
        if (frameWindow && event.source === frameWindow && event.data?.type !== 'o8:ready') {
          console.warn(`[task-artifacts] frame message refused: ${verdict.reason}`);
        }
        if (frameWindow && event.source === frameWindow && event.data?.type === 'o8:ready' && !frameReady) {
          // A ready with the wrong bridge version: leave the frame uninitialized.
          console.warn(`[task-artifacts] frame refused: ${verdict.reason}`);
        }
        return;
      }
      const message = verdict.message;
      const current = viewRef.current;
      switch (message.type) {
        case 'o8:ready': {
          if (!current) return;
          setFrameReady(true);
          postToFrame({
            type: 'o8:init',
            token: tokenRef.current,
            artifactId: current.artifact.id,
            title: current.artifact.title,
            actions: current.artifact.actions.map((a) => ({ name: a.name, label: a.label ?? a.name })),
            draft: readDraft(current.artifact.id),
            writable: current.writability.writable,
            reason: current.writability.reason,
          });
          return;
        }
        case 'o8:height':
          setFrameHeight(Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, message.height)));
          return;
        case 'o8:draft':
          if (current) writeDraft(current.artifact.id, message.draft);
          return;
        case 'o8:submit':
          void submitAction(message.action, message.payload, message.requestId);
          return;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [declaredActions, frameReady, postToFrame, submitAction]);

  const requestCollect = useCallback(() => {
    if (!primaryAction || !frameReady) return;
    postToFrame({ type: 'o8:collect', token: tokenRef.current, action: primaryAction.name });
  }, [frameReady, postToFrame, primaryAction]);

  const retryDelivery = useCallback(() => {
    if (submit.kind !== 'undelivered') return;
    if (threadBusy) return;
    const sent = onDeliverToThread(submit.deliver);
    if (sent) setSubmit({ kind: 'sent', action: { id: submit.deliver.actionId } as TaskArtifactActionRecord, note: 'Returned to the thread.' });
  }, [onDeliverToThread, submit, threadBusy]);

  const targetLabel = view
    ? view.artifact.target.kind === 'thread'
      ? `returns to thread ${view.artifact.target.threadId?.replace(/^thoughts-/, '') ?? ''}`
      : `returns to packet ${view.artifact.target.packetId?.slice(0, 12) ?? ''}`
    : '';
  const sendDisabled = !view || !writable || !frameReady || submit.kind === 'sending' || (view.artifact.target.kind === 'thread' && threadBusy);

  const chip = (label: string, tone: 'accent' | 'muted' | 'warning'): React.ReactNode => (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, paddingLeft: 8, paddingRight: 8, borderRadius: 6,
        fontFamily: UI_FONT, fontSize: 11.5, fontWeight: 300, letterSpacing: -0.1, whiteSpace: 'nowrap',
        border: `1px solid ${tone === 'accent' ? 'var(--t-accent-border)' : tone === 'warning' ? 'var(--t-warning-border)' : 'var(--t-border)'}`,
        background: tone === 'accent' ? 'var(--t-accent-soft)' : tone === 'warning' ? 'var(--t-warning-soft)' : 'transparent',
        color: tone === 'accent' ? 'var(--t-text)' : tone === 'warning' ? 'var(--t-warning-contrast)' : 'var(--t-text-muted)',
      }}
    >
      {tone === 'accent' ? <ReturnIcon /> : tone === 'muted' ? <ShieldIcon /> : null}
      {label}
    </span>
  );

  // #5468 — a mission card has no HTML; it draws natively and decides once.
  if (view?.card) {
    return (
      <MissionCard card={view.card} target={view.artifact.target} threadBusy={threadBusy}
        onDeliverToThread={onDeliverToThread} onDecided={() => void load()} />
    );
  }

  let statusLine: React.ReactNode;
  if (loadError) statusLine = <span style={{ color: 'var(--t-danger)' }}>{loadError}</span>;
  else if (!view) statusLine = 'Loading artifact…';
  else if (!writable) statusLine = <span style={{ color: 'var(--t-warning-contrast)' }}>{readOnlyReason}</span>;
  else if (submit.kind === 'sending') statusLine = 'Sending…';
  else if (submit.kind === 'sent') statusLine = <span><b style={{ fontWeight: 400, color: 'var(--t-text)' }}>Sent.</b> {submit.note} Receipt {submit.action.id.slice(0, 13)}.</span>;
  else if (submit.kind === 'undelivered') statusLine = <span style={{ color: 'var(--t-warning-contrast)' }}>{submit.reason}</span>;
  else if (submit.kind === 'rejected') statusLine = <span style={{ color: 'var(--t-danger)' }}>Not sent: {submit.reason}</span>;
  else if (view.artifact.target.kind === 'thread' && threadBusy) statusLine = 'The thread is busy. Send when the current turn finishes.';
  else if (!frameReady) statusLine = 'Waiting for the artifact to initialize…';
  else statusLine = `Only what the artifact declares is sent. ${view.acceptedActionCount > 0 ? `${view.acceptedActionCount} accepted so far.` : ''}`;

  return (
    <div
      data-task-artifact-id={artifactId}
      style={{
        marginTop: 8, marginBottom: 8, maxWidth: '92%', alignSelf: 'flex-start',
        border: '1px solid var(--t-chat-surface-border)', borderRadius: 14, overflow: 'hidden',
        background: 'var(--t-chat-surface-card-bg)',
        boxShadow: writable && submit.kind !== 'sent' ? '0 0 0 1px var(--t-accent-soft)' : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 12, borderBottom: '1px solid var(--t-chat-surface-border)' }}>
        <span style={{ fontFamily: UI_FONT, fontSize: 13, fontWeight: 400, color: 'var(--t-text)', letterSpacing: -0.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {view?.artifact.title ?? 'Task artifact'}
        </span>
        <span style={{ fontFamily: MONO_FONT, fontSize: 10.5, color: 'var(--t-text-faint)', whiteSpace: 'nowrap' }}>
          {artifactId.slice(0, 13)}{view?.artifact.originHead ? ` · ${view.artifact.originHead.slice(0, 7)}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {chip('sandboxed', 'muted')}
        {view ? chip(targetLabel, writable ? 'accent' : 'warning') : null}
      </div>

      {srcdoc ? (
        <iframe
          ref={iframeRef}
          title={view?.artifact.title ?? 'Task artifact'}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          srcDoc={srcdoc}
          style={{ display: 'block', width: '100%', height: frameHeight, border: 'none', background: 'transparent' }}
        />
      ) : (
        <div style={{ height: MIN_FRAME_HEIGHT }} />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 8, paddingBottom: 8, paddingLeft: 12, paddingRight: 10, borderTop: '1px solid var(--t-chat-surface-border)', background: !writable && view ? 'var(--t-warning-soft)' : 'transparent' }}>
        <span style={{ flex: 1, fontFamily: UI_FONT, fontSize: 12, fontWeight: 300, color: 'var(--t-text-muted)', letterSpacing: -0.1, minWidth: 0 }}>
          {statusLine}
        </span>
        {submit.kind === 'undelivered' ? (
          <button
            type="button"
            onClick={retryDelivery}
            disabled={threadBusy}
            style={{
              height: 28, paddingLeft: 12, paddingRight: 12, borderRadius: 8, cursor: threadBusy ? 'default' : 'pointer',
              fontFamily: UI_FONT, fontSize: 12.5, fontWeight: 400, color: 'var(--t-text)',
              border: '1px solid var(--t-accent-border)', background: 'var(--t-accent-soft)', opacity: threadBusy ? 0.5 : 1,
            }}
          >
            Retry delivery
          </button>
        ) : (
          <button
            type="button"
            onClick={requestCollect}
            disabled={sendDisabled}
            aria-label={primaryAction ? `Send ${primaryAction.label ?? primaryAction.name}` : 'Send'}
            style={{
              height: 28, paddingLeft: 12, paddingRight: 12, borderRadius: 8, cursor: sendDisabled ? 'default' : 'pointer',
              fontFamily: UI_FONT, fontSize: 12.5, fontWeight: 400, color: 'var(--t-text)',
              border: '1px solid var(--t-accent-border)', background: 'var(--t-accent-soft)', opacity: sendDisabled ? 0.45 : 1,
            }}
          >
            {primaryAction ? `Send ${primaryAction.label ?? primaryAction.name}` : 'Send'}
          </button>
        )}
      </div>
    </div>
  );
}
