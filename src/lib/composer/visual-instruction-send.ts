import { visualQuestionEvidence } from './visual-clarification';
import type { QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';
import { composerQueuePayloadMatches } from './queue-payload-match';
import { composerBackendSupportsImages } from '@/lib/mobile/composer-image-validation';
import { buildVisualInstructionPayload } from './visual-instruction';
import type { VisualInstructionDraft } from './visual-draft-store';
import { visualMeaningContext } from './visual-meaning';

export class VisualInstructionDeliveryError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); this.name = 'VisualInstructionDeliveryError'; }
}

export const VISUAL_REQUEST_MARKER = '[o8-visual-instruction]';

/** Stable draft id is also the idempotency key. A lost reply never chooses another conversation. */
export async function submitVisualInstruction(draft: VisualInstructionDraft, transport: typeof fetch = fetch) {
  let result;
  try { result = buildVisualInstructionPayload(draft.request); } catch (error) { throw new VisualInstructionDeliveryError(error instanceof Error ? error.message : String(error)); }
  if (!composerBackendSupportsImages(draft.template.routing.backend)) throw new VisualInstructionDeliveryError('The selected runtime cannot receive these images. The visual draft is retained.');
  const template = draft.template.wireMessage;
  if (template.split(VISUAL_REQUEST_MARKER).length !== 2) throw new VisualInstructionDeliveryError('The captured send route is incomplete. Keep the draft and select its conversation.');
  const question = visualQuestionEvidence(draft);
  const pending = question ? `\nAn optional clarification was shown for these pixels and left unanswered: ${JSON.stringify(question)}. Inspect the evidence; if this ambiguity still matters, continue this same question in the existing chat.` : '';
  const payload = { ...draft.template, text: result.text, wireMessage: template.replace(VISUAL_REQUEST_MARKER, () => result.wireMessage + pending + visualMeaningContext(draft)), images: result.images };
  if (payload.wireMessage.length > 250_000) throw new VisualInstructionDeliveryError('This visual request exceeds the chat limit. Shorten the instruction or use fewer frames.');
  const response = await transport('/api/orchestrator/composer-queue', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...draft.request.target, id: `visual-${draft.request.id}`, intent: 'send-next', payload }) });
  const body = await response.json().catch(() => null) as { item?: QueuedComposerSendRecord; error?: string } | null;
  if (!response.ok) throw new VisualInstructionDeliveryError(body?.error || 'The visual request was not accepted. Its draft is retained.', draft.status === 'unknown' || response.status >= 500);
  if (body?.item?.id !== `visual-${draft.request.id}` || body.item.threadId !== draft.request.target.threadId
    || body.item.repoPath !== draft.request.target.repoPath || !composerQueuePayloadMatches(body.item.payload, payload)) {
    throw new VisualInstructionDeliveryError('Delivery was not confirmed for this conversation. Reconcile before retrying.', true);
  }
  if (body.item.status === 'cancelled') throw new VisualInstructionDeliveryError('This visual request was cancelled. Review the chat before creating another request.', true);
  return body.item;
}
