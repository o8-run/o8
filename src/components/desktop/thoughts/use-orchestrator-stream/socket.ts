import { parseSnapshotTurn } from './snapshot-turn';
import { orchestratorErrorText } from '@/lib/transcripts/orchestrator-error';
import type { Dispatch, SetStateAction } from 'react';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { isCortexAskTool, parseBrainFeed } from '@/components/desktop/thoughts/brain-feed';
import { isPaneOwnedThread } from '@/lib/orchestrator/pane-thread-registry';
import { skipDuplicateBySeq } from '@/lib/orchestrator/replay-cursor';
import {
  formatTimestampLabel,
  type OrchestratorStreamStatus,
} from './shared';
import { parseTerminalTurnReceipt, parseTerminalUsage } from './terminal-receipt';
import { parseHandoffEventData } from './handoff-socket';
import { createAssistantState, continuationUserMessage } from './continuation-start';
import { isCarriedCompactionUser } from '@/lib/transcripts/compaction';

interface RefLike<T> {
  current: T;
}

export interface OrchestratorSnapshotTurn {
  id: string;
  startedAt: number;
  settledAt: number | null;
  outcome: 'completed' | 'failed' | 'interrupted' | 'unconfirmed' | null;
  assistantMessageId: string | null;
}

export interface CurrentAssistantStreamState {
  id: string;
  chunks: string[];
  thinkingChunks: string[];
  epoch: number;
  backend?: MobileTranscriptEntry['backend'];
  model?: string;
  /** Wall-clock start of the reasoning phase. Claude 5-family thinking is
   *  signature-redacted (empty text), so the empty thinking marker is the only
   *  start signal — the duration it yields drives the "Thought for Ns" line. */
  thinkingStartedAt?: number | null;
  /** Frozen reasoning duration — stamped once when the first answer token or
   *  tool call ends the thinking phase. */
  thinkingDurationMs?: number | null;
  /** True for token-streaming backends (the o8 proxy rail and ACP): chunks are
   *  verbatim slices of one continuous string and must be concatenated with
   *  no separator. Block-emitting backends (Claude REPL, Codex items) send
   *  complete segments where the '\n' join glue is correct — injecting '\n'
   *  between token chunks rendered every few words as its own markdown
   *  paragraph (the 2026-07-13 o8-model transcript bug). */
  verbatimStream?: boolean;
}

interface CreateOrchestratorMessageHandlerOptions {
  captureFirstTurnPlanRef: RefLike<boolean>;
  currentWs: WebSocket;
  currentAssistantRef: RefLike<CurrentAssistantStreamState | null>;
  eventCountRef: RefLike<number>;
  snapshotSeenRef?: RefLike<boolean>;
  /** Highest event seq applied for this session — drives replay de-dup. */
  lastSeqRef: RefLike<number>;
  finalizeFirstTurnPlanCapture: () => void;
  firstTurnPlanChunksRef: RefLike<string[]>;
  firstTurnPlanStartedRef: RefLike<boolean>;
  flushCurrentAssistant: () => void;
  /** Coalesced (rAF-batched) flush for the streaming-text path — one re-render per frame. */
  scheduleFlushCurrentAssistant: () => void;
  /**
   * Last backend id seen on any orchestrator event (`data.backend` rides every
   * ws-server emission, including the subscribe-ack snapshot). Fable Slice 4:
   * the auto-compact effect reads this to pick the metered vs global threshold.
   */
  lastBackendRef?: RefLike<string | null>;
  /** Backend selected for the locally active turn, used by Stop/re-subscribe. */
  activeTurnBackendRef?: RefLike<string | null>;
  /** Transcript-bearing events observed during the locally active turn. */
  turnTranscriptEventCountRef?: RefLike<number>;
  /** Drop late stream deltas after undo until the interrupted turn settles. */
  suppressTurnEventsRef?: RefLike<boolean>;
  /**
   * The thread this view is bound to (null = unbound fresh view). Drives the
   * thread-scope ingest guard: with drag-to-split, several live chat views
   * share one repo, and an event stamped with ANOTHER view's threadId must
   * never paint into this transcript.
   */
  threadIdRef?: RefLike<string | null>;
  allowUnboundRecoveryRef?: RefLike<boolean>;
  lastEventAtRef: RefLike<number>;
  messagesRef: RefLike<MobileTranscriptEntry[]>;
  onOrchestratorActivity?: (event: {
    event: string;
    data?: Record<string, unknown>;
    observedAt: number;
  }) => void;
  onVoiceTerminal?: (receipt: { userMessageId: string; outcome: 'completed' | 'failed' | 'interrupted' | 'unconfirmed'; text: string }) => void;
  onSnapshotTurnTerminal?: (turn: OrchestratorSnapshotTurn | null, wasRunning: boolean) => void;
  onSettledAssistantMissing?: (turn: OrchestratorSnapshotTurn) => void;
  resetEpochRef: RefLike<number>;
  setMessages: Dispatch<SetStateAction<MobileTranscriptEntry[]>>;
  setStatus: Dispatch<SetStateAction<OrchestratorStreamStatus>>;
  statusRef: RefLike<OrchestratorStreamStatus>;
  wsRef: RefLike<WebSocket | null>;
}

// RC1 seam 3 — stale-busy reconcile window. A subscribe/reconnect snapshot must
// NOT downgrade a genuinely live 'busy' (the first-turn re-subscribe race: a
// snapshot 'ready' can land right after send() optimistically set 'busy', before
// the first token). But if the local turn has gone quiet longer than this window
// — the terminal 'ready' was dropped by a socket flap and never reached us — the
// busy is STALE and permanently latches the composer (J4FHM2 "second turns don't
// fire"). Past this window we trust the server snapshot to clear it. A recent
// send OR event keeps lastEventAt fresh (send() stamps it), preserving the race
// guard; only a truly silent turn heals.
const ORCH_SNAPSHOT_BUSY_RECONCILE_MS = 6000;


export function createOrchestratorMessageHandler(
  options: CreateOrchestratorMessageHandlerOptions,
) {
  const contextAssistantIds = new Set<string>();
  const setTranscriptMessages = (update: SetStateAction<MobileTranscriptEntry[]>) => {
    options.setMessages((prev) => {
      const next = typeof update === 'function'
        ? (update as (prev: MobileTranscriptEntry[]) => MobileTranscriptEntry[])(prev)
        : update;
      options.messagesRef.current = next;
      return next;
    });
  };

  return (event: MessageEvent) => {
    if (options.currentWs !== options.wsRef.current) return;

    let msg: { channel?: string; event?: string; data?: Record<string, unknown>; seq?: number };
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
    } catch {
      return;
    }

    // #529 — Supervisor/agent lifecycle events ride a separate channel so
    // their `detail` payloads (codex transcript previews, stuck steers, etc.)
    // cannot bleed into the orchestrator chat. We still listen for them on
    // the same underlying WebSocket connection, but route them straight to
    // the window-level listener without touching transcript state.
    if (msg.channel === 'supervisor') {
      if (msg.event !== 'agent-update') return;
      const update = msg.data as {
        surfaceId?: string;
        name?: string;
        status?: string;
        detail?: string;
        duration?: number;
        repoPath?: string;
        prompt?: string;
        launchContext?: import('@/lib/orchestrator/types').WorkerLaunchContext;
      } | undefined;
      if (!update?.surfaceId) return;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('cortex:agent-supervisor-update', { detail: update }));
      }
      return;
    }

    if (msg.channel !== 'orchestrator') return;

    // Thread-scope ingest guard (drag-to-split, 2026-07-15). Every ws-server
    // orchestrator emission stamps data.threadId. With several live chat
    // views on one repo:
    // - a view bound to thread X drops events for thread Y outright;
    // - an unbound recovery view can reattach to in-flight turns unless a
    //   thread pane owns them; fresh workspace views explicitly disable that
    //   recovery until their own send or history load binds a conversation.
    const evtThreadId = typeof msg.data?.threadId === 'string' && msg.data.threadId
      ? msg.data.threadId
      : null;
    if (evtThreadId) {
      const ownThreadId = options.threadIdRef?.current ?? null;
      if (ownThreadId && evtThreadId !== ownThreadId) return;
      if (!ownThreadId && (options.allowUnboundRecoveryRef?.current === false || isPaneOwnedThread(evtThreadId))) return;
    }

    // A prime/replay turn reuses carried context, not an operator send. Its
    // assistant output belongs to that context too, never to the live reply.
    const assistantId = typeof msg.data?.assistantMessageId === 'string' ? msg.data.assistantMessageId : null;
    const carried = msg.event === 'turn-start' ? continuationUserMessage(msg.data) : null;
    if (carried && isCarriedCompactionUser(carried, options.messagesRef.current)) {
      if (assistantId) {
        contextAssistantIds.add(assistantId);
        if (contextAssistantIds.size > 32) contextAssistantIds.delete(contextAssistantIds.values().next().value!);
      }
      return;
    }
    if (assistantId && contextAssistantIds.has(assistantId)) return;

    const terminal = msg.data?.voiceTerminal as Record<string, unknown> | undefined;
    if (terminal && typeof terminal.userMessageId === 'string' && typeof terminal.text === 'string'
      && (terminal.outcome === 'completed' || terminal.outcome === 'failed' || terminal.outcome === 'interrupted' || terminal.outcome === 'unconfirmed')) {
      options.onVoiceTerminal?.({ userMessageId: terminal.userMessageId, outcome: terminal.outcome, text: terminal.text });
    }

    if (options.suppressTurnEventsRef?.current) {
      const terminalStatus = msg.event === 'status'
        && (msg.data?.status === 'ready' || msg.data?.status === 'dead');
      if (terminalStatus) options.suppressTurnEventsRef.current = false;
      return;
    }

    const observedAt = Date.now();
    options.onOrchestratorActivity?.({
      event: typeof msg.event === 'string' ? msg.event : '',
      data: msg.data,
      observedAt,
    });

    // Replay seq values are scoped to one backend session. A backend switch in
    // the same UI thread starts a new sequence at 1, so carryover from the old
    // backend must be discarded before de-duplication or the whole new stream
    // is mistaken for replayed output (#1557).
    if (options.lastBackendRef && typeof msg.data?.backend === 'string') {
      if (options.lastBackendRef.current && options.lastBackendRef.current !== msg.data.backend) {
        options.lastSeqRef.current = 0;
      }
      options.lastBackendRef.current = msg.data.backend;
      if (options.activeTurnBackendRef && msg.data?.snapshot !== true) {
        options.activeTurnBackendRef.current = msg.data.backend;
      }
    }

    // Replay de-dup: live + replayed events carry a monotonic per-session seq.
    // Skip anything we've already applied so a replay overlap (or a re-
    // subscribe) can't double-apply tokens. Snapshot/notice sends have no seq.
    if (skipDuplicateBySeq(msg, options.lastSeqRef)) return;

    // Snapshot (subscribe-ack) sends are a point-in-time status, NOT live
    // activity. Counting them advances the reconnect-heal guard AND keeps
    // resetting the stale-busy watchdog, so a 'busy' snapshot for a dead session
    // would pin the "Working" timer forever. Only live events advance these. (#1282)
    //
    // Same guard, thread axis (2026-07-15 six-hour-timer incident): a BOUND
    // view's stall clock only listens to its OWN turn's events. Every real
    // turn emission stamps data.threadId, so on a bound view an UNSTAMPED
    // event (session-wide broadcasts, e.g. the supervisor auto-queue) still
    // paints below but must not keep resetting the no-snapshot fallback clock.
    if (msg.data?.snapshot !== true) {
      const ownThreadId = options.threadIdRef?.current ?? null;
      if (!ownThreadId || evtThreadId === ownThreadId) {
        options.eventCountRef.current += 1;
        options.lastEventAtRef.current = observedAt;
        if (
          options.turnTranscriptEventCountRef
          && (msg.event === 'output' || msg.event === 'tool-use' || msg.event === 'tool-result' || msg.event === 'error')
        ) {
          options.turnTranscriptEventCountRef.current += 1;
        }
      }
    }

    // #register-mcp — transient banner notices ride the same channel but
    // don't touch transcript state. They're dispatched to a window listener
    // that the chat panel subscribes to via useOrchestratorReloadNotice.
    if (msg.event === 'notice') {
      const data = msg.data as {
        kind?: string;
        noticeId?: string;
        message?: string;
        registered?: unknown;
        repoPath?: string;
      } | undefined;
      if (data && typeof data.kind === 'string' && typeof data.noticeId === 'string' && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('cortex:orchestrator-notice', { detail: data }));
      }
      return;
    }

    switch (msg.event) {
      case 'turn-start': {
        const entry = continuationUserMessage(msg.data);
        if (!entry || options.currentAssistantRef.current?.id === msg.data?.assistantMessageId
          || options.messagesRef.current.some(message => message.id === entry.id)) break;
        if (options.currentAssistantRef.current) options.flushCurrentAssistant();
        options.currentAssistantRef.current = createAssistantState(options.resetEpochRef, msg.data?.assistantMessageId, msg.data?.backend, msg.data?.model);
        setTranscriptMessages(previous => previous.some(message => message.id === entry.id) ? previous : [...previous, entry]);
        break;
      }
      case 'handoff': {
        const handoff = parseHandoffEventData(msg.data);
        if (!handoff) break;
        const timestamp = Date.now();
        setTranscriptMessages((prev) => {
          const entry: MobileTranscriptEntry = {
            id: handoff.handoffId,
            role: 'system',
            text: `${handoff.from?.model ?? handoff.from?.backend ?? 'Unknown source'} handed off to ${handoff.to.model ?? handoff.to.backend}.`,
            type: 'handoff',
            handoff,
            timestamp,
            timestampLabel: formatTimestampLabel(timestamp),
          };
          const index = prev.findIndex((message) => message.id === entry.id);
          if (index < 0) {
            const beforeMessageId = typeof msg.data?.beforeMessageId === 'string' ? msg.data.beforeMessageId : null;
            const beforeIndex = beforeMessageId ? prev.findIndex((message) => message.id === beforeMessageId) : -1;
            const next = [...prev];
            next.splice(beforeIndex >= 0 ? beforeIndex : next.length, 0, entry);
            return next;
          }
          const next = [...prev];
          next[index] = entry;
          return next;
        });
        break;
      }

      // #2142 — the server retried this turn and threw the previous attempt
      // away. Its narration is already rendered in the live bubble (settle only
      // ever gated the terminal events, so every token streamed before the
      // false dispatch could be detected). Clear it here, or the retry's reply
      // appends to it and the operator reads two turns as one.
      case 'retry': {
        const current = options.currentAssistantRef.current;
        if (current) {
          current.chunks = [];
          current.thinkingChunks = [];
          current.thinkingStartedAt = null;
          current.thinkingDurationMs = null;
          setTranscriptMessages((prev) => {
            const index = prev.findIndex((message) => message.id === current.id);
            if (index < 0) return prev;
            const next = [...prev];
            next[index] = { ...next[index], text: '', thinking: undefined, thinkingActive: false };
            return next;
          });
        }
        const notice = typeof msg.data?.notice === 'string' ? msg.data.notice : '';
        if (notice && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('cortex:orchestrator-notice', {
            detail: {
              kind: 'orchestrator-turn-retry',
              noticeId: `orch-retry-${current?.id ?? 'turn'}-${msg.data?.attempt ?? 2}`,
              message: notice,
              repoPath: typeof msg.data?.repoPath === 'string' ? msg.data.repoPath : undefined,
            },
          }));
        }
        break;
      }

      case 'output': {
        const text = typeof msg.data?.text === 'string' ? msg.data.text : '';
        const isThinkingMarker = msg.data?.thinking === true;

        // Empty thinking marker — Claude 5-family reasoning streams
        // signature-only (content redacted at the API), so the block-start
        // event with no text is the ONLY signal a reasoning phase began.
        // Materialize the assistant entry with `thinkingActive` so the
        // transcript shows a live "Thinking" line, and stamp the start time
        // for the "Thought for Ns" duration once reasoning ends.
        if (!text) {
          if (!isThinkingMarker) break;
          if (!options.currentAssistantRef.current) {
            if (options.statusRef.current !== 'busy') {
              options.statusRef.current = 'busy';
              options.setStatus('busy');
            }
            options.currentAssistantRef.current = createAssistantState(options.resetEpochRef, msg.data?.assistantMessageId, msg.data?.backend, msg.data?.model);
          }
          const thinkingState = options.currentAssistantRef.current;
          if (thinkingState.thinkingStartedAt == null) {
            thinkingState.thinkingStartedAt = Date.now();
            setTranscriptMessages((prev) => {
              const idx = prev.findIndex((message) => message.id === thinkingState.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = { ...next[idx], backend: thinkingState.backend, model: thinkingState.model, thinkingActive: true };
                return next;
              }
              return [...prev, {
                id: thinkingState.id,
                role: 'assistant' as const,
                text: '',
                backend: thinkingState.backend,
                model: thinkingState.model,
                thinkingActive: true,
                timestamp: Date.now(),
                timestampLabel: formatTimestampLabel(Date.now()),
              }];
            });
          }
          break;
        }
        const isThinking = isThinkingMarker;

        if (!isThinking && options.captureFirstTurnPlanRef.current) {
          if (options.firstTurnPlanStartedRef.current || text.trim()) {
            options.firstTurnPlanStartedRef.current = true;
            options.firstTurnPlanChunksRef.current.push(text);
          }
        }

        if (
          !options.currentAssistantRef.current
          || options.currentAssistantRef.current.epoch !== options.resetEpochRef.current
        ) {
          // Output arriving IS proof the turn is live — never drop it on a
          // status mismatch. The first-turn re-subscribe race (threadId mints
          // mid-turn → re-subscribe → the server's snapshot status can land as
          // non-'busy' right as the first tokens arrive) used to `break` here
          // and silently kill the entire stream until a reload. Promote to busy
          // and render instead. 2026-06-18.
          //
          // RC1 seam 1 — the same applies on an EPOCH mismatch: a mid-turn
          // reset() bumps resetEpochRef, and the answer tokens of a still-running
          // server turn kept arriving on the same socket. The old branch nulled
          // the assistant and `break`ed, discarding every remaining answer token
          // (D7HY6S "thinking shown, no answer"). Instead of dropping, open a
          // fresh assistant entry stamped to the current epoch and keep rendering
          // the answer into it. The server turn is durable — the tokens are real.
          if (options.statusRef.current !== 'busy') {
            options.statusRef.current = 'busy';
            options.setStatus('busy');
          }
          options.currentAssistantRef.current = createAssistantState(options.resetEpochRef, msg.data?.assistantMessageId, msg.data?.backend, msg.data?.model);
        }

        if (isThinking) {
          const state = options.currentAssistantRef.current;
          if (state.thinkingStartedAt == null) state.thinkingStartedAt = Date.now();
          state.thinkingChunks.push(text);
        } else {
          const state = options.currentAssistantRef.current;
          // First answer token ends the reasoning phase — freeze the duration.
          if (state.thinkingStartedAt != null && state.thinkingDurationMs == null) {
            state.thinkingDurationMs = Date.now() - state.thinkingStartedAt;
          }
          state.chunks.push(text);
        }
        // Coalesced rAF flush for streaming deltas (see useOrchestratorStream) —
        // one re-render per frame instead of one per token.
        options.scheduleFlushCurrentAssistant();

        if (options.statusRef.current !== 'busy') options.setStatus('busy');
        break;
      }

      case 'status': {
        const newStatus = msg.data?.status as string | undefined;
        // A subscribe-ack carries a point-in-time SNAPSHOT of the session
        // status (ws-server tags it `snapshot:true`), NOT a live turn
        // transition. On the first turn of a fresh tab the threadId mints
        // mid-turn, forcing a re-subscribe whose snapshot can arrive as 'ready'
        // right after `send()` optimistically set 'busy' — adopting it would
        // clobber the in-flight turn, and the output guard above would then
        // silently drop every token (dead until reload). So a snapshot may
        // resync an idle client (settle 'ready', or move UP to 'busy' on a
        // reload into an active turn) but a LEGACY snapshot without turn-ledger
        // truth must never downgrade or finalize a live local 'busy'.
        const isSnapshot = msg.data?.snapshot === true;
        if (isSnapshot && options.snapshotSeenRef) options.snapshotSeenRef.current = true;
        const hasTurnTruth = isSnapshot
          && Object.prototype.hasOwnProperty.call(msg.data ?? {}, 'turn');
        const snapshotTurn = hasTurnTruth ? parseSnapshotTurn(msg.data?.turn) : undefined;
        if (newStatus === 'ready' || newStatus === 'busy' || newStatus === 'dead') {
          if (isSnapshot) {
            // The turn ledger is authoritative when present. An unsettled turn
            // is running even if the legacy session status drifted; null or a
            // settled record means any local timer/assistant/tool state is a
            // phantom and must be cleared immediately, without an elapsed-time
            // guess. Snapshots from older servers still use the race guard below.
            if (snapshotTurn !== undefined) {
              if (snapshotTurn?.settledAt === null) {
                options.statusRef.current = 'busy';
                options.setStatus('busy');
                break;
              }

              // Ledger says no active turn — but a JUST-SENT local turn may
              // not have its record yet: the first-turn threadId mint forces a
              // re-subscribe that races the send handler's awaits, so the
              // snapshot can ship turn:null (or the PRIOR settled turn) while
              // the new turn is spawning. Within the reconcile window a fresh
              // local busy keeps the legacy race guard; a genuinely phantom
              // timer is quiet past it and still clears, just bounded-late.
              const localQuietForMs = observedAt - options.lastEventAtRef.current;
              if (options.statusRef.current === 'busy' && localQuietForMs < ORCH_SNAPSHOT_BUSY_RECONCILE_MS) {
                break;
              }

              const wasRunning = options.statusRef.current === 'busy'
                || options.currentAssistantRef.current !== null
                || options.messagesRef.current.some((message) =>
                  message.toolCalls?.some((tool) => tool.status === 'running'),
                );
              if (options.currentAssistantRef.current) options.flushCurrentAssistant();
              options.onSnapshotTurnTerminal?.(snapshotTurn, wasRunning);
              options.currentAssistantRef.current = null;
              options.statusRef.current = 'ready';
              options.setStatus('ready');
              if (
                snapshotTurn
                && snapshotTurn.settledAt !== null
                && snapshotTurn.assistantMessageId
                && !options.messagesRef.current.some((message) => message.id === snapshotTurn.assistantMessageId)
              ) {
                options.onSettledAssistantMissing?.(snapshotTurn);
              }
              break;
            }
            if (options.statusRef.current === 'busy' && newStatus !== 'busy') {
              // RC1 seam 3/4 — a snapshot terminal (ready/dead) normally must NOT
              // downgrade a live busy (first-turn re-subscribe race). But when the
              // local turn has been silent past the reconcile window, our busy is
              // stale: the terminal 'ready' was dropped by a flap/remount and the
              // composer is latched (J4FHM2). The server only reports a terminal
              // snapshot when its session is not-busy (or it healed a stale-busy),
              // so on a quiescent local turn trust it and clear the latch. A recent
              // send/event keeps lastEventAt fresh and preserves the race guard.
              const quietForMs = observedAt - options.lastEventAtRef.current;
              if (quietForMs < ORCH_SNAPSHOT_BUSY_RECONCILE_MS) break;
              // Drop the orphaned in-flight assistant so the next turn's first
              // token opens a clean entry instead of appending to a dead stream.
              options.currentAssistantRef.current = null;
            }
            options.statusRef.current = newStatus;
            options.setStatus(newStatus);
            break;
          }
          if (
            newStatus === 'busy'
            && options.statusRef.current !== 'busy'
            && options.currentAssistantRef.current === null
            && options.messagesRef.current.length === 0
          ) {
            break;
          }
          options.statusRef.current = newStatus;
          options.setStatus(newStatus);

          if (newStatus === 'ready' && options.currentAssistantRef.current) {
            options.finalizeFirstTurnPlanCapture();
            const endedState = options.currentAssistantRef.current;
            // Turn ended mid-reasoning (abort / thinking-only turn) — freeze
            // the duration so the entry can't keep a live "Thinking" shimmer.
            if (endedState.thinkingStartedAt != null && endedState.thinkingDurationMs == null) {
              endedState.thinkingDurationMs = Date.now() - endedState.thinkingStartedAt;
            }
            const finalThinkingDurationMs = endedState.thinkingDurationMs ?? undefined;
            options.flushCurrentAssistant();
            const finalId = endedState.id;
            const tokens = parseTerminalUsage(msg.data?.usage);
            const receipt = parseTerminalTurnReceipt(msg.data?.receipt);
            setTranscriptMessages((prev) => prev.map((message) => {
              if (message.id !== finalId) return message;
              const needsToolSettle = message.toolCalls?.some((tool) => tool.status === 'running' || tool.status === 'calling');
              const needsThinkingSettle = message.thinkingActive === true;
              if (!needsToolSettle && !needsThinkingSettle && !tokens && !receipt) return message;
              return {
                ...message,
                ...(tokens ? { tokens } : {}),
                ...(receipt ? { receipt } : {}),
                // Turn completion alone cannot confirm a tool result.
                ...(needsToolSettle
                  ? { toolCalls: message.toolCalls!.map(tool => (tool.status === 'running' || tool.status === 'calling'
                    ? { ...tool, status: undefined } : tool)) }
                  : {}),
                ...(needsThinkingSettle
                  ? { thinkingActive: false, ...(finalThinkingDurationMs !== undefined ? { thinkingDurationMs: finalThinkingDurationMs } : {}) }
                  : {}),
              };
            }));
            options.currentAssistantRef.current = null;
          }
          if (newStatus === 'dead') {
            options.flushCurrentAssistant();
            options.finalizeFirstTurnPlanCapture();
          }
          if (newStatus === 'ready' && options.activeTurnBackendRef) {
            options.activeTurnBackendRef.current = null;
          }
        } else if (newStatus === 'starting') {
          options.statusRef.current = 'connecting';
          options.setStatus('connecting');
        }
        break;
      }

      case 'tool-use': {
        const toolName = typeof msg.data?.name === 'string' ? msg.data.name : 'unknown';
        options.finalizeFirstTurnPlanCapture();

        if (!options.currentAssistantRef.current) {
          // A tool-use event is also proof of a live turn — same rationale as
          // the output case: promote to busy instead of dropping the pill.
          if (options.statusRef.current !== 'busy') {
            options.statusRef.current = 'busy';
            options.setStatus('busy');
          }
          options.currentAssistantRef.current = createAssistantState(options.resetEpochRef, msg.data?.assistantMessageId, msg.data?.backend, msg.data?.model);
        }

        const current = options.currentAssistantRef.current;
        // A tool call also ends the reasoning phase — freeze the duration.
        if (current.thinkingStartedAt != null && current.thinkingDurationMs == null) {
          current.thinkingDurationMs = Date.now() - current.thinkingStartedAt;
        }
        const thinkingDurationMs = current.thinkingDurationMs ?? undefined;
        // Capture args (the tool input — e.g. a Task scout's description/type)
        // and the tool id. The desktop handler used to drop both, which is why
        // native Claude scouts reached the transcript unlabeled. The SwarmStatusCard
        // reads args.description to label each scout in the live crew.
        const toolArgs =
          typeof msg.data?.args === 'object' && msg.data?.args !== null
            ? (msg.data.args as Record<string, unknown>)
            : undefined;
        const toolUseId = typeof msg.data?.toolUseId === 'string' ? msg.data.toolUseId : null;
        const toolCall = { id: toolUseId, name: toolName, status: 'running' as const, args: toolArgs };
        setTranscriptMessages((prev) => {
          const idx = prev.findIndex((message) => message.id === current.id);
          if (idx >= 0) {
            const next = [...prev];
            const existing = next[idx];
            const existingTools = existing.toolCalls ?? [];
            next[idx] = {
              ...existing,
              backend: current.backend ?? existing.backend,
              model: current.model ?? existing.model,
              toolCalls: toolUseId && existingTools.some(tool => tool.id === toolUseId)
                ? existingTools.map(tool => tool.id === toolUseId ? { ...tool, name: toolName, ...(toolArgs ? { args: toolArgs } : {}) } : tool)
                : [...existingTools, toolCall],
              ...(thinkingDurationMs !== undefined ? { thinkingDurationMs, thinkingActive: false } : {}),
            };
            return next;
          }
          return [...prev, {
            id: current.id,
            role: 'assistant' as const,
            text: '',
            backend: current.backend,
            model: current.model,
            toolCalls: [toolCall],
            ...(thinkingDurationMs !== undefined ? { thinkingDurationMs, thinkingActive: false } : {}),
            timestamp: Date.now(),
            timestampLabel: formatTimestampLabel(Date.now()),
          }];
        });

        if (options.statusRef.current !== 'busy') options.setStatus('busy');
        break;
      }

      case 'tool-result': {
        const resultName = typeof msg.data?.name === 'string' ? msg.data.name : '';
        const isError = msg.data?.isError === true;
        const output = typeof msg.data?.output === 'string' ? msg.data.output : '';
        const toolUseId = typeof msg.data?.toolUseId === 'string' ? msg.data.toolUseId : null;
        const backend = typeof msg.data?.backend === 'string' ? msg.data.backend : undefined;
        // Results may arrive out of order. An identified result must never
        // settle a different call; legacy id-less events use the latest match.
        setTranscriptMessages(prev => {
          let entryIndex = -1;
          let toolIndex = -1;
          for (let i = prev.length - 1; i >= 0; i -= 1) {
            const tools = prev[i].toolCalls ?? [];
            const found = tools.findLastIndex(tool => toolUseId ? tool.id === toolUseId
              : (!resultName || tool.name === resultName) && (tool.status === 'running' || tool.status === 'calling'));
            if (found >= 0) { entryIndex = i; toolIndex = found; break; }
          }
          if (entryIndex < 0) return prev;
          const tools = [...prev[entryIndex].toolCalls!];
          const tool = tools[toolIndex];
          const brainFeed = isCortexAskTool(resultName) && output ? parseBrainFeed(output, tool.args) : null;
          tools[toolIndex] = { ...tool, status: isError ? 'error' : 'done', result: output,
            ...(backend ? { backend } : {}), ...(brainFeed ? { brainFeed } : {}) };
          const next = [...prev];
          next[entryIndex] = { ...prev[entryIndex], toolCalls: tools };
          return next;
        });
        break;
      }

      // ── Collide (MoA) pre-roll. The proposers buffer; these two events drive the
      //    faint, collapsible "proposals collided" card that precedes the answer.
      //    Proposer text NEVER becomes assistant text — only the aggregator streams.
      case 'collide-phase': {
        const phase = msg.data?.phase === 'synthesizing' ? 'synthesizing' : 'proposing';
        const proposers = Array.isArray(msg.data?.proposers) ? (msg.data!.proposers as string[]) : [];
        if (options.statusRef.current !== 'busy') {
          options.statusRef.current = 'busy';
          options.setStatus('busy');
        }
        if (phase === 'proposing') {
          setTranscriptMessages((prev) => [...prev, {
            id: `collide-${Date.now()}`,
            role: 'system' as const,
            text: '',
            collide: { phase: 'proposing', proposers, proposals: [] },
            timestamp: Date.now(),
            timestampLabel: formatTimestampLabel(Date.now()),
          }]);
        } else {
          // synthesizing — collapse the most recent active collide card.
          setTranscriptMessages((prev) => {
            const idx = [...prev].reverse().findIndex((m) => m.collide && m.collide.phase === 'proposing');
            if (idx < 0) return prev;
            const realIdx = prev.length - 1 - idx;
            const next = [...prev];
            next[realIdx] = { ...next[realIdx], collide: { ...next[realIdx].collide!, phase: 'synthesizing' } };
            return next;
          });
        }
        break;
      }

      case 'collide-proposal': {
        const proposer = typeof msg.data?.proposer === 'string' ? msg.data.proposer : 'proposer';
        const text = typeof msg.data?.text === 'string' ? msg.data.text : '';
        const breach = msg.data?.breach === true;
        setTranscriptMessages((prev) => {
          const idx = [...prev].reverse().findIndex((m) => m.collide && m.collide.phase === 'proposing');
          if (idx < 0) return prev;
          const realIdx = prev.length - 1 - idx;
          const next = [...prev];
          const card = next[realIdx].collide!;
          next[realIdx] = {
            ...next[realIdx],
            collide: { ...card, proposals: [...card.proposals, { proposer, text, breach }] },
          };
          return next;
        });
        break;
      }

      case 'error': {
        if (options.statusRef.current !== 'busy' && options.messagesRef.current.length === 0) break;
        const error = orchestratorErrorText(typeof msg.data?.error === 'string' ? msg.data.error : 'Unknown error');
        console.error('[orchestrator-stream] Error:', error);
        options.flushCurrentAssistant();
        options.finalizeFirstTurnPlanCapture();
        options.statusRef.current = 'error';
        options.setStatus('error');
        const failedAssistantId = options.currentAssistantRef.current?.id;
        options.currentAssistantRef.current = null;
        setTranscriptMessages((prev) => [...prev.map(message => message.id === failedAssistantId ? {
          ...message, thinkingActive: false, toolCalls: message.toolCalls?.map(tool =>
            tool.status === 'running' || tool.status === 'calling' ? { ...tool, status: undefined } : tool),
        } : message), {
          id: `orch-error-${Date.now()}`,
          role: 'system',
          text: `Orchestrator error: ${error}`,
          isError: true,
          timestamp: Date.now(),
          timestampLabel: formatTimestampLabel(Date.now()),
        }]);
        break;
      }
    }
  };
}
