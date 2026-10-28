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
 * - Result is ordered chronologically by numeric `timestamp` (handles the
 *   interleaved case where a preserved reply belongs *between* two inbound
 *   messages). Missing/invalid timestamps carry the prior message's value so
 *   they stay put; ties keep concat order (inbound before preserved).
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

const SERVER_METADATA_FIELDS = ['backend', 'model', 'receipt', 'persistedVersion', 'type', 'handoff', 'media', 'steerAnchor'] as const;

function preserveStoredAuthorship<T extends ChatMessageLike>(existing: T, inbound: T): T {
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

  // A message's `timestamp` is its CREATION time — immutable for ordering. Some
  // clients re-POST an existing message stamped with Date.now() (a mobile sync
  // path did exactly this: it re-sent the user's messages stamped "now" as a
  // partial, so — because we sort by timestamp — every reply floated ABOVE the
  // question it answered). On an id match we therefore pin the inbound message
  // back to the EARLIER of the two timestamps: a re-stamp can never push a
  // message forward, so no client bug can reorder a thread. (The Assistant
  // tab's legitimate edits bypass merge entirely via replace:true.)
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

  const inboundIds = new Set<string>();
  for (const message of normalizedInbound) {
    if (message && typeof message.id === 'string') inboundIds.add(message.id);
  }

  // On-disk messages the inbound payload doesn't carry — the turns a partial
  // POST would otherwise drop. Messages without an id can't be matched, so we
  // keep them too (defensive; desktop + mobile always stamp ids).
  const preserved = existingList.filter(
    (message) => !(message && typeof message.id === 'string' && inboundIds.has(message.id)),
  );

  // Fast path: inbound already covers everything on disk AND no timestamp had
  // to be pinned (the normal full-transcript POST) — return it untouched, no
  // reordering. If we pinned anything we must fall through to the sort so the
  // corrected timestamps actually reorder the thread.
  if (preserved.length === 0 && !normalizedAny) return removeConfirmedDeliveryWarnings(collapseAdjacentDuplicates(inboundList));

  const concat: T[] = [...normalizedInbound, ...preserved];
  const decorated = concat.map((message, index) => ({ message, index, ts: timestampOf(message) }));
  // Carry a missing/invalid timestamp forward from the prior message so an
  // unstamped row sorts next to where it actually sat.
  let carry = 0;
  for (const entry of decorated) {
    if (entry.ts === null) entry.ts = carry;
    else carry = entry.ts;
  }
  decorated.sort((a, b) => (a.ts! - b.ts!) || (a.index - b.index));
  return removeConfirmedDeliveryWarnings(collapseAdjacentDuplicates(decorated.map((entry) => entry.message)));
}
