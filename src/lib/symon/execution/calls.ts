import {
  deriveOk,
  SYMON_REPLAY_TTL_MS,
  toolErrorResult,
  toolTimeoutResult,
  type SymonPendingConfirmation,
  type SymonToolRelayResult,
  type ToolResult,
} from '@/lib/mobile/symon-tool-relay';
import { createPhoneConfirmation, type PhoneToolReview } from './confirm';
import { toolSafetyClass, toolTimeoutMs } from './policy';

export const PHONE_CALL_TOMBSTONE_LIMIT = 1_000;
export const PHONE_CALL_ABORT_SETTLE_MS = 1_000;
export type PhoneToolHandler = (
  tool: string,
  args: Readonly<Record<string, unknown>>,
  context: { signal: AbortSignal },
) => Promise<unknown>;
export interface PhoneToolCall {
  sessionId: string;
  callId: string;
  tool: string;
  /** The caller must authenticate and scope these arguments before start. */
  args: Record<string, unknown>;
  review?: PhoneToolReview;
}
export interface PhoneToolDecision {
  sessionId: string;
  callId: string;
  confirmationId: string;
  allow: boolean;
}

function immutableCopy<T>(value: T): T {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const value of Object.values(node)) freeze(value);
    Object.freeze(node);
  };
  freeze(copy);
  return copy;
}

interface CallState {
  tool: string;
  args: Readonly<Record<string, unknown>>;
  controller: AbortController;
  confirmation?: SymonPendingConfirmation;
  decided: boolean;
  started: boolean;
  terminal?: ToolResult;
  stopping?: ToolResult;
  timer?: ReturnType<typeof setTimeout>;
  done: Promise<ToolResult>;
  resolve: (result: ToolResult) => void;
}

/**
 * Process-local owner, deliberately unwired. Restart reconciliation attaches here
 * when durable call receipts are introduced; a restart currently loses all state.
 * Completed calls and early interrupts each retain at most 1,000 entries for five
 * minutes, lazily pruned on access. Replay protection ends at eviction or restart.
 */
export function createPhoneToolCallRegistry(
  handler: PhoneToolHandler = async () => ({ error: 'desktop_unavailable' }),
) {
  const active = new Map<string, CallState>();
  const completed = new Map<string, { call: CallState; at: number }>();
  const earlyInterrupts = new Map<string, number>();
  const keyFor = (sessionId: string, callId: string) => JSON.stringify([sessionId, callId]);

  function prune(): void {
    for (const [key, entry] of completed) {
      if (Date.now() - entry.at >= SYMON_REPLAY_TTL_MS) completed.delete(key);
    }
    for (const [key, at] of earlyInterrupts) {
      if (Date.now() - at >= SYMON_REPLAY_TTL_MS) earlyInterrupts.delete(key);
    }
    for (const map of [completed, earlyInterrupts]) {
      while (map.size > PHONE_CALL_TOMBSTONE_LIMIT) map.delete(map.keys().next().value!);
    }
  }

  function finish(key: string, call: CallState, result: ToolResult): void {
    if (call.terminal) return;
    clearTimeout(call.timer);
    try { result = immutableCopy(result); } catch { result = toolErrorResult('tool_failed'); }
    call.terminal = result;
    active.delete(key);
    // Release execution inputs and replace the original execution promise.
    completed.set(key, { call: {
      ...call, args: {}, timer: undefined, controller: new AbortController(),
      done: Promise.resolve(result), resolve: () => {},
    }, at: Date.now() });
    prune();
    call.resolve(result);
  }

  function stop(key: string, call: CallState, result: ToolResult): void {
    if (call.terminal || call.stopping) return;
    call.stopping = result;
    clearTimeout(call.timer);
    if (!call.started) {
      call.controller.abort();
      finish(key, call, result);
      return;
    }
    call.timer = setTimeout(() => finish(key, call, toolErrorResult(
      'interrupt_delivery_failed',
      'Cancellation was requested but the handler did not settle; the action outcome is unknown.',
    )), PHONE_CALL_ABORT_SETTLE_MS);
    call.controller.abort();
  }

  function execute(key: string, call: CallState): void {
    clearTimeout(call.timer);
    call.timer = setTimeout(() => stop(key, call, toolTimeoutResult()), toolTimeoutMs(call.tool));
    void Promise.resolve().then(async () => {
      if (call.terminal || call.stopping) return;
      call.started = true;
      try {
        const raw = await handler(call.tool, call.args, { signal: call.controller.signal });
        finish(key, call, call.stopping ?? immutableCopy({ ok: deriveOk(raw), result: raw ?? null }));
      } catch {
        finish(key, call, call.stopping ?? toolErrorResult('tool_failed'));
      }
    });
  }

  function expire(key: string, call: CallState): void {
    call.decided = true;
    finish(key, call, toolErrorResult('confirmation_declined'));
  }

  return {
    /** Pending gates return immediately; executing starts/attaches await the terminal result. */
    async start(input: PhoneToolCall): Promise<SymonToolRelayResult> {
      try {
        if (!input.sessionId || !input.callId || !input.tool) return toolErrorResult('bad_request');
        prune();
        const key = keyFor(input.sessionId, input.callId);
        let call = active.get(key) ?? completed.get(key)?.call;
        if (call && call.tool !== input.tool) return toolErrorResult('call_mismatch');
        if (!call) {
          const args = immutableCopy(input.args);
          if (!args || Array.isArray(args) || typeof args !== 'object') return toolErrorResult('bad_request');
          let resolve!: CallState['resolve'];
          const done = new Promise<ToolResult>((settle) => { resolve = settle; });
          call = { tool: input.tool, args, controller: new AbortController(), decided: false, started: false, done, resolve };
          active.set(key, call);
          if (earlyInterrupts.delete(key)) {
            stop(key, call, toolErrorResult('session_preempted'));
          } else if (toolSafetyClass(input.tool) === 'read-only') {
            execute(key, call);
          } else {
            try {
              const confirmation = createPhoneConfirmation({ ...input, args }, input.review);
              if (!confirmation) throw new Error('invalid review');
              call.confirmation = immutableCopy(confirmation);
              const pending = call;
              call.timer = setTimeout(() => expire(key, pending), confirmation.expiresAt - Date.now());
            } catch {
              finish(key, call, toolErrorResult('confirmation_mismatch'));
            }
          }
        }
        if (call.terminal) return call.terminal;
        if (call.confirmation && !call.decided) {
          if (Date.now() >= call.confirmation.expiresAt) {
            expire(key, call);
            return call.done;
          }
          return { ...toolErrorResult('needs_confirmation', 'Approval is required before this action can run.'), confirmation: call.confirmation };
        }
        return call.done;
      } catch {
        return toolErrorResult('bad_request');
      }
    },

    /** Strict first-decision claim. No arguments or consent can be changed here. */
    decide(input: PhoneToolDecision): ToolResult {
      if (!input || !input.sessionId || !input.callId || !input.confirmationId
        || typeof input.allow !== 'boolean') return toolErrorResult('bad_request');
      prune();
      const key = keyFor(input.sessionId, input.callId);
      const call = active.get(key) ?? completed.get(key)?.call;
      if (!call?.confirmation || call.confirmation.confirmationId !== input.confirmationId) {
        return toolErrorResult('confirmation_mismatch');
      }
      if (call.decided || call.terminal || call.stopping) return toolErrorResult('already_resolved');
      if (Date.now() >= call.confirmation.expiresAt) {
        expire(key, call);
        return toolErrorResult('confirmation_declined');
      }
      call.decided = true;
      if (input.allow) execute(key, call);
      else finish(key, call, toolErrorResult('confirmation_declined'));
      return { ok: true, result: { status: 'resolved', allow: input.allow } };
    },

    /** Await one terminal result, including while a gate is pending. */
    async wait(sessionId: string, callId: string): Promise<ToolResult> {
      prune();
      const key = keyFor(sessionId, callId);
      return (active.get(key) ?? completed.get(key)?.call)?.done ?? toolErrorResult('not_found');
    },

    async interrupt(sessionId: string, callId: string): Promise<ToolResult> {
      if (!sessionId || !callId) return toolErrorResult('bad_request');
      prune();
      const key = keyFor(sessionId, callId);
      const call = active.get(key);
      if (call) {
        stop(key, call, toolErrorResult('session_preempted'));
        const terminal = await call.done;
        if (!terminal.ok && (terminal.result as { error?: string })?.error === 'interrupt_delivery_failed') return terminal;
      } else if (!completed.has(key)) {
        earlyInterrupts.set(key, Date.now());
        prune();
      }
      return { ok: true, result: { delivered: true, wasActive: Boolean(call) } };
    },

    pendingForSession(sessionId: string): SymonPendingConfirmation[] {
      prune();
      return [...active.values()].flatMap(call => call.confirmation && !call.decided
        && !call.terminal && call.confirmation.sessionId === sessionId
        && call.confirmation.expiresAt > Date.now() ? [call.confirmation] : []);
    },
  };
}

export const phoneToolCalls = createPhoneToolCallRegistry();
