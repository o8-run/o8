import { isUnmappedEffortLead, unmappedEffortError } from '@/lib/lane/orchestrator-backends/unmapped-effort';
import { EffortPinRejectionError } from '@/lib/orchestrator/effort-pin';
import { getOrchestratorBackend } from '@/lib/lane/orchestrator-backends/registry';
import { sendOrchestratorBackendTurn, resolveTurnReceiptMode } from '@/lib/lane/orchestrator-send-entry';
import type { OrchestratorTurnOptions } from '@/lib/lane/orchestrator-backends/types';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { appendMobileOrchestratorUserMessage, upsertMobileOrchestratorAssistantMessage, writeOrchestratorBackendSessionId } from '@/lib/mobile/orchestrator-thread-history';
import type { MobileTurnReceipt } from '@/lib/mobile/types';
import type { ReviewChatOrigin } from '@/lib/orchestrator/review-continuation-origin';
import { withSessionRules } from '@/lib/orchestrator/session-rules-prompt';
import { withOrchestratorTurnReceiptContext } from '@/lib/orchestrator/turn-receipt-context';
import { prepareOrchestratorProjectTurn, readPersistedOrchestratorProjectSelection } from '@/lib/ws-server/orchestrator-project-context';
import { persistComposerImages } from '@/lib/mobile/orchestrator-image-media';
import type { ComposerImageAttachment } from '@/lib/mobile/composer-image-validation';
import { modelFacingComposerMessage } from '@/lib/orchestrator/composer-wire';
import type { OrchestratorPermissionMode } from '@/lib/orchestrator/permission-mode';

export interface BoundChatContinuationHooks {
  registerAbort(repoPath: string, origin: ReviewChatOrigin, controller: AbortController): () => void;
  publish(sessionName: string, event: string, data: Record<string, unknown>): void;
}

/** Execute a continuation through the same threaded backend and canonical transcript. */
export async function runBoundChatContinuation(
  input: { repoPath: string; origin: ReviewChatOrigin; message: string; assistantMessageId: string;
    check: () => void; claim?: () => boolean; legacyPermissionMode?: 'full' | 'plan';
    permissionMode?: OrchestratorPermissionMode;
    /** Queued user sends carry explicit routing; automatic continuations inherit it. */
    source?: 'user' | 'system';
    displayMessage?: string; images?: ComposerImageAttachment[]; admit?: () => boolean;
    serviceTier?: OrchestratorTurnOptions['serviceTier']; collideBaseBackend?: OrchestratorTurnOptions['collideBaseBackend'] },
  hooks: BoundChatContinuationHooks,
): Promise<void> {
  const { origin: expected, message, assistantMessageId } = input;
  const permissionMode = input.permissionMode ?? expected.permissionMode;
  input.check();
  const unmapped = isUnmappedEffortLead(expected.backend);
  const thinkingEffort = unmapped && input.source !== 'user' ? undefined : expected.effort;
  const effortError = unmapped ? unmappedEffortError(thinkingEffort) : null;
  if (effortError?.type === 'error') throw new EffortPinRejectionError('effort_unsupported_runtime', effortError.error);
  const backend = getOrchestratorBackend(expected.backend);
  const controller = new AbortController();
  const release = hooks.registerAbort(input.repoPath, expected, controller);
  const startedAt = Date.now();
  let text = '';
  let completed = false;
  let turnError: string | null = null;
  let receipt: MobileTurnReceipt = { leadModel: expected.model, effort: thinkingEffort ?? 'adaptive',
    ...(unmapped && thinkingEffort === undefined ? { effortSource: 'runtime-default' as const } : {}),
    mode: resolveTurnReceiptMode(expected.backend, expected.mode, expected.pickedMode),
    permissionMode, pickedMode: expected.pickedMode };
  const data = { repoPath: input.repoPath, threadId: expected.threadId, backend: backend.id, model: expected.model, assistantMessageId };
  const persist = (sessionId: string | null, done?: Extract<OrchestratorEvent, { type: 'done' }>) => upsertMobileOrchestratorAssistantMessage({
    tabId: expected.threadId, repoPath: input.repoPath, messageId: assistantMessageId, content: text,
    backend: backend.id, model: expected.model, receipt, sessionId, timestampMs: startedAt,
    ...(done?.usage ? { tokens: { input: done.usage.inputTokens, output: done.usage.outputTokens,
      cacheRead: done.usage.cacheReadTokens, cacheWrite: done.usage.cacheWriteTokens,
      ...((done.usage.cacheObserved === false) ? { cacheObserved: false } : {}),
      ...(done.usage.cacheRetentionMs ? { cacheRetentionMs: done.usage.cacheRetentionMs } : {}) } } : {}),
  });
  try {
    if (input.claim && !input.claim()) return;
    const session = backend.ensureSession(input.repoPath, undefined, expected.threadId);
    const selection = await readPersistedOrchestratorProjectSelection(expected.threadId);
    const project = await prepareOrchestratorProjectTurn({ message: modelFacingComposerMessage(message, expected.mode),
      repoPath: input.repoPath, persistedProjectId: selection?.projectId });
    input.check();
    if (controller.signal.aborted) throw new Error('Parent continuation stopped.');
    if (input.admit && !input.admit()) throw new Error('Queued message admission was cancelled.');
    const media = input.images?.length ? persistComposerImages(input.images) : undefined;
    appendMobileOrchestratorUserMessage({ tabId: expected.threadId, repoPath: input.repoPath, message: input.displayMessage ?? message,
      ...(media ? { media } : {}),
      messageId: `review-user-${assistantMessageId}`, backend: backend.id, timestampMs: startedAt });
    persist(null);
    hooks.publish(session.sessionName, 'turn-start', { ...data, userMessageId: `review-user-${assistantMessageId}`,
      message: input.displayMessage ?? message, timestamp: startedAt, media });
    hooks.publish(session.sessionName, 'status', { ...data, status: 'busy' });
    await sendOrchestratorBackendTurn(backend, input.repoPath, withOrchestratorTurnReceiptContext({
      message: withSessionRules(project.message, expected.threadId), threadId: expected.threadId, turnId: assistantMessageId,
      orchestrationMode: expected.mode,
    }), (event: OrchestratorEvent) => {
      switch (event.type) {
        case 'turn_receipt':
          receipt = { ...receipt, leadModel: event.leadModel, effort: event.effort, effortSource: event.effortSource, serviceTier: event.serviceTier }; persist(null); break;
        case 'text':
          text += event.text; persist(null);
          hooks.publish(session.sessionName, 'output', { ...data, text: event.text, thinking: false }); break;
        case 'thinking': hooks.publish(session.sessionName, 'output', { ...data, text: event.text, thinking: true }); break;
        case 'tool_use': hooks.publish(session.sessionName, 'tool-use', { ...data, name: event.name, args: event.input, toolUseId: event.id }); break;
        case 'tool_result': hooks.publish(session.sessionName, 'tool-result', { ...data, name: event.name, args: event.input, output: event.output, toolUseId: event.id, isError: event.isError }); break;
        case 'plan': hooks.publish(session.sessionName, 'plan-update', { ...data, turnId: assistantMessageId, explanation: event.explanation, steps: event.steps }); break;
        case 'done':
          completed = true;
          receipt = { ...receipt, terminal: { userMessageId: `review-user-${assistantMessageId}`,
            outcome: controller.signal.aborted ? 'unconfirmed' : event.terminalOutcome ?? 'unconfirmed' } };
          if (event.sessionId && (backend.id === 'codex' || backend.id === 'claude')) writeOrchestratorBackendSessionId(expected.threadId, backend.id, event.sessionId);
          persist(event.sessionId, event);
          hooks.publish(session.sessionName, 'status', { ...data, status: controller.signal.aborted ? 'stopped' : 'ready', receipt,
            voiceTerminal: { ...receipt.terminal, text }, cost: event.cost, usage: event.usage }); break;
        case 'error': turnError = event.error; hooks.publish(session.sessionName, 'error', { ...data, error: event.error }); break;
        case 'turn_retry': text = ''; persist(null); break;
        case 'collide_phase': case 'collide_proposal': case 'handoff': break;
      }
    }, { threadId: expected.threadId, model: expected.model, thinkingEffort,
      permissionMode: permissionMode ?? input.legacyPermissionMode ?? 'plan', signal: controller.signal,
      attachments: input.images,
      serviceTier: input.serviceTier, collideBaseBackend: input.collideBaseBackend,
      // Only the Codex and Claude subprocesses keep a crash record; Pi resumes from its own session file.
      ...((expected.backend === 'codex' || expected.backend === 'claude') ? {
        crashSurvival: { backend: expected.backend, threadId: expected.threadId,
          assistantMessageId, assistantStartedAtMs: startedAt, model: expected.model },
      } : {}) }, expected.mode);
    if (turnError) throw new Error(turnError);
    if (controller.signal.aborted) throw new Error('Parent continuation stopped.');
    if (!completed) throw new Error('Parent continuation ended without a completion receipt.');
  } catch (error) {
    hooks.publish(backend.peekSession(input.repoPath, undefined, expected.threadId)?.sessionName ?? '', controller.signal.aborted ? 'status' : 'error', controller.signal.aborted
      ? { ...data, status: 'stopped' } : { ...data, error: 'The continuation failed. Inspect the originating chat before retrying.' });
    throw error;
  } finally { release(); }
}
