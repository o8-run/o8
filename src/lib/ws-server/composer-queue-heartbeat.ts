import { readSteerTranscriptAnchor } from './steer-transcript-anchor';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { backendSwitchRequiresExplicitHandoff } from '@/lib/orchestrator/backend-switch-carry';
import { assertComposerSendClaim, admitComposerSend, claimNextComposerSend, listComposerQueueTargets,
  listQueuedComposerSends, recoverComposerSends, settleComposerSend, validateComposerQueueTarget } from '@/lib/orchestrator/composer-queue';
import type { QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';
import type { ReviewChatOrigin } from '@/lib/orchestrator/review-continuation-origin';
import { resolveBackendTurnModel } from '@/lib/orchestrator/turn-model-selection';
import { findLeadThreadBinding, sendLeadThreadMessage } from '@/lib/orchestrator/lead-lifecycle';
import { validateLeadAttachments } from '@/lib/orchestrator/lead-contract';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { runBoundChatContinuation, type BoundChatContinuationHooks } from './bound-chat-continuation';
import { createSharedWorkerHeartbeat, type SharedWorkerHeartbeatHooks } from './shared-worker-heartbeat';
import { immediateComposerSendPending } from './composer-send-admission';
import { sendLeadTerminalStatus } from './lead-terminal-status';
import { getOrchestratorBackend } from '@/lib/lane/orchestrator-backends/registry';
import { checkComposerQueuePrecondition } from '@/lib/orchestrator/composer-queue-precondition';
import { permissionModeRank } from '@/lib/orchestrator/permission-mode';
import { claimComposerSteer, deferComposerSteer } from '@/lib/orchestrator/composer-queue';
import { appendMobileOrchestratorUserMessage } from '@/lib/mobile/orchestrator-thread-history';

export function publishComposerQueueChange(threadId: string) {
  void publishRealtimeMutation({ mutation: { mutationId: `composer-queue-${threadId}-${Date.now()}`,
    source: 'server', action: 'composer-queue', status: 'completed', surfaceId: threadId,
    createdAt: new Date().toISOString() } });
}

function originFor(item: QueuedComposerSendRecord): ReviewChatOrigin {
  const route = item.payload.routing;
  const collide = route.collide && route.mode !== 'single';
  const backend = collide ? 'collide' : route.backend;
  return { ...route, backend, model: resolveBackendTurnModel(backend, route.model)!,
    mode: collide ? 'fleet' : route.mode, threadId: item.threadId, turnId: `assistant-queued-${item.id}` };
}

export function checkComposerQueueBinding(item: QueuedComposerSendRecord): void {
  assertComposerSendClaim(item.id);
  validateComposerQueueTarget(item);
  checkComposerQueuePrecondition(item);
  const history = readPersistedLlmChat(item.threadId)?.history as { archivedAt?: unknown; projectId?: string;
    messages?: Array<{ role: string; timestamp: number; receipt?: { permissionMode?: string } }> } | undefined;
  if (history?.archivedAt) throw new Error('This chat was archived.');
  if ((history?.projectId ?? undefined) !== item.payload.routing.projectId) throw new Error('The queued chat project changed.');
  if (backendSwitchRequiresExplicitHandoff({ threadId: item.threadId, toBackend: originFor(item).backend })) {
    throw new Error('The chat runtime changed. Choose an explicit handoff before sending this message.');
  }
  const latest = history?.messages?.filter(row => row.role === 'assistant').at(-1);
  if (latest && latest.timestamp > item.createdAt && latest.receipt?.permissionMode !== undefined
    && permissionModeRank(latest.receipt.permissionMode) < permissionModeRank(item.payload.routing.permissionMode)) {
    throw new Error('Chat permissions became more restrictive after this message was queued.');
  }
}

/** Native input is acknowledged before its transcript label can claim delivery. */
export async function runQueuedComposerSteer(item: QueuedComposerSendRecord): Promise<void> {
  checkComposerQueueBinding(item);
  if (item.payload.afterTaskId) { deferComposerSteer(item.id, 'Queued for the original task to finish.'); return; }
  const backend = getOrchestratorBackend(originFor(item).backend, targetFor(item));
  if (!backend.liveSteer) { deferComposerSteer(item.id, 'Steer declined; queued for the next turn.'); return; }
  let steerAnchor: import('@/lib/transcripts/steer-anchor').SteerTranscriptAnchor | undefined;
  let admittedAt: number | undefined;
  const result = await backend.liveSteer(item.repoPath, item.payload.wireMessage, {
    ...item.payload.routing, threadId: item.threadId, clientUserMessageId: item.id, attachments: item.payload.images, orchestrationMode: item.payload.routing.mode,
    beforeAdmit: () => { checkComposerQueueBinding(item); if (!admitComposerSend(item.id)) throw new Error('Message admission was cancelled.');
      steerAnchor = readSteerTranscriptAnchor(item.repoPath, item.threadId); admittedAt = Date.now(); },
  });
  if (result.accepted !== true) { deferComposerSteer(item.id, 'Steer declined; queued for the next turn.'); return; }
  // A relay owner may already have saved its exact boundary before replying.
  if (!readPersistedLlmChat(item.threadId)?.history.messages.some(message => message.id === `composer-steer-${item.id}`)) appendMobileOrchestratorUserMessage({ tabId: item.threadId, repoPath: item.repoPath, message: item.payload.text,
    messageId: `composer-steer-${item.id}`, backend: item.payload.routing.backend, timestampMs: admittedAt ?? item.createdAt, steerAnchor });
  settleComposerSend(item.id, { status: 'applied' });
}

/** User-requested next turns use saved routing, never whichever composer is currently open. */
export async function runQueuedComposerSend(item: QueuedComposerSendRecord, hooks: BoundChatContinuationHooks): Promise<void> {
  checkComposerQueueBinding(item);
  const repoPath = readPersistedLlmChat(item.threadId)!.history.repoPath!;
  if (findLeadThreadBinding(item.threadId)) {
    const origin = originFor(item);
    if (origin.permissionMode === 'outside-workspace') throw new Error('Outside workspace commands require the built-in lead.');
    const result = await sendLeadThreadMessage({ threadId: item.threadId, repoPath,
      message: item.payload.wireMessage, displayMessage: item.payload.text, projectId: origin.projectId,
      backend: origin.backend, model: origin.model, effort: origin.effort, permissionMode: origin.permissionMode,
      attachments: validateLeadAttachments(item.payload.images), idempotencyKey: `composer-queue:${item.id}`,
      beforeAdmit: () => { checkComposerQueueBinding(item); if (!admitComposerSend(item.id)) throw new Error('Queued message admission was cancelled.'); } });
    if (!result) throw new Error('Persistent chat binding disappeared.');
    const sessionName = getOrchestratorBackend(origin.backend).ensureSession(repoPath, undefined, item.threadId).sessionName;
    hooks.publish(sessionName, 'status', { ...targetFor(item), backend: result.lead.routing.backend,
      status: 'busy', leadStatus: result.lead.status, lead: result.lead, admittedTurnId: result.admittedTurnId });
    void sendLeadTerminalStatus(message => {
      hooks.publish(sessionName, message.event as string, message.data as Record<string, unknown>);
    }, result.lead.id, result.admittedTurnId, result.cursor)
      .catch(error => console.warn('[composer-queue] Lead status bridge failed:', error));
    return;
  }
  await runBoundChatContinuation({ repoPath, origin: originFor(item), message: item.payload.wireMessage,
    displayMessage: item.payload.text, images: item.payload.images, assistantMessageId: `assistant-queued-${item.id}`,
    serviceTier: item.payload.routing.serviceTier,
    collideBaseBackend: originFor(item).backend === 'collide' ? item.payload.routing.backend : undefined,
    check: () => checkComposerQueueBinding(item), admit: () => admitComposerSend(item.id) }, hooks);
}

function targetFor(item: QueuedComposerSendRecord) { return { repoPath: item.repoPath, threadId: item.threadId }; }

export function createComposerQueueHeartbeat(input: SharedWorkerHeartbeatHooks): () => void {
  recoverComposerSends();
  const active = new Set<string>();
  const steering = new Set<string>();
  return () => {
    for (const target of listComposerQueueTargets()) {
      try {
      const key = `${target.repoPath}\0${target.threadId}`;
      const steer = listQueuedComposerSends(target).find(item => item.intent === 'steer-now' && item.status === 'queued');
      if (steer && !steering.has(key)) {
        const claimed = claimComposerSteer(steer.id);
        if (claimed) {
          steering.add(key); publishComposerQueueChange(target.threadId);
          void runQueuedComposerSteer(claimed).catch(error => {
            settleComposerSend(claimed.id, { status: 'held', reason: `Steer unconfirmed; queued for inspection. ${error instanceof Error ? error.message : ''}` });
          }).finally(() => { steering.delete(key); publishComposerQueueChange(target.threadId); });
        }
        continue;
      }
      if (steering.has(key)) continue;
      const next = listQueuedComposerSends(target)[0];
      if (!next || next.status !== 'queued' || active.has(key) || input.isBusy(target.repoPath, originFor(next))) continue;
      const item = claimNextComposerSend(target);
      if (!item) continue;
      active.add(key); publishComposerQueueChange(item.threadId);
      void runQueuedComposerSend(item, { registerAbort: input.registerAbort,
        publish: (session, event, data) => input.publish(item.threadId, session, event, data),
      }).then(() => { settleComposerSend(item.id, { status: 'applied' }); })
        .catch(error => { settleComposerSend(item.id, { status: 'held', reason: error instanceof Error ? error.message : 'Queued message failed.' }); })
        .finally(() => { active.delete(key); publishComposerQueueChange(item.threadId); });
      } catch (error) {
        const item = claimNextComposerSend(target);
        if (item) {
          settleComposerSend(item.id, { status: 'held', reason: error instanceof Error ? error.message : 'Queued chat is unavailable.' });
          publishComposerQueueChange(item.threadId);
        }
      }
    }
  };
}

/** Reuse the supervisor timer and give explicit queued user messages admission first. */
export function createChatContinuationHeartbeat(input: SharedWorkerHeartbeatHooks): () => void {
  const bound = { ...input, isBusy: (repoPath: string, origin: ReviewChatOrigin) => {
    const lead = findLeadThreadBinding(origin.threadId);
    return immediateComposerSendPending({ repoPath, threadId: origin.threadId })
      || Boolean(lead && ['queued', 'running', 'waiting_workers'].includes(lead.status)) || input.isBusy(readPersistedLlmChat(origin.threadId)?.history.repoPath ?? repoPath, origin);
  } };
  const queue = createComposerQueueHeartbeat(bound);
  const workers = createSharedWorkerHeartbeat(bound);
  return () => { queue(); workers(); };
}
