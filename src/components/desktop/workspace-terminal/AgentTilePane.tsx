'use client';
import { SessionCacheIndicator } from '../SessionCacheIndicator';

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type UIEvent as ReactUIEvent,
} from 'react';
import { shortWorkerTitle, workerAttention } from './worker-pane-chrome';
import { useWorkerPaneSize } from './useWorkerPaneSize';
import { WorkerPaneHeader, WORKER_ICON_BUTTON } from './WorkerPaneHeader';
import { WorkerPaneComposer } from './WorkerPaneComposer';
import { useComposerDraftValue } from '../thoughts/chat-panel/composer-draft-store';
import type { FleetAgent } from '@/components/desktop/thoughts/types';
import {
  TerminalStatusEvidenceDisclosure,
  terminalStatusCaption,
} from '@/components/desktop/TerminalStatusEvidenceRows';
import { mergeAdjacentToolOnlyEntries } from '@/components/desktop/thoughts/chat-panel/ToolCallChipCluster';
import { usePacketTranscriptPoll } from '@/components/desktop/workspace-terminal/use-packet-transcript-poll';
import { WorkspaceTranscript } from '@/components/desktop/workspace-terminal/WorkspaceTranscript';
import { useAgentPeerMessages } from '@/components/desktop/workspace-terminal/useAgentPeerMessages';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { agentDisplayLabel, resolveDisplayRuntime } from '@/lib/orchestrator/display';
import {
  ORCHESTRATOR_RUNTIME_IDS,
  getRuntimeCapability,
  isOrchestratorRuntime,
  type OrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import {
  correlatedActionIsUnsettled,
  fetchCorrelatedActionReceipt,
} from '@/lib/orchestrator/action-receipt';
import { bootstrapTranscripts } from '@/lib/transcripts/bootstrap';
import { transcriptStore } from '@/lib/transcripts/store';
import { useTranscript } from '@/lib/transcripts/useTranscript';
import { SessionTransformMenu } from './SessionTransformMenu';
import { WorkerPaneSummary } from './WorkerPaneSummary';
import { hasWorkerReviewAction, WorkerReviewAction } from './WorkerReviewAction';
import type { TerminalStatusState } from '@/lib/terminal-status/resolve';

interface AgentTilePaneProps {
  sessionKey: string;
  agent: FleetAgent | null;
  packet?: OrchestratorPacket | null;
  focused: boolean;
  onClose: (sessionKey: string) => void;
  onFocus: (sessionKey: string) => void;
  onOpenReview?: () => void;
}

type VisualStatus = 'running' | 'waiting' | 'review' | 'idle' | 'error';

const STATUS_META: Record<VisualStatus, { color: string; label: string }> = {
  running: { color: '#22c55e', label: 'Running' },
  waiting: { color: '#f59e0b', label: 'Waiting' },
  review: { color: '#FF5A1F', label: 'Review' },
  idle: { color: '#94a3b8', label: 'Idle' },
  error: { color: '#ef4444', label: 'Error' },
};

export function classifyAgentTileStatus(rawStatus: string | undefined): VisualStatus {
  const value = (rawStatus ?? '').toLowerCase();
  if (value.includes('error') || value.includes('fail')) return 'error';
  if (value.includes('review') || value.includes('finished') || value.includes('complete')) return 'review';
  if (value.includes('wait') || value.includes('approval') || value.includes('pending') || value.includes('blocked')) return 'waiting';
  if (value.includes('running') || value.includes('active') || value.includes('working')) return 'running';
  return 'idle';
}

const FAILED_BLOCK_REASONS = new Set([
  'dispatch_failed',
  'interrupt_failed',
  'kill_unconfirmed',
  'runtime_process_exit',
]);

export function resolveAgentTileStatus(
  agentStatus: string | undefined,
  packetStatus: string | undefined,
  blockedReason: string | null | undefined,
): VisualStatus {
  const normalizedReason = blockedReason?.trim().toLowerCase() ?? '';
  if (FAILED_BLOCK_REASONS.has(normalizedReason)) return 'error';
  if (packetStatus) return classifyAgentTileStatus(packetStatus);
  const states = [agentStatus].map((value) => classifyAgentTileStatus(value));
  if (states.includes('error')) return 'error';
  if (states.includes('review')) return 'review';
  if (states.includes('waiting')) return 'waiting';
  if (states.includes('running')) return 'running';
  return 'idle';
}

function visualStatusFromTerminalState(state: TerminalStatusState): VisualStatus {
  switch (state) {
    case 'working': return 'running';
    case 'blocked': return 'waiting';
    case 'review-ready': return 'review';
    case 'complete': return 'idle';
    case 'failed': return 'error';
    case 'idle':
    case 'unknown': return 'idle';
  }
}

function inferRuntime(sessionKey: string, rawRuntime?: string): OrchestratorRuntime {
  const normalized = (rawRuntime ?? '').toLowerCase();
  if (isOrchestratorRuntime(normalized)) return normalized;
  for (const runtime of ORCHESTRATOR_RUNTIME_IDS) {
    const capability = getRuntimeCapability(runtime);
    if (normalized === capability.label.toLowerCase()
      || sessionKey.startsWith(`${runtime}-owned:`)
      || sessionKey.startsWith(`${runtime}:`)) {
      return runtime;
    }
  }
  if (normalized.includes('claude')) return 'claude-code';
  return 'codex';
}

function displayName(agent: FleetAgent | null, packet: OrchestratorPacket | null | undefined, sessionKey: string): string {
  // Canonical label — never an id slice. Falls back to the runtime's human
  // name ("Codex") rather than a raw `codex-owned:...` key.
  return agentDisplayLabel({ name: agent?.name ?? packet?.title, sessionKey });
}

function entryContent(entry: MobileTranscriptEntry): string {
  const text = entry.text.trim();
  if (text) return text;
  if (entry.compaction?.summary?.trim()) return entry.compaction.summary.trim();
  const toolCalls = entry.toolCalls ?? [];
  return toolCalls.length > 0 ? toolCalls.map((toolCall) => `tool: ${toolCall.name}`).join('\n') : '';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function conciseWorkerPrompt(text: string, taskTitle?: string): string {
  if (!/^## Project Brief(?:\s|$)/i.test(text)) return text;
  const taskSection = text.match(/## Task\s+([\s\S]*)/i)?.[1];
  if (!taskSection) return text;
  const title = taskTitle?.trim();
  const withoutScaffolding = title
    ? taskSection.replace(
      new RegExp(`^Packet:\\s*${escapeRegExp(title)}\\s+Summary:\\s*Task\\s+\\S+:\\s*${escapeRegExp(title)}\\s+`, 'i'),
      '',
    )
    : taskSection.replace(/^Packet:\s*(.+?)\s+Summary:\s*Task\s+\S+:\s*\1\s+/i, '');
  const branchIndex = withoutScaffolding.search(/\s+Branch target:/i);
  const task = (branchIndex >= 0 ? withoutScaffolding.slice(0, branchIndex) : withoutScaffolding).trim();
  return task || text;
}

export function normalizeAgentTileTranscript(
  entries: MobileTranscriptEntry[],
  taskTitle?: string,
  taskPrompt?: { id: string; text: string } | null,
): MobileTranscriptEntry[] {
  const normalized = entries.map((entry) => {
    if (entry.role !== 'user') return entry;
    const text = conciseWorkerPrompt(entry.text, taskTitle);
    return text === entry.text ? entry : { ...entry, text };
  });
  const prompt = taskPrompt?.text.trim();
  const taskPromptId = taskPrompt?.id;
  if (prompt && taskPromptId && normalized[0]?.role !== 'user') {
    normalized.unshift({
      id: `packet-task-${taskPromptId}`,
      role: 'user',
      text: prompt,
    });
  }
  return mergeAdjacentToolOnlyEntries(normalized);
}

const TRANSCRIPT_STEER_LOADING_TIMEOUT_MS = 10_000;
const STICK_TO_BOTTOM_THRESHOLD_PX = 120;

function isNearBottom(container: HTMLElement): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight < STICK_TO_BOTTOM_THRESHOLD_PX;
}

function useAgentTileStickToBottom(active: boolean, changeKey: string, hasContent: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const pinToBottom = useCallback(() => {
    const container = scrollRef.current;
    if (!container || !stickToBottomRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, []);

  const handleScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    stickToBottomRef.current = isNearBottom(event.currentTarget);
    setShowJumpToLatest(!stickToBottomRef.current);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
    const frame = window.requestAnimationFrame(pinToBottom);
    return () => window.cancelAnimationFrame?.(frame);
  }, [changeKey, pinToBottom]);

  useEffect(() => {
    const container = scrollRef.current;
    const content = contentRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(pinToBottom);
    observer.observe(container);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [hasContent, pinToBottom]);

  useEffect(() => {
    if (!active || typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
    let frame = 0;
    let cancelled = false;
    const pin = () => {
      if (cancelled) return;
      pinToBottom();
      frame = window.requestAnimationFrame(pin);
    };
    frame = window.requestAnimationFrame(pin);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame?.(frame);
    };
  }, [active, pinToBottom]);

  const jumpToLatest = useCallback(() => {
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    pinToBottom();
  }, [pinToBottom]);

  return { contentRef, handleScroll, scrollRef, showJumpToLatest, jumpToLatest };
}

export function canSteerAgentState(
  agent: Pick<FleetAgent, 'status'> | null,
  packet: Pick<OrchestratorPacket, 'status' | 'blockedReason'> | null | undefined,
  sessionKey?: string,
): boolean {
  const agentStatus = (agent?.status ?? '').toLowerCase();
  const packetStatus = (packet?.status ?? '').toLowerCase();
  const blockedReason = (packet?.blockedReason ?? '').toLowerCase();
  if (agentStatus === 'running' || packetStatus === 'running') return true;
  if (packetStatus.includes('awaiting_') || agentStatus.includes('awaiting_')) return true;
  // A parked session is exactly when steering is the cheap recovery path -- it
  // reuses the warm thread instead of throwing it away for a redispatch. The
  // steer route itself gates on whether a session binding resolves, not on the
  // display status, and an `idle` packet steered successfully while its pane
  // showed no composer at all (#1846). `recovering` is the retry-pending pause
  // between escalation layers, and is steerable for the same reason.
  if (packetStatus === 'idle' || packetStatus === 'recovering') return true;
  if (/^(codex-owned|claude-code-owned):.+/.test(sessionKey ?? '') && !packet
    && ['completed', 'finished', 'idle', 'paused', 'waiting'].includes(agentStatus)) return true;
  return packetStatus === 'blocked' && (blockedReason === 'huddle_ready' || blockedReason === 'worker_question');
}

function AgentTilePaneBase({ sessionKey, agent, packet, focused, onClose, onFocus, onOpenReview }: AgentTilePaneProps) {
  const { paneRef, compact } = useWorkerPaneSize();
  const peerExchange = useAgentPeerMessages(sessionKey);
  const slice = useTranscript(sessionKey);
  const transcriptUnsupportedReason = agent?.transcriptUnsupportedReason?.trim() || null;
  const usesStructuredPacketTranscript = Boolean(packet?.id && !transcriptUnsupportedReason);
  const packetTranscript = usePacketTranscriptPoll({
    enabled: usesStructuredPacketTranscript,
    packetIdHint: packet?.id ?? null,
    sessionKey,
    // Agent tiles are mounted only while visible. Keep every visible split
    // live; statusHint stops the interval once the packet becomes terminal.
    active: true,
    statusHint: packet?.status ?? null,
  });
  const entries = useMemo<MobileTranscriptEntry[]>(() => {
    if (!packet?.id) return slice.messages;
    if (!transcriptUnsupportedReason) return packetTranscript.entries;
    return [{
      id: `transcript-unsupported:${transcriptUnsupportedReason}`,
      role: 'system',
      text: `Live structured transcript unavailable (${transcriptUnsupportedReason}). Showing runtime history fallback.`,
    }, ...slice.messages];
  }, [packet?.id, packetTranscript.entries, slice.messages, transcriptUnsupportedReason]);
  const loading = usesStructuredPacketTranscript
    ? packetTranscript.entries.length === 0 && (slice.status === 'loading' || slice.status === 'idle')
    : slice.status === 'loading' || slice.status === 'idle';
  const error = slice.status === 'error' ? slice.error ?? 'Unable to load transcript.' : null;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { value: draft, setValue: setDraft, captureOwner: captureDraftOwner, warning: draftWarning } = useComposerDraftValue(
    JSON.stringify(['worker-steer', sessionKey]), 'input', '',
  );
  const [sending, setSending] = useState(false);
  // Fix #4: synchronous guard so held-Enter can't double-fire before setState flushes
  const sendingRef = useRef(false);
  const pendingSteerRef = useRef<{ body: string; message: string; interrupt?: boolean } | null>(null);
  const [steerReceipt, setSteerReceipt] = useState<'sending' | 'accepted' | 'unknown' | 'failed' | null>(null);
  const loadingFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const name = useMemo(() => displayName(agent, packet, sessionKey), [agent, packet, sessionKey]);
  const displayTitle = shortWorkerTitle({ label: packet ? packet.title : agent?.currentTask || agent?.name, branch: packet?.branchTarget, fallback: name });
  const displayEntries = useMemo(() => normalizeAgentTileTranscript(
    entries,
    name,
    packet?.issue?.body ? { id: packet.id, text: packet.issue.body } : null,
  ), [entries, name, packet?.id, packet?.issue?.body]);
  const runtime = packet
    ? resolveDisplayRuntime(packet)
    : inferRuntime(sessionKey, agent?.runtime);
  const resolvedModel = packet?.lane?.model ?? agent?.model ?? packet?.model ?? packet?.workerRouting?.selectedModel ?? packet?.assignedModel;
  const modelLabel = resolvedModel?.trim() || null;
  const taskLabel = agent?.currentTask?.trim() || packet?.title?.trim() || packet?.summary?.trim() || null;
  const attention = workerAttention(packet?.status ?? agent?.status, packet?.blockedReason);
  const statusEvidence = packet ? packet.statusEvidence : agent?.statusEvidence;
  const status = useMemo(
    () => statusEvidence
      ? visualStatusFromTerminalState(statusEvidence.state)
      : resolveAgentTileStatus(agent?.status, packet?.status, packet?.blockedReason),
    [agent?.status, packet?.blockedReason, packet?.status, statusEvidence],
  );
  const canSteer = canSteerAgentState(agent, packet, sessionKey);
  const trimmedDraft = draft.trim();
  const canSend = canSteer && !sending && steerReceipt !== 'unknown' && trimmedDraft.length > 0;
  const lastEntryKey = displayEntries.length > 0
    ? `${displayEntries[displayEntries.length - 1]?.id}:${entryContent(displayEntries[displayEntries.length - 1]!)}`
    : '';
  const lastPeerKey = peerExchange.messages[0]?.id ?? '';
  const { contentRef, handleScroll, scrollRef, showJumpToLatest, jumpToLatest } = useAgentTileStickToBottom(
    status === 'running',
    `${lastEntryKey}:${lastPeerKey}`,
    displayEntries.length > 0 || peerExchange.messages.length > 0,
  );

  // Fix #1: keep a ref in sync with latest agent so submitSteer re-derives
  // canSteer at call time, not at callback-creation time.
  const agentRef = useRef(agent);
  useEffect(() => { agentRef.current = agent; }, [agent]);
  const packetRef = useRef(packet);
  useEffect(() => { packetRef.current = packet; }, [packet]);

  const clearTranscriptLoadingFallback = useCallback(() => {
    if (!loadingFallbackRef.current) return;
    clearTimeout(loadingFallbackRef.current);
    loadingFallbackRef.current = null;
  }, []);

  const resolveSteer = useCallback(async (request: { body: string; message: string; interrupt?: boolean }) => {
    const ownsDraft = captureDraftOwner();
    setSending(true);
    setSteerReceipt('sending');
    setSendError(null);
    try {
      const { response, payload } = await fetchCorrelatedActionReceipt<{
        ok?: boolean;
        note?: string;
        error?: string;
        inProgress?: boolean;
        status?: string;
      }>('/api/runtime/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: request.body,
      });
      if (!response.ok || payload?.ok === false) {
        const note = payload?.error ?? payload?.note ?? response.statusText ?? 'Unable to send steer.';
        setSendError(note);
        setSteerReceipt('failed');
        if (!request.interrupt && ownsDraft()) setDraft(request.message);
        pendingSteerRef.current = null;
        return;
      }
      setSteerReceipt('accepted');
      pendingSteerRef.current = null;
      if (request.interrupt) return;
      // Fix #5: set transcript to loading but fall back to idle after 10s if WS push never arrives
      clearTranscriptLoadingFallback();
      transcriptStore.setStatus(sessionKey, 'loading');
      loadingFallbackRef.current = setTimeout(() => {
        loadingFallbackRef.current = null;
        if (transcriptStore.getSlice(sessionKey).status !== 'loading') return;
        transcriptStore.setStatus(sessionKey, 'idle');
      }, TRANSCRIPT_STEER_LOADING_TIMEOUT_MS);
    } catch (err) {
      if (correlatedActionIsUnsettled(err)) {
        setSteerReceipt('unknown');
        setSendError('Final receipt unavailable. Check the same action before sending again.');
      } else {
        setSteerReceipt('failed');
        if (!request.interrupt && ownsDraft()) setDraft(request.message);
        pendingSteerRef.current = null;
        setSendError(err instanceof Error ? err.message : 'Unable to send steer.');
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [captureDraftOwner, clearTranscriptLoadingFallback, sessionKey, setDraft]);

  const submitSteer = useCallback((resumeMessage?: string) => {
    const message = resumeMessage ?? trimmedDraft;
    // Re-derive the latest lane state and synchronously guard duplicate submits.
    if (!message || !canSteerAgentState(agentRef.current, packetRef.current, sessionKey)
      || sendingRef.current || pendingSteerRef.current) return;
    sendingRef.current = true;
    const request = { body: JSON.stringify({
      action: 'steer', surfaceId: sessionKey, clientMutationId: crypto.randomUUID(), message,
    }), message };
    pendingSteerRef.current = request;
    setDraft('');
    void resolveSteer(request);
  }, [resolveSteer, sessionKey, setDraft, trimmedDraft]);

  const stopWorker = useCallback(() => {
    if (sendingRef.current || pendingSteerRef.current) return;
    sendingRef.current = true;
    const request = { body: JSON.stringify({ action: 'interrupt', surfaceId: sessionKey, clientMutationId: crypto.randomUUID() }), message: '', interrupt: true };
    pendingSteerRef.current = request;
    void resolveSteer(request);
  }, [resolveSteer, sessionKey]);

  const checkSteerReceipt = useCallback(() => {
    const request = pendingSteerRef.current;
    if (!request || sendingRef.current) return;
    sendingRef.current = true;
    void resolveSteer(request);
  }, [resolveSteer]);

  const handleFormSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void submitSteer();
    },
    [submitSteer],
  );

  // When the lane stops accepting input, drop any error so the composer
  // doesn't carry stale state into the next live run.
  useEffect(() => {
    if (!canSteer && steerReceipt !== 'unknown' && steerReceipt !== 'failed') setSendError(null);
  }, [canSteer, steerReceipt]);

  useEffect(() => {
    if (slice.status !== 'fresh') return;
    if (transcriptStore.getSlice(sessionKey).status !== 'fresh') return;
    clearTranscriptLoadingFallback();
  }, [clearTranscriptLoadingFallback, sessionKey, slice.status]);

  useEffect(() => () => {
    clearTranscriptLoadingFallback();
  }, [clearTranscriptLoadingFallback, sessionKey]);

  // One-shot seed for agents not in the workspace bootstrap list. Mounted
  // transcript consumers subscribe to the shared realtime stream afterward.
  useEffect(() => {
    if (slice.status !== 'idle') return;
    void bootstrapTranscripts([sessionKey]);
  }, [sessionKey, slice.status]);

  return (
    <div
      ref={paneRef}
      data-worker-pane
      data-compact={compact}
      onMouseDown={() => onFocus(sessionKey)}
      style={{
        flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
        // Paint the frame inside the pane without shifting the shared composer baseline.
        borderRadius: 14, outlineWidth: 1, outlineStyle: 'solid', outlineOffset: -1,
        outlineColor: focused ? 'var(--t-border-hover, var(--t-border))' : 'var(--t-border)',
        background: 'var(--t-chat-surface-bg, var(--t-panel))',
        boxShadow: 'none',
        overflow: 'hidden',
      }}
    >
      <WorkerPaneHeader title={displayTitle} branch={packet?.branchTarget} issueNumber={packet?.issue?.number}
        runtime={getRuntimeCapability(runtime).label} model={modelLabel} compact={compact} status={status}
        statusLabel={statusEvidence ? terminalStatusCaption(statusEvidence)
          : packet?.status === 'archived' ? 'Archived' : packet?.status === 'released' ? 'Complete' : STATUS_META[status].label}
        actions={<>
          <WorkerReviewAction packet={packet} onOpenReview={onOpenReview} size={24} />
          <SessionTransformMenu runtimeId={runtime} sessionKey={sessionKey} size={24} />
          <button type="button" aria-label={`Hide ${displayTitle} pane`} title="Hide pane · worker stays available in Agents"
            onClick={event => { event.stopPropagation(); onClose(sessionKey); }} style={WORKER_ICON_BUTTON}>
            <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </>} />

      {statusEvidence ? (
        <TerminalStatusEvidenceDisclosure evidence={statusEvidence} />
      ) : null}

      <WorkerPaneSummary packet={packet} onOpenReview={hasWorkerReviewAction(packet) ? undefined : onOpenReview} onReply={canSteer ? () => textareaRef.current?.focus() : undefined} />

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="cortex-scroll-fade-y cortex-themed-scroll"
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          overscrollBehaviorY: 'contain',
          paddingTop: 14, paddingRight: 'var(--cortex-chat-gutter)', paddingBottom: 36, paddingLeft: 'var(--cortex-chat-gutter)',
          background: 'transparent',
        }}
      >
        {taskLabel ? <div data-worker-task title={taskLabel} style={{ width: '100%', maxWidth: 'var(--cortex-chat-column-max)', marginRight: 'auto', marginBottom: 16, marginLeft: 'auto' }}>
          <div style={{ color: 'var(--t-text-faint)', fontSize: 10, marginBottom: 5 }}>TASK</div>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--t-text)', fontSize: 12.5, fontWeight: 500 }}>{taskLabel}</div>
        </div> : null}
        {displayEntries.length === 0 && peerExchange.messages.length === 0 ? (
          <div
            ref={contentRef}
            style={{
              flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
              color: 'var(--t-text-secondary)', fontSize: 12, lineHeight: 1.5,
            }}
          >
            {loading ? 'Loading transcript…' : error ?? 'No transcript yet.'}
          </div>
        ) : (
          <div
            ref={contentRef}
            style={{
              width: '100%', maxWidth: 'var(--cortex-chat-column-max)', minHeight: '100%',
              marginRight: 'auto', marginLeft: 'auto', display: 'flex', flexDirection: 'column', gap: 8,
            }}
          >
            <WorkspaceTranscript
              entries={displayEntries}
              peerMessages={peerExchange.messages}
              peerName={peerExchange.self?.name}
              markLast={status !== 'running'}
              isStreaming={status === 'running'}
              repoPath={packet?.lane?.worktreePath ?? packet?.lane?.repoPath ?? agent?.workspace ?? null}
              packetId={packet?.id}
              laneId={packet?.lane?.laneId}
              onOpenReview={onOpenReview}
            />
          </div>
        )}
      </div>

      {showJumpToLatest ? <div style={{ position: 'relative', height: 0, flexShrink: 0 }}>
        <button type="button" onClick={jumpToLatest}
          style={{ position: 'absolute', right: 12, bottom: 8, border: '1px solid var(--t-border)', borderRadius: 8,
            paddingTop: 5, paddingRight: 9, paddingBottom: 5, paddingLeft: 9, background: 'var(--t-panel)',
            color: 'var(--t-text)', fontFamily: 'inherit', fontSize: 11, fontWeight: 300, cursor: 'pointer' }}>
          New messages · Jump to latest
        </button>
      </div> : null}

      {canSteer || attention || steerReceipt === 'unknown' ? (
        <form onSubmit={handleFormSubmit} style={{ flexShrink: 0, background: 'transparent' }}>
          <SessionCacheIndicator session={sessionKey} runtime={runtime} model={modelLabel} entries={slice.messages.length ? slice.messages : entries} running={status === 'running'} />
          <WorkerPaneComposer key={sessionKey} textareaRef={textareaRef} scopeKey={sessionKey}
            active={focused} compact={compact} input={draft} onInputChange={next => {
              setDraft(next);
              if (steerReceipt === 'accepted' || steerReceipt === 'failed') {
                setSteerReceipt(null);
                setSendError(null);
              }
            }} onSend={() => submitSteer()} canSend={canSend}
            disabled={!canSteer || sending || steerReceipt === 'unknown'} attention={attention}
            busy={sending || steerReceipt === 'unknown'}
            onResume={canSteer ? () => submitSteer(trimmedDraft || 'Continue the assigned task.') : undefined}
            onStop={stopWorker} onOpenReview={onOpenReview} repoPath={packet?.lane?.worktreePath ?? packet?.lane?.repoPath ?? agent?.workspace}
          />
          {draftWarning ? <div data-worker-draft-warning role="status" style={{ color: 'var(--t-text-secondary)',
            fontSize: 11, paddingLeft: 8, paddingRight: 8, paddingBottom: 4 }}>{draftWarning}</div> : null}
          {steerReceipt === 'failed' || steerReceipt === 'unknown' ? (
            <div data-worker-steer-receipt role={steerReceipt === 'failed' ? 'alert' : 'status'} style={{ display: 'flex', alignItems: 'center', gap: 8, color: steerReceipt === 'failed' ? 'var(--t-danger)' : 'var(--t-text-secondary)', fontSize: 11, paddingLeft: 8, paddingRight: 8, paddingBottom: 4 }}>
              <span>{steerReceipt === 'unknown' ? 'Receipt unavailable' : 'Not sent'}{sendError ? ` · ${sendError}` : ''}</span>
              {steerReceipt === 'unknown' ? <button type="button" onClick={checkSteerReceipt} style={{ border: 0, background: 'transparent', color: 'var(--t-accent)', cursor: 'pointer', fontSize: 11, fontWeight: 300 }}>Check receipt</button> : null}
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

export const AgentTilePane = memo(AgentTilePaneBase);
