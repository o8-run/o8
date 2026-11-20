import { readSteerTranscriptAnchor } from './steer-transcript-anchor';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { backendSwitchRequiresExplicitHandoff } from '@/lib/orchestrator/backend-switch-carry';
import { claimNextComposerSend, listComposerQueueTargets, peekNextComposerSend,
  listQueuedComposerSends, validateComposerQueueTarget } from '@/lib/orchestrator/composer-queue';
import type { QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';
import type { ReviewChatOrigin } from '@/lib/orchestrator/review-continuation-origin';
import { resolveBackendTurnModel } from '@/lib/orchestrator/turn-model-selection';
import { findLeadThreadBinding, sendLeadThreadMessage } from '@/lib/orchestrator/lead-lifecycle';
import { validateLeadAttachments } from '@/lib/orchestrator/lead-contract';
import { publishRealtimeMutation } from '@/lib/realtime/publisher';
import { dropsStaleEffortPin } from '@/lib/lane/orchestrator-backends/unmapped-effort';
import { runBoundChatContinuation, type BoundChatContinuationHooks } from './bound-chat-continuation';
import { createSharedWorkerHeartbeat, type SharedWorkerHeartbeatHooks } from './shared-worker-heartbeat';
import { immediateComposerSendPending } from './composer-send-admission';
import { sendLeadTerminalStatus } from './lead-terminal-status';
import { getOrchestratorBackend } from '@/lib/lane/orchestrator-backends/registry';
import { checkComposerQueuePrecondition } from '@/lib/orchestrator/composer-queue-precondition';
import { permissionModeRank } from '@/lib/orchestrator/permission-mode';
import { claimComposerSteer } from '@/lib/orchestrator/composer-queue';
import { appendMobileOrchestratorUserMessage } from '@/lib/mobile/orchestrator-thread-history';
import { ComposerExecutorAttempt, ComposerAttemptUncertain } from './composer-executor-attempt';
import { EffortPinRejectionError } from '@/lib/orchestrator/effort-pin';
import { ComposerOwnerReplyError, ComposerOwnerUnknownOutcome } from './composer-owner-rpc';
import { persistComposerImages } from '@/lib/mobile/orchestrator-image-media';

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

export async function checkComposerQueueBinding(item: QueuedComposerSendRecord, attempt: ComposerExecutorAttempt): Promise<void> {
  await attempt.assertLive();
  checkComposerQueueContext(item);
}
/** Cross-process steer still checks the same current destination and authority. */
export function checkComposerQueueContext(item: QueuedComposerSendRecord): void {
  validateComposerQueueTarget(item);
  checkComposerQueuePrecondition(item);
  const history = readPersistedLlmChat(item.threadId)?.history as { archivedAt?: unknown; projectId?: string;
    messages?: Array<{ role: string; timestamp: number; receipt?: { permissionMode?: string } }> } | undefined;
  if (history?.archivedAt) throw new Error('This chat was archived.');
  if ((history?.projectId ?? undefined) !== item.payload.routing.projectId) throw new Error('The queued chat project changed.');
  // Only the built-in turn path seeds the new runtime; a bound lead would start cold.
  const explicit = item.payload.routing.handoffMode === 'handoff' && !findLeadThreadBinding(item.threadId);
  if (!explicit && backendSwitchRequiresExplicitHandoff({ threadId: item.threadId, toBackend: originFor(item).backend })) {
    throw new Error('The chat runtime changed. Choose an explicit handoff before sending this message.');
  }
  const latest = history?.messages?.filter(row => row.role === 'assistant').at(-1);
  if (latest && latest.timestamp > item.createdAt && latest.receipt?.permissionMode !== undefined
    && permissionModeRank(latest.receipt.permissionMode) < permissionModeRank(item.payload.routing.permissionMode)) {
    throw new Error('Chat permissions became more restrictive after this message was queued.');
  }
}

/** Native input is acknowledged before its transcript label can claim delivery. */
export async function runQueuedComposerSteer(item: QueuedComposerSendRecord, attempt: ComposerExecutorAttempt, claimToken: string): Promise<void> {
  await checkComposerQueueBinding(item, attempt);
  if (item.payload.afterTaskId) { await attempt.defer('Queued for the original task to finish.'); return; }
  const backend = getOrchestratorBackend(originFor(item).backend, targetFor(item));
  if (!backend.liveSteer) { await attempt.defer('Steer declined; queued for the next turn.'); return; }
  let steerAnchor: import('@/lib/transcripts/steer-anchor').SteerTranscriptAnchor | undefined;
  let admittedAt: number | undefined;
  const result = await backend.liveSteer(item.repoPath, item.payload.wireMessage, {
    ...item.payload.routing, threadId: item.threadId, clientUserMessageId: item.id, attachments: item.payload.images, orchestrationMode: item.payload.routing.mode,
    thinkingEffort: dropsStaleEffortPin(backend.id) ? undefined : item.payload.routing.effort,
    composerClaimToken: claimToken,
    beforeAdmit: async () => { await checkComposerQueueBinding(item, attempt); if (!(await attempt.admit())) throw new Error('Message admission was cancelled.');
      await checkComposerQueueBinding(item, attempt);
      steerAnchor = readSteerTranscriptAnchor(item.repoPath, item.threadId); admittedAt = Date.now(); },
  });
  if (result.accepted !== true) { await attempt.defer('Steer declined; queued for the next turn.'); return; }
  // A relay owner may already have saved its exact boundary before replying.
  if (item.payload.images.length || !readPersistedLlmChat(item.threadId)?.history.messages.some(message => message.id === `composer-steer-${item.id}`)) appendMobileOrchestratorUserMessage({ tabId: item.threadId, repoPath: item.repoPath, message: item.payload.text,
    ...(item.payload.images.length ? { media: persistComposerImages(item.payload.images) } : {}),
    messageId: `composer-steer-${item.id}`, backend: item.payload.routing.backend, timestampMs: admittedAt ?? item.createdAt, steerAnchor,
    mentions: item.payload.mentions });
  await attempt.settle('applied');
}

/** User-requested next turns use saved routing, never whichever composer is currently open. */
export async function runQueuedComposerSend(item: QueuedComposerSendRecord, hooks: BoundChatContinuationHooks, attempt: ComposerExecutorAttempt): Promise<void> {
  await checkComposerQueueBinding(item, attempt);
  // A chat with no project has no saved repository; its validated target is its scratch folder.
  const repoPath = readPersistedLlmChat(item.threadId)!.history.repoPath || item.repoPath;
  if (findLeadThreadBinding(item.threadId)) {
    const origin = originFor(item);
    if (origin.permissionMode === 'outside-workspace') throw new Error('Outside workspace commands require the built-in lead.');
    const result = await sendLeadThreadMessage({ threadId: item.threadId, repoPath,
      message: item.payload.wireMessage, displayMessage: item.payload.text, projectId: origin.projectId,
      backend: origin.backend, model: origin.model, effort: origin.effort, permissionMode: origin.permissionMode,
      attachments: validateLeadAttachments(item.payload.images), idempotencyKey: `composer-queue:${item.id}`,
      beforeAdmit: async () => { await checkComposerQueueBinding(item, attempt); if (!(await attempt.admit())) throw new Error('Queued message admission was cancelled.');
        await checkComposerQueueBinding(item, attempt); } });
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
  await runBoundChatContinuation({ repoPath, source: 'user', origin: originFor(item), message: item.payload.wireMessage,
    displayMessage: item.payload.text, mentions: item.payload.mentions, images: item.payload.images, assistantMessageId: `assistant-queued-${item.id}`,
    serviceTier: item.payload.routing.serviceTier,
    handoff: item.payload.routing.handoffMode === 'handoff',
    collideBaseBackend: originFor(item).backend === 'collide' ? item.payload.routing.backend : undefined,
    check: () => checkComposerQueueBinding(item, attempt), admit: () => attempt.admit() }, hooks);
}

function targetFor(item: QueuedComposerSendRecord) { return { repoPath: item.repoPath, threadId: item.threadId }; }

export function createComposerQueueHeartbeat(input: SharedWorkerHeartbeatHooks): () => void {
  // Recovery belongs to the daemon's producer attach, never a heartbeat object.
  const active = new Set<string>();
  const steering = new Set<string>();
  let ticking = false;
  const failed = async (item: QueuedComposerSendRecord, attempt: ComposerExecutorAttempt, error: unknown) => {
    if (error instanceof ComposerAttemptUncertain || error instanceof ComposerOwnerUnknownOutcome) return;
    const reason = error instanceof Error ? error.message : 'Queued message failed.';
    if (item.intent === 'steer-now' && !attempt.admitted && error instanceof ComposerOwnerReplyError) await attempt.defer(reason);
    else await attempt.settle('held', error instanceof EffortPinRejectionError ? reason
      : item.intent === 'steer-now' ? `Steer unconfirmed; queued for inspection. ${reason}` : reason);
  };
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const target of await listComposerQueueTargets()) {
        const key = `${target.repoPath}\0${target.threadId}`;
        let attempt: ComposerExecutorAttempt | undefined;
        let item: QueuedComposerSendRecord | undefined;
        try {
          const steer = (await listQueuedComposerSends(target)).find(row => row.intent === 'steer-now' && row.status === 'queued');
          if (steer && !steering.has(key)) {
            const claimed = await claimComposerSteer(steer.id);
            if (claimed.item && claimed.claimToken) {
              if (claimed.item.id !== steer.id || claimed.item.repoPath !== target.repoPath || claimed.item.threadId !== target.threadId) throw new ComposerAttemptUncertain();
              item = claimed.item;
              attempt = new ComposerExecutorAttempt(item.id, claimed.claimToken);
              steering.add(key);
              const running = attempt;
              void runQueuedComposerSteer(item, running, claimed.claimToken)
                .catch(error => failed(claimed.item!, running, error))
                .catch(() => { /* Failed owner response: leave the attempt for recovery. */ })
                .finally(() => steering.delete(key));
            }
            continue;
          }
          if (steering.has(key)) continue;
          const next = await peekNextComposerSend(target);
          if (!next || next.status !== 'queued' || active.has(key) || input.isBusy(target.repoPath, originFor(next))) continue;
          const claimed = await claimNextComposerSend(target);
          if (!claimed.item || !claimed.claimToken) continue;
          if (claimed.item.repoPath !== target.repoPath || claimed.item.threadId !== target.threadId) throw new ComposerAttemptUncertain();
          item = claimed.item;
          attempt = new ComposerExecutorAttempt(item.id, claimed.claimToken);
          active.add(key);
          const running = attempt;
          void runQueuedComposerSend(item, { registerAbort: input.registerAbort,
            publish: (session, event, data) => input.publish(claimed.item!.threadId, session, event, data),
            publishThread: input.publishThread,
          }, running).then(() => running.settle('applied'))
            .catch(error => failed(claimed.item!, running, error))
            .catch(() => { /* Unknown settlement never starts another provider turn. */ })
            .finally(() => active.delete(key));
        } catch (error) {
          if (item && attempt) await failed(item, attempt, error).catch(() => {});
          // An unavailable list or claim is never replaced with a local row write.
        }
      }
    } finally { ticking = false; }
  };
  return () => { void tick().catch(() => { /* Owner unavailable; retry discovery on the next tick only. */ }); };
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
