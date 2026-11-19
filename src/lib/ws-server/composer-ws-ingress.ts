import { randomUUID } from 'node:crypto';
import { composerOwnerRequest, type ComposerOwnerTransport } from '@/lib/orchestrator/composer-owner-client';
import { composerQueueRepoKey } from '@/lib/orchestrator/composer-queue';
import type { ComposerQueuePayload, ComposerWsSelection, QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';
import { ComposerExecutorAttempt, ComposerAttemptUncertain } from './composer-executor-attempt';
import { ComposerOwnerUnknownOutcome } from './composer-owner-rpc';
import { composerWsIdentity, resolveComposerWireThreadId } from './composer-ws-identity';

const SELECTION_KEYS = ['backend', 'model', 'thinkingEffort', 'permissionMode', 'orchestrationMode', 'pickedMode',
  'serviceTier', 'projectId', 'handoffMode', 'pinBackend', 'collideBaseBackend'] as const;
export function composerWsSelection(resolved: Record<string, unknown>): ComposerWsSelection {
  const selection: ComposerWsSelection = {};
  for (const key of SELECTION_KEYS) {
    const value = resolved[key];
    if (typeof value === 'string' || (key === 'pinBackend' && typeof value === 'boolean')) selection[key] = value;
  }
  return selection;
}

/** Durable ingress owns dedupe; the existing executor owns acceptance and history. */
export async function executeComposerWsIngress(input: {
  repoPath: string; wire: Record<string, unknown>; clientMutationId?: string; savedThoughtsThread: boolean;
  prepare(selection?: ComposerWsSelection): { payload: ComposerQueuePayload; selection: ComposerWsSelection };
  execute(wire: Record<string, unknown>, selected: Record<string, unknown>, attempt: ComposerExecutorAttempt): Promise<void>;
  duplicate(inProgress: boolean, item: QueuedComposerSendRecord): void;
  guardNew?(execute: () => Promise<void>): Promise<void>;
}, request: ComposerOwnerTransport = composerOwnerRequest): Promise<void> {
  const repoPath = composerQueueRepoKey(input.repoPath);
  const mutationId = input.clientMutationId ?? randomUUID();
  const identity = composerWsIdentity(repoPath, input.wire.threadId, mutationId);
  const threadId = resolveComposerWireThreadId(input.wire.threadId);
  const previous = await request('get', { id: identity.id });
  const target = previous.item ? { repoPath: previous.item.repoPath, threadId: previous.item.threadId }
    : { repoPath, threadId: input.savedThoughtsThread && threadId ? threadId : identity.syntheticThreadId };
  const run = async () => {
    // A retry uses the first snapshot, even when runtime defaults have changed.
    const prepared = input.prepare(previous.item?.payload.wsSelection);
    const received = await request('enqueue', { id: identity.id, target, intent: 'send-next',
      payloadJson: JSON.stringify({ ...prepared.payload, wsSelection: prepared.selection }),
      ingress: { kind: 'ws', clientMutationId: mutationId, wireJson: JSON.stringify(input.wire) } });
    if (received.disposition === 'existing') {
      input.duplicate(received.item.status === 'queued' || received.item.status === 'dispatching', received.item);
      return;
    }
    const claim = await request('claim', { id: identity.id, intent: 'ingress' });
    if (!claim.item || claim.item.id !== identity.id || claim.item.repoPath !== target.repoPath || claim.item.threadId !== target.threadId
      || !claim.claimToken || !claim.ingress || !claim.item.payload.wsSelection) {
      throw new ComposerAttemptUncertain();
    }
    const attempt = new ComposerExecutorAttempt(claim.item.id, claim.claimToken, request);
    try {
      const wire = JSON.parse(claim.ingress.wireJson) as Record<string, unknown>;
      await attempt.assertLive();
      await input.execute(wire, { ...wire, ...claim.item.payload.wsSelection }, attempt);
      await attempt.settle(attempt.admitted ? 'applied' : 'held', attempt.admitted ? undefined : 'Orchestrator command was not accepted.');
    } catch (error) {
      if (!(error instanceof ComposerAttemptUncertain) && !(error instanceof ComposerOwnerUnknownOutcome)) {
        await attempt.settle('held', error instanceof Error ? error.message : 'Orchestrator command failed.');
      }
      throw error;
    }
  };
  if (!previous.item && input.guardNew) await input.guardNew(run);
  else await run();
}
