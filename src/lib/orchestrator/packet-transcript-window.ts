import { createHash } from 'node:crypto';
import type { TranscriptEvent } from './transcript-normalizer';

function identity(event: TranscriptEvent): string {
  const durable = (event as TranscriptEvent & { eventId?: string }).eventId;
  if (durable) return durable;
  // Missing runtime identity is a multiset: repeated equal events are distinct.
  return digest(JSON.stringify(content(event)));

}

function content(event: TranscriptEvent, identity = true) {
  const callId = 'callId' in event ? event.callId : undefined;
  const synthetic = callId !== undefined && (/^tool-\d+$/.test(callId) || callId.includes('-synthetic-'));
  const nativeTimestamp = (event as TranscriptEvent & { nativeTimestamp?: string }).nativeTimestamp;
  const fields = { ...event, seq: undefined, ts: nativeTimestamp ?? event.ts, ...(identity && synthetic ? { callId: undefined } : {}) };
  return Object.fromEntries(Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)));
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** A native page ends at whichever comes first. The native client refuses a
 * single reply over 16 MiB, so a page of serialized events stays well below it
 * while the client's total readback budget spans several pages. */
export const NATIVE_PAGE_EVENTS = 5_000;
export const NATIVE_PAGE_BYTES = 8 * 1024 * 1024;

/** Position is pagination only. Identity excludes it so inserted lane events and
 * a sliding runtime tail cannot rename retained rows. Checkpoint the whole prefix
 * so an insertion before the cursor also invalidates an otherwise valid offset. */
export function transcriptWindow(events: TranscriptEvent[], cursor: number, limit: number, tail: boolean, token: string | null) {
  const occurrences = new Map<string, number>();
  const identified = events.map(event => {
    const key = identity(event);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    const durable = (event as TranscriptEvent & { eventId?: string }).eventId;
    return { ...event, eventId: durable ?? `${key}:${occurrence}` };
  });
  const checkpoints = new Map<number, string>();
  const checkpoint = (offset: number) => {
    let value = checkpoints.get(offset);
    if (value === undefined) {
      value = digest(identified.slice(0, offset).map(e => JSON.stringify(content(e, false))).join('\n'));
      checkpoints.set(offset, value);
    }
    return value;
  };
  const cursorReset = token !== null && (cursor > identified.length || (cursor > 0 && token !== checkpoint(cursor)));
  const from = cursorReset ? 0 : cursor;
  const native = token !== null;
  const windowed = tail ? identified.slice(-limit) : page(identified.filter(event => event.seq > from), Math.min(limit, native ? NATIVE_PAGE_EVENTS : limit), native);
  const nextCursor = windowed.at(-1)?.seq
    ?? (native && identified.length > 0 && !cursorReset ? from : null);
  return {
    events: windowed, nextCursor, cursorToken: checkpoint(nextCursor ?? from), cursorReset,
    ...(native ? { hasMore: !tail && identified.some(event => event.seq > (nextCursor ?? from)) } : {}),
  };
}

/** Legacy pages end at their event limit only. A native page also ends at the
 * byte budget, and always carries at least one event when any remain. */
function page<T>(remaining: T[], limit: number, native: boolean): T[] {
  if (!native) return remaining.slice(0, limit);
  let bytes = 0;
  let count = 0;
  for (const event of remaining.slice(0, limit)) {
    bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
    if (count > 0 && bytes > NATIVE_PAGE_BYTES) break;
    count += 1;
  }
  return remaining.slice(0, count);
}
