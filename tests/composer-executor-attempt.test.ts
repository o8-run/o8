import { expect, it, vi } from 'vitest';
import type { ComposerOwnerTransport } from '@/lib/orchestrator/composer-owner-client';
import { ComposerExecutorAttempt, ComposerAttemptUncertain } from '@/lib/ws-server/composer-executor-attempt';
import type { ComposerOwnerMethod, ComposerOwnerParams } from '@/lib/ws-server/composer-owner-rpc';
import { ComposerOwnerReplyError, ComposerOwnerUnknownOutcome } from '@/lib/ws-server/composer-owner-rpc';

const id = 'fenced-send';
const claimToken = 'abcdefghijklmnopqrstuv';
function transport(responses: Array<unknown | Error>) {
  const send = vi.fn(async (method: ComposerOwnerMethod, params: ComposerOwnerParams[ComposerOwnerMethod]) => { void method; void params; const reply = responses.shift(); if (reply instanceof Error) throw reply; return reply; });
  return { send, request: send as ComposerOwnerTransport };
}
it('reconciles a lost admit before allowing the caller to start its provider exactly once', async () => {
  const { request, send } = transport([new ComposerOwnerUnknownOutcome('admit', 'lost'),
    { item: { id, status: 'dispatching' }, attempt: { tokenMatches: true, admitted: true } }]);
  const attempt = new ComposerExecutorAttempt(id, claimToken, request);
  const provider = vi.fn();
  if (await attempt.admit()) provider();
  expect(provider).toHaveBeenCalledOnce();
  expect(send.mock.calls).toEqual([['admit', { id, claimToken }], ['get', { id, claimToken }]]);
});
it('retries only the same admission fence after a verified non-commit', async () => {
  const { request, send } = transport([new ComposerOwnerUnknownOutcome('admit', 'lost'),
    { item: { id, status: 'dispatching' }, attempt: { tokenMatches: true, admitted: false } }, { changed: true }]);
  expect(await new ComposerExecutorAttempt(id, claimToken, request).admit()).toBe(true);
  expect(send.mock.calls).toEqual([['admit', { id, claimToken }], ['get', { id, claimToken }], ['admit', { id, claimToken }]]);
});
it('reconciles a late first admit when the retry reports no change', async () => {
  const { request, send } = transport([new ComposerOwnerUnknownOutcome('admit', 'lost'),
    { item: { id, status: 'dispatching' }, attempt: { tokenMatches: true, admitted: false } }, { changed: false },
    { item: { id, status: 'dispatching' }, attempt: { tokenMatches: true, admitted: true } }]);
  expect(await new ComposerExecutorAttempt(id, claimToken, request).admit()).toBe(true);
  expect(send.mock.calls.map(call => call[0])).toEqual(['admit', 'get', 'admit', 'get']);
});
it('never dispatches or holds another attempt after a mismatch', async () => {
  const { request, send } = transport([new ComposerOwnerUnknownOutcome('admit', 'lost'),
    { item: null, attempt: { tokenMatches: false, admitted: false } }]);
  expect(await new ComposerExecutorAttempt(id, claimToken, request).admit()).toBe(false);
  expect(send.mock.calls.map(call => call[0])).toEqual(['admit', 'get']);
});
it('leaves a row untouched when exact-attempt reconciliation is unavailable', async () => {
  const { request, send } = transport([new ComposerOwnerUnknownOutcome('admit', 'lost'), Error('offline')]);
  await expect(new ComposerExecutorAttempt(id, claimToken, request).admit()).rejects.toBeInstanceOf(ComposerAttemptUncertain);
  expect(send.mock.calls.map(call => call[0])).toEqual(['admit', 'get']);
});
it('keeps a known pre-admit refusal distinct so the caller may defer that exact attempt', async () => {
  const { request, send } = transport([new ComposerOwnerReplyError('not_claimable', 'Admission refused.'), { changed: false }]);
  const attempt = new ComposerExecutorAttempt(id, claimToken, request);
  await expect(attempt.admit()).rejects.toThrow('Admission refused.');
  expect(attempt.admitted).toBe(false);
  await attempt.defer('Send next.');
  expect(send.mock.calls).toEqual([['admit', { id, claimToken }], ['deferSteer', { id, claimToken, reason: 'Send next.' }]]);
});
it('reconciles unknown settlement without replay or a target-wide hold', async () => {
  const { request, send } = transport([new ComposerOwnerUnknownOutcome('settle', 'lost'),
    { item: { id, status: 'dispatching' }, attempt: { tokenMatches: true, admitted: true } }]);
  await expect(new ComposerExecutorAttempt(id, claimToken, request).settle('applied')).rejects.toBeInstanceOf(ComposerAttemptUncertain);
  expect(send.mock.calls).toEqual([['settle', { id, claimToken, status: 'applied' }], ['get', { id, claimToken }]]);
});
