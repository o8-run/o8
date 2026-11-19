import { expect, it, vi } from 'vitest';
import type { ComposerExecutorAttempt } from '@/lib/ws-server/composer-executor-attempt';
import type { ComposerQueuePayload, QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';
import type { ComposerOwnerTransport } from '@/lib/orchestrator/composer-owner-client';
import { composerWsSelection, executeComposerWsIngress } from '@/lib/ws-server/composer-ws-ingress';
import { resolveComposerWireThreadId } from '@/lib/ws-server/composer-ws-identity';

function fixture(threadId: string | null = 'thoughts-ingress', savedThoughtsThread = Boolean(threadId?.startsWith('thoughts-'))) {
  let row: QueuedComposerSendRecord | null = null;
  let wireJson = '';
  let currentModel = 'first-model';
  let selectionReads = 0;
  const events: string[] = [];
  let beforeAdmit: (() => Promise<void>) | undefined;
  const request: ComposerOwnerTransport = async (method, params) => {
    let result: unknown;
    switch (method) {
      case 'get': result = { item: row }; break;
      case 'enqueue': {
        const input = params as import('@/lib/ws-server/composer-owner-rpc').ComposerOwnerParams['enqueue'];
        if (!row) {
          wireJson = input.ingress!.wireJson;
          row = { ...input.target, id: input.id, sequence: 1, intent: 'send-next', payload: JSON.parse(input.payloadJson),
            status: 'queued', reason: null, createdAt: 1, updatedAt: 1, admittedAt: null };
          result = { item: row, disposition: 'created' };
        } else result = { item: row, disposition: 'existing' };
        break;
      }
      case 'claim': row!.status = 'dispatching'; result = { item: row, claimToken: 'abcdefghijklmnopqrstuv',
        ingress: { kind: 'ws', clientMutationId: 'same-send', wireJson } }; break;
      case 'assertClaim': result = { live: true }; break;
      case 'admit': row!.admittedAt = 2; result = { changed: true }; break;
      case 'settle': row!.status = 'applied'; result = { changed: true }; break;
      default: throw Error(`Unexpected fixture method ${method}`);
    }
    return result as never;
  };
  const execute = vi.fn(async (wire: Record<string, unknown>, selected: Record<string, unknown>, attempt: ComposerExecutorAttempt) => {
    await beforeAdmit?.();
    expect(resolveComposerWireThreadId(wire.threadId)).toBe(resolveComposerWireThreadId(threadId));
    expect(await attempt.admit()).toBe(true);
    events.push('accepted', 'busy');
    expect(selected.model).toBe('first-model');
  });
  const duplicate = vi.fn((inProgress: boolean, item: QueuedComposerSendRecord) => { expect(item.id).toMatch(/^ws-/); events.push(inProgress ? 'duplicate-in-progress' : 'replayed'); });
  const input: Parameters<typeof executeComposerWsIngress>[0] = {
    repoPath: '/isolated/fixture-repo', wire: { type: 'orchestrator-send', threadId, message: 'operator words', surface: 'mobile' },
    clientMutationId: 'same-send', savedThoughtsThread,
    prepare: previous => {
      if (!previous) selectionReads++;
      const selection = previous ?? composerWsSelection({ backend: 'codex', model: currentModel, thinkingEffort: 'xhigh' });
      const payload: ComposerQueuePayload = { text: 'operator words', wireMessage: 'operator words', images: [],
        routing: { backend: 'codex', model: String(selection.model), effort: 'xhigh', permissionMode: 'plan', mode: 'single', pickedMode: 'solo', collide: false } };
      return { payload, selection };
    }, execute, duplicate,
  };
  return { run: () => executeComposerWsIngress(input, request), events, execute, duplicate,
    row: () => row!, reads: () => selectionReads, historyCreated: () => { input.savedThoughtsThread = true; },
    defaults: (model: string) => { currentModel = model; }, block: (gate: () => Promise<void>) => { beforeAdmit = gate; } };
}
it('answers a duplicate before accepted with in-progress and never starts a second turn', async () => {
  const f = fixture();
  let entered!: () => void; let release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.block(async () => { entered(); await blocked; });
  const first = f.run();
  await ready;
  await f.run();
  expect(f.events).toEqual(['duplicate-in-progress']);
  expect(f.execute).toHaveBeenCalledOnce();
  release(); await first;
  expect(f.events).toEqual(['duplicate-in-progress', 'accepted', 'busy']);
});
it('keeps the original selection on a retry after defaults change', async () => {
  const f = fixture(); await f.run(); f.defaults('changed-model'); await f.run();
  expect(f.row().payload.wsSelection).toEqual({ backend: 'codex', model: 'first-model', thinkingEffort: 'xhigh' });
  expect(f.reads()).toBe(1); expect(f.execute).toHaveBeenCalledOnce();
  expect(f.duplicate.mock.calls[0][0]).toBe(false);
});
it.each([null, 'chat-42'])('executes the original legacy thread %j and keeps the synthetic key private', async thread => {
  const f = fixture(thread); await f.run(); await f.run();
  expect(f.row().threadId).toMatch(/^wsi:/);
  expect(f.execute.mock.calls[0][0].threadId).toBe(thread);
  expect(f.execute).toHaveBeenCalledOnce(); expect(f.duplicate.mock.calls[0][0]).toBe(false);
});
it('records routing fields in fixed order without nulls, objects, text or authority', () => {
  const selected = composerWsSelection({ pickedMode: 'solo', backend: 'codex', model: 'm', thinkingEffort: null,
    permissionMode: undefined, serviceTier: 'priority', grant: 'secret', surface: 'mobile', text: 'private', projectId: { secret: true } });
  expect(JSON.stringify(selected)).toBe('{"backend":"codex","model":"m","pickedMode":"solo","serviceTier":"priority"}');
});

it('keeps the first target and turn when an unsaved thoughts thread gains history before retry', async () => {
  const f = fixture('thoughts-newly-saved', false);
  await f.run(); const firstTarget = f.row().threadId;
  expect(firstTarget).toMatch(/^wsi:/);
  f.historyCreated(); await f.run();
  expect(f.row().threadId).toBe(firstTarget);
  expect(f.execute).toHaveBeenCalledOnce();
  expect(f.duplicate.mock.calls[0][0]).toBe(false);
});
