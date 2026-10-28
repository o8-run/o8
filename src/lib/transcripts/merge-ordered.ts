import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { preserveDeliveryConfirmation } from './delivery-confirmation';
import { preserveVoiceCaption } from './voice-captions';

interface OrderedEntry { id?: unknown; timestamp?: unknown }
function timestamp(entry: OrderedEntry): number | null {
  const value = entry.timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return null;
}

/**
 * Keep the established sequence. Insert unseen runs before their next shared
 * identity. A trailing run uses timestamps after its preceding shared identity.
 * A partial page cannot move an existing row; each source retains its causal
 * order, including equal/missing or skewed clocks.
 */
export function mergeOrderedEntries<T extends OrderedEntry>(existing: T[], incoming: T[], update: (prior: T, next: T) => T = (_prior, next) => next): T[] {
  if (!incoming.length) return existing;
  if (!existing.length) return incoming;
  const key = (entry: T) => typeof entry.id === 'string' ? entry.id : entry;
  const positions = new Map(existing.map((entry, index) => [key(entry), index]));
  const values = new Map(existing.map(entry => [key(entry), entry]));
  const additions: T[] = [];
  const seen = new Set<ReturnType<typeof key>>();
  for (const entry of incoming) {
    const id = key(entry);
    const prior = values.get(id);
    values.set(id, prior ? update(prior, entry) : entry);
    if (!seen.has(id)) { seen.add(id); additions.push(entry); }
  }
  const hasOverlap = additions.some(entry => positions.has(key(entry)));
  const nextShared = new Array<number>(additions.length);
  let next = -1;
  for (let index = additions.length - 1; index >= 0; index--) {
    nextShared[index] = next;
    next = positions.get(key(additions[index])) ?? next;
  }
  const buckets = new Map<number, T[]>();
  let previousSlot = 0;
  let previousShared = -1;
  for (let index = 0; index < additions.length; index++) {
    const entry = additions[index];
    const shared = positions.get(key(entry));
    if (shared !== undefined) { previousShared = Math.max(previousShared, shared); continue; }
    let slot = existing.length;
    if (hasOverlap && nextShared[index] > previousShared) {
      slot = nextShared[index];
    } else {
      const time = timestamp(entry);
      if (time !== null) {
        const later = existing.findIndex((prior, priorIndex) => {
          const priorTime = timestamp(prior);
          return priorIndex > previousShared && priorTime !== null && priorTime > time;
        });
        if (later >= 0) slot = later;
      }
    }
    slot = Math.max(previousSlot, slot);
    previousSlot = slot;
    const bucket = buckets.get(slot) ?? []; bucket.push(entry); buckets.set(slot, bucket);
  }
  const result: T[] = [];
  const emitted = new Set<ReturnType<typeof key>>();
  for (let index = 0; index <= existing.length; index++) {
    for (const entry of [...buckets.get(index) ?? [], ...(index < existing.length ? [existing[index]] : [])]) {
      const id = key(entry);
      if (!emitted.has(id)) { emitted.add(id); result.push(values.get(id)!); }
    }
  }
  if (result.length === incoming.length && result.every((entry, index) => entry === incoming[index])) return incoming;
  if (result.length === existing.length && result.every((entry, index) => entry === existing[index])) return existing;
  return result;
}

/** Content revisions and delivery metadata have different authorities from order. */
export function mergeTranscriptSources(existing: MobileTranscriptEntry[], incoming: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  return mergeOrderedEntries(existing, incoming, (prior, next) => {
    const newest = (prior.persistedVersion ?? 0) > (next.persistedVersion ?? 0) ? prior : next;
    return preserveDeliveryConfirmation(prior, preserveVoiceCaption(prior, newest));
  });
}
