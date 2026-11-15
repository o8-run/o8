import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPhoneToolCallRegistry,
  PHONE_CALL_ABORT_SETTLE_MS,
  PHONE_CALL_TOMBSTONE_LIMIT,
  type PhoneToolHandler,
} from '@/lib/symon/execution/calls';
import { PHONE_CONFIRM_TIMEOUT_MS } from '@/lib/symon/execution/confirm';
import { toolTimeoutMs } from '@/lib/symon/execution/policy';
import { parseSymonPendingConfirmation, SYMON_REPLAY_TTL_MS, type SymonToolRelayResult } from '@/lib/mobile/symon-tool-relay';

const input = (tool = 'o8_dispatch', callId = 'call') => ({ sessionId: 'session', callId, tool, args: { repoPath: '/repo', nested: { value: 1 } } });
const failure = (error: string) => ({ ok: false, result: { error } });
function decision(result: SymonToolRelayResult, allow = true) {
  expect(result.confirmation).toBeDefined();
  const { sessionId, callId, confirmationId } = result.confirmation!;
  return { sessionId, callId, confirmationId, allow };
}
function abortingHandler() {
  return vi.fn<PhoneToolHandler>((_tool, _args, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
}

describe('phone tool call owner (hermetic)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('executes read-only immediately, derives tool failures, and never rejects handler exceptions', async () => {
    const handler = vi.fn<PhoneToolHandler>().mockResolvedValueOnce({ value: 1 })
      .mockResolvedValueOnce({ error: 'specific_error' }).mockRejectedValueOnce(new Error('private detail'));
    const registry = createPhoneToolCallRegistry(handler);
    expect(await registry.start(input('o8_status', 'a'))).toEqual({ ok: true, result: { value: 1 } });
    expect(await registry.start(input('o8_status', 'b'))).toEqual(failure('specific_error'));
    expect(await registry.start(input('o8_status', 'c'))).toEqual(failure('tool_failed'));
    expect(registry.pendingForSession('session')).toEqual([]);
  });

  it.each(['o8_dispatch', 'unknown_tool', '__proto__'])('requires one correlated approval for %s', async tool => {
    const handler = vi.fn<PhoneToolHandler>().mockResolvedValue({ done: true });
    const registry = createPhoneToolCallRegistry(handler);
    const call = input(tool);
    const pending = await registry.start(call);
    expect(pending.result).toMatchObject({ error: 'needs_confirmation' });
    expect(parseSymonPendingConfirmation(pending.confirmation, call)).toEqual(pending.confirmation);
    expect(pending.confirmation!.expiresAt).toBe(Date.now() + PHONE_CONFIRM_TIMEOUT_MS);
    expect(handler).not.toHaveBeenCalled();
    const terminal = registry.wait(call.sessionId, call.callId);
    expect(registry.decide(decision(pending))).toEqual({ ok: true, result: { status: 'resolved', allow: true } });
    expect(await terminal).toEqual({ ok: true, result: { done: true } });
    expect(await registry.start(call)).toEqual(await terminal);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each(['deny', 'expire'])('fails closed on %s and replays exactly one terminal result', async action => {
    const handler = vi.fn<PhoneToolHandler>();
    const registry = createPhoneToolCallRegistry(handler);
    const call = input();
    const pending = await registry.start(call);
    const waiting = registry.wait('session', 'call');
    if (action === 'deny') registry.decide(decision(pending, false));
    else await vi.advanceTimersByTimeAsync(PHONE_CONFIRM_TIMEOUT_MS);
    expect(await waiting).toEqual(failure('confirmation_declined'));
    expect(registry.decide(decision(pending))).toEqual(failure('already_resolved'));
    expect(await registry.start(call)).toEqual(await waiting);
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects a late approval even before the expiry timer has fired', async () => {
    const handler = vi.fn<PhoneToolHandler>();
    const registry = createPhoneToolCallRegistry(handler);
    const pending = await registry.start(input());
    vi.setSystemTime(Date.now() + PHONE_CONFIRM_TIMEOUT_MS);
    expect(registry.decide(decision(pending))).toEqual(failure('confirmation_declined'));
    expect(await registry.wait('session', 'call')).toEqual(failure('confirmation_declined'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('attaches while pending, binds immutable arguments, and rejects another tool before and after completion', async () => {
    const handler = vi.fn<PhoneToolHandler>().mockImplementation(async (_tool, args) => {
      expect(Object.isFrozen(args)).toBe(true);
      expect(Object.isFrozen(args.nested)).toBe(true);
      return args;
    });
    const registry = createPhoneToolCallRegistry(handler);
    const call = input();
    const pending = await registry.start(call);
    call.args.nested.value = 2;
    expect(await registry.start(call)).toEqual(pending);
    expect(await registry.start(input('o8_status'))).toEqual(failure('call_mismatch'));
    registry.decide(decision(pending));
    const result = await registry.start(call);
    expect(result.result).toMatchObject({ nested: { value: 1 } });
    expect(Object.isFrozen(result.result)).toBe(true);
    expect(await registry.start(input('o8_status'))).toEqual(failure('call_mismatch'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('isolates sessions and calls and rejects mismatched decisions without effect', async () => {
    const handler = vi.fn<PhoneToolHandler>().mockResolvedValue('done');
    const registry = createPhoneToolCallRegistry(handler);
    const pending = await registry.start(input());
    const valid = decision(pending);
    for (const patch of [{ sessionId: 'other' }, { callId: 'other' }, { confirmationId: 'other' }]) {
      expect(registry.decide({ ...valid, ...patch })).toEqual(failure('confirmation_mismatch'));
    }
    expect(registry.pendingForSession('other')).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
    registry.decide({ ...valid, allow: false });
    expect(await registry.wait('session', 'call')).toEqual(failure('confirmation_declined'));
    expect(await registry.start({ ...input('o8_status'), sessionId: 'other' })).toEqual({ ok: true, result: 'done' });
  });

  it.each([true, false])('first decision wins racing opposite decisions (allow=%s)', async allow => {
    const handler = vi.fn<PhoneToolHandler>().mockResolvedValue('done');
    const registry = createPhoneToolCallRegistry(handler);
    const pending = await registry.start(input());
    const results = await Promise.all([
      Promise.resolve().then(() => registry.decide(decision(pending, allow))),
      Promise.resolve().then(() => registry.decide(decision(pending, !allow))),
      Promise.resolve().then(() => registry.decide(decision(pending, allow))),
    ]);
    expect(results.map(result => result.ok)).toEqual([true, false, false]);
    expect(await registry.wait('session', 'call')).toEqual(allow ? { ok: true, result: 'done' } : failure('confirmation_declined'));
    expect(handler).toHaveBeenCalledTimes(allow ? 1 : 0);
  });

  it.each(['o8_status', 'symon_execute_plan'])('uses the policy budget for %s and honours abort', async tool => {
    const handler = abortingHandler();
    const registry = createPhoneToolCallRegistry(handler);
    const call = input(tool);
    const first = registry.start(call);
    if (tool !== 'o8_status') registry.decide(decision(await first));
    const terminal = registry.wait('session', 'call');
    await vi.advanceTimersByTimeAsync(toolTimeoutMs(tool) - 1);
    expect(handler.mock.calls[0][2].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(handler.mock.calls[0][2].signal.aborted).toBe(true);
    expect(await terminal).toEqual(failure('tool_timeout'));
    expect(await registry.start(call)).toEqual(await terminal);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('bounds an ignored abort and discards late false success', async () => {
    let resolve!: (value: unknown) => void;
    const handler = vi.fn<PhoneToolHandler>(() => new Promise(settle => { resolve = settle; }));
    const registry = createPhoneToolCallRegistry(handler);
    const first = registry.start(input('o8_status'));
    const attached = registry.start(input('o8_status'));
    await vi.advanceTimersByTimeAsync(toolTimeoutMs('o8_status') + PHONE_CALL_ABORT_SETTLE_MS);
    const unknown = await first;
    expect(unknown.result).toMatchObject({ error: 'interrupt_delivery_failed' });
    expect(await attached).toEqual(unknown);
    resolve('late success');
    await Promise.resolve();
    expect(await registry.start(input('o8_status'))).toEqual(unknown);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('never reports handler success after timeout even if abort settles within the grace window', async () => {
    const handler = vi.fn<PhoneToolHandler>((_tool, _args, { signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve('success after abort'), { once: true });
    }));
    const registry = createPhoneToolCallRegistry(handler);
    const terminal = registry.start(input('o8_status'));
    await vi.advanceTimersByTimeAsync(toolTimeoutMs('o8_status'));
    expect(await terminal).toEqual(failure('tool_timeout'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('snapshots trusted plan reviews and derives ordinary confirmation targets from scoped args', async () => {
    const registry = createPhoneToolCallRegistry();
    const call = { ...input(), args: { approvalId: ' approval ', laneId: 'lane', packetId: '', sessionKey: 42 } };
    const pending = await registry.start(call);
    expect(pending.confirmation!.target).toEqual({ approvalId: 'approval', laneId: 'lane' });
    const plan = { planId: 'plan', steps: [{ index: 1, summary: 'First' }, { index: 2, summary: 'Second' }] };
    const reviewed = await registry.start({ ...input('symon_execute_plan', 'plan-call'), review: {
      summary: 'Run two steps', target: { laneId: 'lane' }, kind: 'plan', plan,
    } });
    plan.steps[0].summary = 'Changed';
    expect(reviewed.confirmation!.plan!.steps[0].summary).toBe('First');
    expect(parseSymonPendingConfirmation(reviewed.confirmation, input('symon_execute_plan', 'plan-call'))).toEqual(reviewed.confirmation);
    registry.decide(decision(pending, false));
    registry.decide(decision(reviewed, false));
    expect(await registry.wait('session', 'call')).toEqual(failure('confirmation_declined'));
  });

  it.each(['before', 'pending', 'approved-before-handler', 'running'])('interrupts %s registration/execution', async phase => {
    const handler = abortingHandler();
    const registry = createPhoneToolCallRegistry(handler);
    let first: Promise<SymonToolRelayResult> | undefined;
    if (phase === 'running') {
      first = registry.start(input('o8_status'));
      await Promise.resolve();
    } else if (phase !== 'before') {
      const pending = await registry.start(input());
      if (phase === 'approved-before-handler') registry.decide(decision(pending));
    }
    const interrupted = await registry.interrupt('session', 'call');
    expect(interrupted).toEqual({ ok: true, result: { delivered: true, wasActive: phase !== 'before' } });
    const tool = phase === 'running' ? 'o8_status' : 'o8_dispatch';
    const result = await registry.start(input(tool));
    expect(result).toEqual(failure('session_preempted'));
    expect(await registry.wait('session', 'call')).toEqual(result);
    if (first) expect(await first).toEqual(result);
    expect(handler).toHaveBeenCalledTimes(phase === 'running' ? 1 : 0);
    expect(await registry.interrupt('session', 'call')).toMatchObject({ result: { wasActive: false } });
  });

  it('reports unknown interrupt outcome when a running handler ignores abort', async () => {
    const registry = createPhoneToolCallRegistry(async () => new Promise(() => {}));
    const terminal = registry.start(input('o8_status'));
    await Promise.resolve();
    const interrupted = registry.interrupt('session', 'call');
    await vi.advanceTimersByTimeAsync(PHONE_CALL_ABORT_SETTLE_MS);
    expect((await interrupted).result).toMatchObject({ error: 'interrupt_delivery_failed' });
    expect(await terminal).toEqual(await interrupted);
  });

  it('bounds completed and early interrupt tombstones by count and age', async () => {
    const handler = vi.fn<PhoneToolHandler>().mockResolvedValue('done');
    const registry = createPhoneToolCallRegistry(handler);
    for (let index = 0; index <= PHONE_CALL_TOMBSTONE_LIMIT; index++) {
      await registry.start(input('o8_status', String(index)));
      await registry.interrupt('early', String(index));
    }
    await registry.start(input('o8_status', '0'));
    expect(handler).toHaveBeenCalledTimes(PHONE_CALL_TOMBSTONE_LIMIT + 2);
    expect(await registry.start({ ...input('o8_status', '0'), sessionId: 'early' })).toEqual({ ok: true, result: 'done' });
    expect(await registry.start({ ...input('o8_status', '1'), sessionId: 'early' })).toEqual(failure('session_preempted'));
    await vi.advanceTimersByTimeAsync(SYMON_REPLAY_TTL_MS);
    expect(await registry.wait('session', '0')).toEqual(failure('not_found'));
    expect(await registry.start({ ...input('o8_status', '2'), sessionId: 'early' })).toEqual({ ok: true, result: 'done' });
  });

  it('fails malformed input and invalid plan reviews closed without a handler', async () => {
    const handler = vi.fn<PhoneToolHandler>();
    const registry = createPhoneToolCallRegistry(handler);
    expect(await registry.start({ ...input(), sessionId: '' })).toEqual(failure('bad_request'));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await registry.start({ ...input(), args: cyclic })).toEqual(failure('bad_request'));
    expect(await registry.start({ ...input(), review: { summary: 'Plan', target: {}, kind: 'plan' } })).toEqual(failure('confirmation_mismatch'));
    expect(handler).not.toHaveBeenCalled();
  });
});
