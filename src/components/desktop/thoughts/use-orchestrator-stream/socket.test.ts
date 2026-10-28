import { describe, it, expect, vi } from 'vitest';
import { createOrchestratorMessageHandler, type CurrentAssistantStreamState } from './socket';
import type { OrchestratorStreamStatus } from './shared';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';

// These tests pin the first-turn streaming race fixed 2026-06-18:
//   1. The server replies with a `status` SNAPSHOT on every (re)subscribe.
//   2. The first orchestrator turn mints a threadId mid-turn, which forces a
//      re-subscribe whose snapshot can arrive as `ready` right after send()
//      optimistically set `busy`.
//   3. Before the fix, that snapshot clobbered the live `busy`, and the output
//      handler then silently dropped every token — the stream was dead until a
//      reload re-loaded the threadId (no mint → no re-subscribe → no clobber).

function makeHarness(initial: {
  status: OrchestratorStreamStatus;
  messages?: MobileTranscriptEntry[];
  current?: CurrentAssistantStreamState | null;
  lastSeq?: number;
  epoch?: number;
  // Wall-clock of the last real activity. Defaults to now — the realistic state
  // of a client that just sent/received (send() stamps lastEventAt). The RC1
  // seam-3 stale-busy reconcile keys off this; a test simulates a dropped
  // terminal by passing an OLD value.
  lastEventAt?: number;
  /** Thread this view is bound to (thread-scope ingest guard). */
  threadId?: string | null;
  suppressTurnEvents?: boolean;
}) {
  const ws = {} as WebSocket;
  const statusRef = { current: initial.status };
  const currentAssistantRef = { current: initial.current ?? null };
  const messagesRef = { current: initial.messages ?? [] };
  const lastSeqRef = { current: initial.lastSeq ?? 0 };
  const lastBackendRef = { current: null as string | null };
  const resetEpochRef = { current: initial.epoch ?? 0 };
  const lastEventAtRef = { current: initial.lastEventAt ?? Date.now() };
  const setStatus = vi.fn();
  const setMessages = vi.fn();
  const scheduleFlushCurrentAssistant = vi.fn();
  const flushCurrentAssistant = vi.fn();
  const snapshotSeenRef = { current: false };
  const onVoiceTerminal = vi.fn();
  const onSnapshotTurnTerminal = vi.fn();
  const onSettledAssistantMissing = vi.fn();
  const suppressTurnEventsRef = { current: initial.suppressTurnEvents ?? false };

  const handler = createOrchestratorMessageHandler({
    captureFirstTurnPlanRef: { current: false },
    currentWs: ws,
    currentAssistantRef,
    eventCountRef: { current: 0 },
    snapshotSeenRef,
    lastSeqRef,
    finalizeFirstTurnPlanCapture: vi.fn(),
    firstTurnPlanChunksRef: { current: [] as string[] },
    firstTurnPlanStartedRef: { current: false },
    flushCurrentAssistant,
    scheduleFlushCurrentAssistant,
    lastBackendRef,
    lastEventAtRef,
    messagesRef,
    onVoiceTerminal,
    onSnapshotTurnTerminal,
    onSettledAssistantMissing,
    resetEpochRef,
    setMessages,
    setStatus,
    statusRef,
    suppressTurnEventsRef,
    threadIdRef: { current: initial.threadId ?? null },
    wsRef: { current: ws },
  });

  const fire = (payload: Record<string, unknown>) =>
    handler({ data: JSON.stringify(payload) } as MessageEvent);

  return {
    fire,
    statusRef,
    currentAssistantRef,
    messagesRef,
    lastSeqRef,
    lastBackendRef,
    resetEpochRef,
    lastEventAtRef,
    setStatus,
    setMessages,
    scheduleFlushCurrentAssistant,
    flushCurrentAssistant,
    snapshotSeenRef,
    onVoiceTerminal,
    onSnapshotTurnTerminal,
    onSettledAssistantMissing,
    suppressTurnEventsRef,
  };
}

const userMsg: MobileTranscriptEntry = {
  id: 'orch-user-1',
  role: 'user',
  text: 'hi',
  timestamp: 1,
  timestampLabel: '12:00',
};

describe('orchestrator socket — handoff seam', () => {
  it('renders one durable handoff marker and keeps destination attribution', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });
    const handoff = {
      handoffId: 'handoff-live-1',
      from: { backend: 'claude', model: 'source/model' },
      to: { backend: 'codex', model: 'destination/model' },
      lossless: false,
      carries: {
        narrative: 'full',
        intent: 'summary',
        workspace: 'full',
        governance: 'full',
        provenance: 'summary',
      },
    };
    h.fire({ channel: 'orchestrator', event: 'handoff', data: { ...handoff, beforeMessageId: userMsg.id } });
    h.fire({ channel: 'orchestrator', event: 'handoff', data: { ...handoff, beforeMessageId: userMsg.id } });
    h.fire({
      channel: 'orchestrator',
      event: 'output',
      data: { text: 'continued', backend: 'codex', model: 'destination/model' },
    });

    const messages = h.setMessages.mock.calls.reduce<MobileTranscriptEntry[]>(
      (state, [updater]) => (typeof updater === 'function' ? updater(state) : updater),
      [userMsg],
    );
    expect(messages.filter((message) => message.id === 'handoff-live-1')).toHaveLength(1);
    expect(messages.find((message) => message.id === 'handoff-live-1')).toMatchObject({
      type: 'handoff',
      handoff,
    });
    expect(messages.map((message) => message.id).slice(0, 2)).toEqual(['handoff-live-1', userMsg.id]);
    expect(h.currentAssistantRef.current).toMatchObject({ backend: 'codex', model: 'destination/model' });
  });
});

describe('orchestrator socket — first-turn streaming race', () => {
  it('drops late stream events after undo until the interrupted turn settles', () => {
    const h = makeHarness({ status: 'ready', suppressTurnEvents: true });

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'late token' } });
    expect(h.currentAssistantRef.current).toBeNull();
    expect(h.scheduleFlushCurrentAssistant).not.toHaveBeenCalled();
    expect(h.suppressTurnEventsRef.current).toBe(true);

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'ready' } });
    expect(h.suppressTurnEventsRef.current).toBe(false);
  });

  it('a subscribe-ack snapshot "ready" must not clobber an in-flight busy, and the next token still renders', () => {
    // send() just set busy and the user bubble is on screen; then the
    // threadId-mint re-subscribe replies with a stale snapshot:ready.
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'ready', snapshot: true } });
    expect(h.statusRef.current).toBe('busy'); // NOT downgraded

    // First real token of the turn.
    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'hello' } });
    expect(h.currentAssistantRef.current).not.toBeNull();
    expect(h.currentAssistantRef.current?.chunks).toContain('hello'); // captured, not dropped
    expect(h.scheduleFlushCurrentAssistant).toHaveBeenCalled();
  });

  it('output implies busy: a token is never dropped even if status was wrongly left at "ready"', () => {
    const h = makeHarness({ status: 'ready' });

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'tok' } });
    expect(h.statusRef.current).toBe('busy');
    expect(h.setStatus).toHaveBeenCalledWith('busy');
    expect(h.currentAssistantRef.current?.chunks).toContain('tok');
  });

  it('uses the server-persisted assistant id for streamed bubbles', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'tok', assistantMessageId: 'assistant-123' } });
    expect(h.currentAssistantRef.current?.id).toBe('assistant-123');
  });

  it('starts automatic turns at their persisted user boundary without replacing the originating reply', () => {
    const h = makeHarness({ status: 'ready', messages: [userMsg, { id: 'origin', role: 'assistant', text: 'Workers launched.' }], threadId: 'thoughts-parent' });
    const data = { threadId: 'thoughts-parent', userMessageId: 'result-user', assistantMessageId: 'result-answer', message: 'Worker results received.', timestamp: 200 };
    h.fire({ channel: 'orchestrator', event: 'turn-start', data: { ...data, threadId: 'thoughts-other' } });
    expect(h.setMessages).not.toHaveBeenCalled();
    h.fire({ channel: 'orchestrator', event: 'turn-start', data });
    h.fire({ channel: 'orchestrator', event: 'output', data: { ...data, text: 'Result summary.' } });
    h.fire({ channel: 'orchestrator', event: 'turn-start', data });
    expect(h.currentAssistantRef.current).toMatchObject({ id: 'result-answer', chunks: ['Result summary.'] });
    const messages = h.setMessages.mock.calls.reduce<MobileTranscriptEntry[]>((rows, [update]) => typeof update === 'function' ? update(rows) : update,
      [userMsg, { id: 'origin', role: 'assistant', text: 'Workers launched.' }]);
    expect(messages.map(row => row.id)).toEqual(['orch-user-1', 'origin', 'result-user']);
    expect(messages[1].text).toBe('Workers launched.');
  });

  it('a tool-use event also promotes to busy instead of dropping the pill', () => {
    const h = makeHarness({ status: 'ready' });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Bash', backend: 'claude', model: 'claude-opus-5' } });
    expect(h.statusRef.current).toBe('busy');
    expect(h.currentAssistantRef.current).not.toBeNull();
    const messages = h.setMessages.mock.calls.reduce<MobileTranscriptEntry[]>(
      (state, [updater]) => (typeof updater === 'function' ? updater(state) : updater),
      [],
    );
    expect(messages[0]).toMatchObject({ backend: 'claude', model: 'claude-opus-5' });
  });

  it('keeps messagesRef in lockstep with socket transcript mutations', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Bash' } });
    const messages = h.setMessages.mock.calls.reduce<MobileTranscriptEntry[]>(
      (state, [updater]) => (typeof updater === 'function' ? updater(state) : updater),
      [userMsg],
    );

    expect(h.messagesRef.current).toEqual(messages);
    expect(h.messagesRef.current[h.messagesRef.current.length - 1]?.toolCalls?.[0]?.name).toBe('Bash');
  });

  // #2142 — the server retried the turn and threw the previous attempt away.
  // Its narration is already in the live bubble (settle only ever gated the
  // terminal events), so the client must clear it or the retry's reply appends
  // to it and the operator reads two turns glued into one.
  it('a retry boundary clears the discarded attempt out of the live bubble', () => {
    const current: CurrentAssistantStreamState = {
      id: 'assistant-1',
      chunks: ['I dispatched three agents. ', 'Send me a message when you want me to review.'],
      thinkingChunks: ['planning'],
      epoch: 0,
    };
    const assistant: MobileTranscriptEntry = {
      id: 'assistant-1',
      role: 'assistant',
      text: 'I dispatched three agents. Send me a message when you want me to review.',
    };
    const h = makeHarness({ status: 'busy', current, messages: [userMsg, assistant] });

    h.fire({
      channel: 'orchestrator',
      event: 'retry',
      data: { assistantMessageId: 'assistant-1', attempt: 2, reason: 'false-dispatch', notice: 'Discarding it and retrying the turn once.' },
    });

    expect(h.currentAssistantRef.current?.chunks).toEqual([]);
    expect(h.currentAssistantRef.current?.thinkingChunks).toEqual([]);
    const cleared = h.setMessages.mock.calls.reduce<MobileTranscriptEntry[]>(
      (state, [updater]) => (typeof updater === 'function' ? updater(state) : updater),
      [userMsg, assistant],
    );
    expect(cleared.find((m) => m.id === 'assistant-1')?.text).toBe('');

    // The retry's tokens land in a bubble holding ONLY the retry.
    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'Launched lane-a, lane-b, lane-c.', assistantMessageId: 'assistant-1' } });
    expect(h.currentAssistantRef.current?.chunks).toEqual(['Launched lane-a, lane-b, lane-c.']);
    expect(h.currentAssistantRef.current?.chunks.join('')).not.toContain('I dispatched three agents');
  });

  it('a LIVE (non-snapshot) "ready" still finalizes the streamed turn', () => {
    const current: CurrentAssistantStreamState = { id: 'a1', chunks: ['x'], thinkingChunks: [], epoch: 0 };
    const h = makeHarness({ status: 'busy', current });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'ready' } });
    expect(h.flushCurrentAssistant).toHaveBeenCalled();
    expect(h.currentAssistantRef.current).toBeNull();
    expect(h.statusRef.current).toBe('ready');
  });

  it('attaches terminal cache truth to the completed assistant entry', () => {
    const assistant: MobileTranscriptEntry = { id: 'a-cache', role: 'assistant', text: 'done' };
    const current: CurrentAssistantStreamState = { id: 'a-cache', chunks: ['done'], thinkingChunks: [], epoch: 0 };
    const h = makeHarness({ status: 'busy', current, messages: [userMsg, assistant] });

    h.fire({
      channel: 'orchestrator',
      event: 'status',
      data: {
        status: 'ready',
        usage: {
          inputTokens: 203,
          outputTokens: 11,
          cacheReadTokens: 40_448,
          cacheWriteTokens: 0,
        },
      },
    });

    const messages = h.setMessages.mock.calls.reduce<MobileTranscriptEntry[]>(
      (state, [updater]) => (typeof updater === 'function' ? updater(state) : updater),
      [userMsg, assistant],
    );
    expect(messages.find((message) => message.id === 'a-cache')).toMatchObject({
      tokens: { input: 203, output: 11, cacheRead: 40_448, cacheWrite: 0 },
    });
  });

  it('attaches the terminal turn receipt to the completed assistant entry', () => {
    const assistant: MobileTranscriptEntry = { id: 'a-receipt', role: 'assistant', text: 'done' };
    const current: CurrentAssistantStreamState = { id: 'a-receipt', chunks: ['done'], thinkingChunks: [], epoch: 0 };
    const h = makeHarness({ status: 'busy', current, messages: [userMsg, assistant] });

    h.fire({
      channel: 'orchestrator',
      event: 'status',
      data: {
        status: 'ready',
        receipt: {
          leadModel: 'gpt-5.6-sol',
          effort: 'high',
          mode: 'fusion',
          pickedMode: 'solo',
        },
      },
    });

    const messages = h.setMessages.mock.calls.reduce<MobileTranscriptEntry[]>(
      (state, [updater]) => (typeof updater === 'function' ? updater(state) : updater),
      [userMsg, assistant],
    );
    expect(messages.find((message) => message.id === 'a-receipt')).toMatchObject({
      receipt: {
        leadModel: 'gpt-5.6-sol',
        effort: 'high',
        mode: 'fusion',
        pickedMode: 'solo',
      },
    });
  });

  it('a snapshot "busy" resyncs an idle client up to busy (reload into an active turn)', () => {
    const h = makeHarness({ status: 'connecting' });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'busy', snapshot: true } });
    expect(h.statusRef.current).toBe('busy');
    expect(h.setStatus).toHaveBeenCalledWith('busy');
  });

  it('a snapshot "ready" settles an idle client (composer stays enabled)', () => {
    const h = makeHarness({ status: 'connecting' });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'ready', snapshot: true } });
    expect(h.statusRef.current).toBe('ready');
  });

  it('a snapshot "dead" must not clobber a live busy either', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'dead', snapshot: true } });
    expect(h.statusRef.current).toBe('busy');
  });
});

describe('orchestrator socket — RC1 seam 1: epoch bump must not drop answer tokens', () => {
  it('a mid-stream reset() (epoch bump) keeps rendering the durable turn instead of dropping it', () => {
    // Turn is live; the assistant entry is stamped to epoch 0.
    const h = makeHarness({ status: 'busy', messages: [userMsg], epoch: 0 });
    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'thinking done, answer: ' } });
    expect(h.currentAssistantRef.current?.chunks).toContain('thinking done, answer: ');

    // A same-thread load / clear bumps the reset epoch mid-turn (D7HY6S). The
    // server turn is durable and keeps streaming answer tokens on this socket.
    h.resetEpochRef.current += 1;

    // Pre-fix: this token hit the epoch guard, nulled the assistant and `break`ed
    // — the rest of the answer was silently lost ("thinking shown, no answer").
    h.fire({ channel: 'orchestrator', event: 'output', data: { text: '42' } });
    expect(h.currentAssistantRef.current).not.toBeNull();
    expect(h.currentAssistantRef.current?.chunks).toContain('42'); // NOT dropped
    expect(h.currentAssistantRef.current?.epoch).toBe(1); // re-stamped to the live epoch
    expect(h.statusRef.current).toBe('busy');
  });
});

describe('orchestrator socket — RC1 seam 3: stale-busy reconcile (latched composer heal)', () => {
  it('a snapshot ready clears a STALE local busy (dropped terminal) so the next send is not swallowed', () => {
    // Terminal 'ready' never reached the client; local busy has been silent well
    // past the reconcile window. The composer guard reads orchStream.status ===
    // 'busy' (J4FHM2 "second turns don't fire"); clearing it unlatches the send.
    const h = makeHarness({ status: 'busy', messages: [userMsg], lastEventAt: Date.now() - 60_000 });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'ready', snapshot: true } });
    expect(h.statusRef.current).toBe('ready'); // composer unlatched
  });

  it('a snapshot ready does NOT clear a FRESH busy — the first-turn re-subscribe race guard still holds', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg], lastEventAt: Date.now() });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'ready', snapshot: true } });
    expect(h.statusRef.current).toBe('busy'); // preserved — turn is legitimately live
  });

  it('a snapshot busy still resyncs an idle client UP to busy (reattach reflects the working turn)', () => {
    const h = makeHarness({ status: 'connecting' });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'busy', snapshot: true } });
    expect(h.statusRef.current).toBe('busy');
  });
});

describe('orchestrator socket — server turn-truth reconcile', () => {
  it('keeps a FRESH local busy when the snapshot has no turn — the mint re-subscribe races the send handler', () => {
    // First-turn threadId mint forces a re-subscribe that can be served
    // before the send handler creates the turn record. turn:null there must
    // not kill the turn the client just sent (the old first-turn-streaming
    // regression). lastEventAt defaults to now — a fresh send.
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({
      channel: 'orchestrator',
      event: 'status',
      data: { status: 'busy', snapshot: true, turn: null },
    });

    expect(h.statusRef.current).toBe('busy');
    expect(h.onSnapshotTurnTerminal).not.toHaveBeenCalled();
  });

  it('clears a QUIET local busy when the snapshot says the thread has no turn', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg], lastEventAt: Date.now() - 10_000 });

    h.fire({
      channel: 'orchestrator',
      event: 'status',
      data: { status: 'busy', snapshot: true, turn: null },
    });

    expect(h.snapshotSeenRef.current).toBe(true);
    expect(h.statusRef.current).toBe('ready');
    expect(h.setStatus).toHaveBeenCalledWith('ready');
    expect(h.onSnapshotTurnTerminal).toHaveBeenCalledWith(null, true);
  });

  it('clears running state and requests history when a settled failed answer is missing', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg], lastEventAt: Date.now() - 10_000 });
    const turn = {
      id: 'turn-1',
      startedAt: 100,
      settledAt: 200,
      outcome: 'failed',
      assistantMessageId: 'assistant-1',
    };

    h.fire({
      channel: 'orchestrator',
      event: 'status',
      data: { status: 'ready', snapshot: true, turn },
    });

    expect(h.statusRef.current).toBe('ready');
    expect(h.onSnapshotTurnTerminal).toHaveBeenCalledWith(turn, true);
    expect(h.onSettledAssistantMissing).toHaveBeenCalledWith(turn);
  });

  it('does not refetch when the settled assistant is already visible', () => {
    const assistant = { ...userMsg, id: 'assistant-1', role: 'assistant' as const, text: 'Done.' };
    const h = makeHarness({ status: 'ready', messages: [userMsg, assistant] });

    h.fire({
      channel: 'orchestrator',
      event: 'status',
      data: {
        status: 'ready',
        snapshot: true,
        turn: {
          id: 'turn-1',
          startedAt: 100,
          settledAt: 200,
          outcome: 'completed',
          assistantMessageId: 'assistant-1',
        },
      },
    });

    expect(h.onSettledAssistantMissing).not.toHaveBeenCalled();
  });

  it('treats an unsettled ledger turn as running even when the legacy status says ready', () => {
    const h = makeHarness({ status: 'connecting', messages: [userMsg] });

    h.fire({
      channel: 'orchestrator',
      event: 'status',
      data: {
        status: 'ready',
        snapshot: true,
        turn: {
          id: 'turn-1',
          startedAt: 100,
          settledAt: null,
          outcome: null,
          assistantMessageId: 'assistant-1',
        },
      },
    });

    expect(h.statusRef.current).toBe('busy');
    expect(h.setStatus).toHaveBeenCalledWith('busy');
  });
});

describe('orchestrator socket — replay seq cursor', () => {
  it('renders a persistent lead terminal reply before accepting its compatible ready status', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg], threadId: 'thoughts-lead-1' });

    h.fire({
      channel: 'orchestrator',
      event: 'output',
      data: {
        text: 'The reviewed worker result is ready.',
        threadId: 'thoughts-lead-1',
        backend: 'codex',
        assistantMessageId: 'lead-assistant-review-1',
      },
    });
    h.fire({
      channel: 'orchestrator',
      event: 'status',
      data: { status: 'ready', leadStatus: 'needs_approval', threadId: 'thoughts-lead-1' },
    });

    expect(h.statusRef.current).toBe('ready');
    expect(h.currentAssistantRef.current).toBeNull();
    expect(h.flushCurrentAssistant).toHaveBeenCalled();
  });

  it('advances the cursor on a seq-stamped event and renders it', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'a' }, seq: 5 });
    expect(h.lastSeqRef.current).toBe(5);
    expect(h.currentAssistantRef.current?.chunks).toContain('a');
  });

  it('drops a replayed event at or below the cursor (no double-apply), still takes the next', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg], lastSeq: 5 });

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'dup' }, seq: 5 });
    expect(h.currentAssistantRef.current).toBeNull(); // dropped — nothing rendered

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'next' }, seq: 6 });
    expect(h.currentAssistantRef.current?.chunks).toContain('next');
    expect(h.lastSeqRef.current).toBe(6);
  });

  it('a snapshot (no seq) is never de-duped and does not move the cursor', () => {
    const h = makeHarness({ status: 'connecting', lastSeq: 9 });

    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'busy', snapshot: true } });
    expect(h.statusRef.current).toBe('busy');
    expect(h.lastSeqRef.current).toBe(9); // unchanged
  });
});

describe('orchestrator socket — cortex_ask tool-result (Brain→Fable transparency card)', () => {
  const askOutput = JSON.stringify({
    ok: true,
    answer: 'The middleware is default-deny.',
    citations: [
      { kind: 'directive', rowId: 'd-12', table: 'directives', title: 'API security gate' },
    ],
    class: 'A',
    retrievalMs: 320,
    classifyMs: 41,
    sourcesConsidered: 18,
    consideredChars: 21400,
    cacheHit: null,
  });

  /** Apply every setMessages updater in call order — the real state the
   *  transcript would hold after the fired events. */
  function reduceMessages(h: ReturnType<typeof makeHarness>, initial: MobileTranscriptEntry[] = []) {
    return h.setMessages.mock.calls.reduce<MobileTranscriptEntry[]>(
      (state, [updater]) => (typeof updater === 'function' ? updater(state) : updater),
      initial,
    );
  }

  it('parses the result onto the originating tool call: status done, backend + brainFeed stamped', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({
      channel: 'orchestrator',
      event: 'tool-use',
      data: { name: 'mcp__o8__cortex_ask', args: { question: 'How is the API gated?' }, toolUseId: 'tu-1', backend: 'fable' },
    });
    h.fire({
      channel: 'orchestrator',
      event: 'tool-result',
      data: { name: 'mcp__o8__cortex_ask', toolUseId: 'tu-1', output: askOutput, backend: 'fable' },
    });

    const messages = reduceMessages(h);
    const tool = messages[messages.length - 1]?.toolCalls?.[0];
    expect(tool?.status).toBe('done');
    expect(tool?.result).toBe(askOutput);
    expect(tool?.backend).toBe('fable');
    expect(tool?.brainFeed?.question).toBe('How is the API gated?');
    expect(tool?.brainFeed?.citations).toEqual([
      { kind: 'directive', rowId: 'd-12', title: 'API security gate', excerpt: undefined, url: null },
    ]);
    expect(tool?.brainFeed?.sourcesConsidered).toBe(18);
    expect(tool?.brainFeed?.consideredChars).toBe(21400);
  });

  it('falls back to the latest cortex_ask call when the result carries no toolUseId', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Bash', args: { command: 'ls' } } });
    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'cortex_ask', args: { question: 'q2' } } });
    h.fire({ channel: 'orchestrator', event: 'tool-result', data: { name: 'cortex_ask', output: askOutput, backend: 'fable' } });

    const messages = reduceMessages(h);
    const tools = messages[messages.length - 1]?.toolCalls ?? [];
    expect(tools[0]?.brainFeed).toBeUndefined(); // the Bash call stays untouched
    expect(tools[1]?.brainFeed?.question).toBe('q2');
    expect(tools[1]?.backend).toBe('fable');
  });

  it('retains non-cortex results for the expanded activity details', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Bash', args: { command: 'ls' }, toolUseId: 'tu-9' } });
    const callsAfterUse = h.setMessages.mock.calls.length;
    h.fire({ channel: 'orchestrator', event: 'tool-result', data: { name: 'Bash', toolUseId: 'tu-9', output: 'file-a\nfile-b', backend: 'fable' } });
    expect(h.setMessages.mock.calls.length).toBe(callsAfterUse + 1);
    expect(reduceMessages(h).at(-1)?.toolCalls?.[0]).toMatchObject({ status: 'done', result: 'file-a\nfile-b' });
  });

  it('an unparseable cortex_ask result still lands result/backend/done — just no brainFeed (card stays a plain chip)', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'cortex_ask', args: { question: 'q' }, toolUseId: 'tu-2' } });
    h.fire({ channel: 'orchestrator', event: 'tool-result', data: { name: 'cortex_ask', toolUseId: 'tu-2', output: 'not json at all', backend: 'fable' } });

    const messages = reduceMessages(h);
    const tool = messages[messages.length - 1]?.toolCalls?.[0];
    expect(tool?.status).toBe('done');
    expect(tool?.result).toBe('not json at all');
    expect(tool?.backend).toBe('fable');
    expect(tool?.brainFeed).toBeUndefined();
  });
});

describe('orchestrator socket — tool error status (turn grammar)', () => {
  function reduceMessages(h: ReturnType<typeof makeHarness>, initial: MobileTranscriptEntry[] = []) {
    return h.setMessages.mock.calls.reduce<MobileTranscriptEntry[]>(
      (state, [updater]) => (typeof updater === 'function' ? updater(state) : updater),
      initial,
    );
  }

  it('flips an errored tool call to status "error" and stashes the output', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Bash', args: { command: 'npm run build' }, toolUseId: 'tu-1' } });
    h.fire({ channel: 'orchestrator', event: 'tool-result', data: { name: 'Bash', toolUseId: 'tu-1', output: 'exit 1: boom', isError: true } });

    const messages = reduceMessages(h);
    const tool = messages[messages.length - 1]?.toolCalls?.[0];
    expect(tool?.status).toBe('error');
    expect(tool?.result).toBe('exit 1: boom');
  });

  it('settles a successful non-cortex result on its own receipt', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Bash', args: { command: 'ls' }, toolUseId: 'tu-2' } });
    const callsAfterUse = h.setMessages.mock.calls.length;
    h.fire({ channel: 'orchestrator', event: 'tool-result', data: { name: 'Bash', toolUseId: 'tu-2', output: 'ok' } });
    expect(h.setMessages.mock.calls.length).toBe(callsAfterUse + 1);
    expect(reduceMessages(h).at(-1)?.toolCalls?.[0]).toMatchObject({ status: 'done', result: 'ok' });
  });

  it('an errored call falls back to the latest in-flight chip when no toolUseId matches', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'tool-use', data: { name: 'Edit', args: { file_path: 'a.ts' } } });
    h.fire({ channel: 'orchestrator', event: 'tool-result', data: { name: 'Edit', output: 'patch did not apply', isError: true } });

    const messages = reduceMessages(h);
    const tool = messages[messages.length - 1]?.toolCalls?.[0];
    expect(tool?.status).toBe('error');
    expect(tool?.result).toBe('patch did not apply');
  });
});

describe('orchestrator socket — backend tracking (Fable Slice 4)', () => {
  it('resets the replay cursor when a thread switches backend, then applies the new stream', () => {
    const h = makeHarness({ status: 'connecting', lastSeq: 5 });

    // Subscribe-ack snapshot (no seq) — the FIRST thing a fresh client sees.
    h.fire({ channel: 'orchestrator', event: 'status', data: { status: 'ready', snapshot: true, backend: 'fable' } });
    expect(h.lastBackendRef.current).toBe('fable');

    // Codex has its own per-session sequence, so seq=1 is new even though the
    // previous Fable session had already reached seq=5.
    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'codex reply', backend: 'codex' }, seq: 1 });
    expect(h.lastBackendRef.current).toBe('codex');
    expect(h.lastSeqRef.current).toBe(1);
    expect(h.currentAssistantRef.current?.chunks).toContain('codex reply');
  });

  it('leaves lastBackendRef untouched for events without a backend field or off-channel', () => {
    const h = makeHarness({ status: 'busy', messages: [userMsg] });

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'hello' } });
    expect(h.lastBackendRef.current).toBeNull();

    h.fire({ channel: 'supervisor', event: 'agent-update', data: { surfaceId: 's1', backend: 'fable' } });
    expect(h.lastBackendRef.current).toBeNull();
  });
});

describe('orchestrator socket — thread-scope ingest guard (drag-to-split)', () => {
  it('a view bound to thread X drops events stamped with thread Y', () => {
    const h = makeHarness({ status: 'ready', threadId: 'thoughts-mine' });

    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'leak', threadId: 'thoughts-other' } });
    expect(h.currentAssistantRef.current).toBeNull();
    expect(h.setStatus).not.toHaveBeenCalled();

    // Its OWN thread's tokens still stream.
    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'mine', threadId: 'thoughts-mine' } });
    expect(h.currentAssistantRef.current?.chunks).toContain('mine');
  });

  it('an UNBOUND view drops events for a pane-owned thread but still reattaches to unowned turns', async () => {
    const { registerPaneThread, unregisterPaneThread } = await import('@/lib/orchestrator/pane-thread-registry');
    registerPaneThread('thoughts-pane');
    try {
      const h = makeHarness({ status: 'ready', threadId: null });

      // Pane-owned turn: must NOT hijack the empty view.
      h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'pane-turn', threadId: 'thoughts-pane' } });
      expect(h.currentAssistantRef.current).toBeNull();

      // Unowned in-flight turn: durable-turn recovery still applies.
      h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'recovered', threadId: 'thoughts-unowned' } });
      expect(h.currentAssistantRef.current?.chunks).toContain('recovered');
    } finally {
      unregisterPaneThread('thoughts-pane');
    }
  });

  it('events without a threadId are unaffected by the guard', () => {
    const h = makeHarness({ status: 'ready', threadId: 'thoughts-mine' });
    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'legacy' } });
    expect(h.currentAssistantRef.current?.chunks).toContain('legacy');
  });
});

describe('orchestrator socket — stall clock scoping (six-hour-timer incident)', () => {
  it("an UNSTAMPED event paints on a bound view but does NOT reset its stall clock", () => {
    const h = makeHarness({ status: 'busy', threadId: 'thoughts-mine', lastEventAt: 12345 });

    // Session-wide broadcast with no threadId (e.g. supervisor auto-queue):
    // still renders, but if it fed the clock a wedged turn's #539 stall
    // watchdog could be starved forever.
    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'broadcast' } });
    expect(h.currentAssistantRef.current?.chunks).toContain('broadcast');
    expect(h.lastEventAtRef.current).toBe(12345);
  });

  it("the view's OWN turn events still reset the stall clock", () => {
    const h = makeHarness({ status: 'busy', threadId: 'thoughts-mine', lastEventAt: 12345 });
    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'mine', threadId: 'thoughts-mine' } });
    expect(h.lastEventAtRef.current).toBeGreaterThan(12345);
  });

  it('an unbound view keeps stamping the clock from any passing event', () => {
    const h = makeHarness({ status: 'busy', threadId: null, lastEventAt: 12345 });
    h.fire({ channel: 'orchestrator', event: 'output', data: { text: 'recovered', threadId: 'thoughts-unowned' } });
    expect(h.lastEventAtRef.current).toBeGreaterThan(12345);
  });
});

 describe('managed voice terminal receipts', () => {
  it('does not turn legacy ready, snapshots, or partial text into confirmed completion', () => {
    const h = makeHarness({ status: 'busy', threadId: 'thoughts-a' });
    h.fire({ channel: 'orchestrator', event: 'output', data: { threadId: 'thoughts-a', text: 'partial' } });
    h.fire({ channel: 'orchestrator', event: 'status', data: { threadId: 'thoughts-a', status: 'ready' } });
    expect(h.onVoiceTerminal).not.toHaveBeenCalled();
  });
  it('accepts a correlated interruption after optimistic Stop but rejects another thread', () => {
    const h = makeHarness({ status: 'ready', threadId: 'thoughts-a', suppressTurnEvents: true });
    const voiceTerminal = { userMessageId: 'orch-user-request', outcome: 'interrupted', text: 'partial' };
    h.fire({ channel: 'orchestrator', event: 'status', data: { threadId: 'thoughts-b', status: 'ready', voiceTerminal } });
    expect(h.onVoiceTerminal).not.toHaveBeenCalled();
    h.fire({ channel: 'orchestrator', event: 'status', data: { threadId: 'thoughts-a', status: 'ready', voiceTerminal } });
    expect(h.onVoiceTerminal).toHaveBeenCalledWith(voiceTerminal);
  });
});
