/**
 * Non-destructive merge of an inbound chat transcript onto the stored one.
 *
 * Fixes the transcript-loss bug (#1282): the chat-history POST used to write the
 * inbound `messages` array straight to disk, so a PARTIAL POST — e.g. a mobile
 * client that missed one streamed `output` event and sent a `[user]`-only
 * transcript — would REPLACE the desktop's complete `[user, assistant]` record
 * and the reply vanished everywhere.
 *
 * Contract:
 * - Inbound messages WIN for matching ids (update-by-id).
 * - Stored messages whose id is NOT present in the inbound array are PRESERVED,
 *   so no client can ever drop a turn it simply never saw. An empty/partial
 *   inbound can no longer wipe the file.
 * - A confirmed orchestrator user entry retires only its matching delivery
 *   warning. Confirmation survives stale writes; it does not mean turn success.
 * - Stored identities keep their causal sequence. New inbound runs use shared
 *   identities as insertion boundaries. Disjoint sources use timestamps only
 *   as a fallback without globally sorting either source.
 * - A `timestamp` is a CREATION time and never moves: on an id match the
 *   earlier of the two timestamps wins, so a client that re-POSTs an existing
 *   message stamped Date.now() can't shove it to the bottom of the thread.
 *
 * Intentional truncation (edit-and-resend / delete-message in the single-writer
 * Assistant tab) must NOT go through here — those callers pass `replace: true`
 * to the route for a full replace, because a shorter array can't be told apart
 * from a partial-loss array by inspection.
 */
import { areDistinctOrchestratorSends, preserveDeliveryConfirmation, removeConfirmedDeliveryWarnings } from '@/lib/transcripts/delivery-confirmation';
import type { MobileTurnReceipt } from '@/lib/mobile/types';
import { mergeMobileTurnReceipts } from '@/lib/mobile/turn-receipt';
import { preserveVoiceCaption } from '@/lib/transcripts/voice-captions';
import { mergeOrderedEntries } from '@/lib/transcripts/merge-ordered';

export interface ChatMessageLike {
  voice?: unknown;
  id?: unknown;
  timestamp?: unknown;
  backend?: unknown;
  model?: unknown;
  receipt?: unknown;
  persistedVersion?: unknown;
  type?: unknown;
  handoff?: unknown;
  deliveryConfirmed?: unknown;
}

const SERVER_METADATA_FIELDS = ['backend', 'model', 'receipt', 'persistedVersion', 'type', 'handoff', 'media', 'steerAnchor', 'toolCalls'] as const;

function preserveStoredAuthorship<T extends ChatMessageLike>(existing: T, inbound: T): T {
  if (typeof existing.persistedVersion === 'number' && existing.persistedVersion > (typeof inbound.persistedVersion === 'number' ? inbound.persistedVersion : 0)) {
    return preserveDeliveryConfirmation(inbound, preserveVoiceCaption(inbound, existing));
  }
  inbound = preserveVoiceCaption(existing, inbound);
  const existingRecord = existing as Record<string, unknown>;
  const inboundRecord = inbound as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  const confirmed = preserveDeliveryConfirmation(existingRecord, inboundRecord);
  if (confirmed !== inboundRecord) next = confirmed;
  for (const field of SERVER_METADATA_FIELDS) {
    if (existingRecord[field] === undefined || (field !== 'steerAnchor' && inboundRecord[field] !== undefined)) continue;
    next ??= { ...inboundRecord };
    next[field] = existingRecord[field];
  }
  if (existingRecord.receipt && typeof existingRecord.receipt === 'object' && !Array.isArray(existingRecord.receipt)
    && inboundRecord.receipt && typeof inboundRecord.receipt === 'object' && !Array.isArray(inboundRecord.receipt)
  ) {
    const receipt = mergeMobileTurnReceipts(
      existingRecord.receipt as MobileTurnReceipt,
      inboundRecord.receipt as MobileTurnReceipt,
    );
    if (receipt !== inboundRecord.receipt) {
      next ??= { ...inboundRecord };
      next.receipt = receipt;
    }
  }
  return (next ?? inboundRecord) as T;
}

function duplicateAdjacentMessage(left: ChatMessageLike, right: ChatMessageLike): boolean {
  if (left.voice || right.voice) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  if (areDistinctOrchestratorSends(leftRecord, rightRecord)) return false;
  const leftMedia = Array.isArray(leftRecord.media) ? leftRecord.media : [];
  const rightMedia = Array.isArray(rightRecord.media) ? rightRecord.media : [];
  return typeof leftRecord.role === 'string' && leftRecord.role === rightRecord.role
    && typeof leftRecord.content === 'string' && leftRecord.content === rightRecord.content
    && JSON.stringify(leftMedia) === JSON.stringify(rightMedia);
}

function collapseAdjacentDuplicates<T extends ChatMessageLike>(messages: T[]): T[] {
  const next: T[] = [];
  for (const message of messages) {
    if (next.length > 0 && duplicateAdjacentMessage(next[next.length - 1], message)) continue;
    next.push(message);
  }
  return next.length === messages.length ? messages : next;
}

function timestampOf(message: ChatMessageLike): number | null {
  const value = message?.timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function mergeChatMessages<T extends ChatMessageLike>(existing: T[], inbound: T[]): T[] {
  const inboundList = Array.isArray(inbound) ? inbound : [];
  const existingList = Array.isArray(existing) ? existing : [];

  // Preserve original creation metadata as well as identity-based order. A
  // later client re-stamp must not move fallback visualization anchors.
  const existingById = new Map<string, T>();
  for (const message of existingList) {
    if (message && typeof message.id === 'string') {
      existingById.set(message.id, message);
    }
  }
  let normalizedAny = false;
  const normalizedInbound = inboundList.map((message) => {
    if (!message || typeof message.id !== 'string') return message;
    const existingMessage = existingById.get(message.id);
    if (!existingMessage) return message;
    const withAuthorship = preserveStoredAuthorship(existingMessage, message);
    const priorTs = timestampOf(existingMessage);
    const ownTs = timestampOf(withAuthorship);
    if (priorTs !== null && (ownTs === null || priorTs < ownTs)) {
      normalizedAny = true;
      return { ...withAuthorship, timestamp: priorTs } as T;
    }
    if (withAuthorship !== message) normalizedAny = true;
    return withAuthorship;
  });

  const merged = mergeOrderedEntries(existingList, normalizedAny ? normalizedInbound : inboundList);
  return removeConfirmedDeliveryWarnings(collapseAdjacentDuplicates(merged));
}
