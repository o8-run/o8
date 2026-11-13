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

/** Position is pagination only. Identity excludes it so inserted lane events and
 * a sliding runtime tail cannot rename retained rows. Checkpoint the whole prefix
 * so an insertion before the cursor also invalidates an otherwise valid offset. */
export function transcriptWindow(events: TranscriptEvent[], cursor: number, limit: number, tail: boolean, token: string | null) {
  const occurrences = new Map<string, number>();
  const identified = events.map(event => {
    const key = identity(event);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    const durable = (event as TranscriptEvent & { eventId?: string }).eventId
;
    return { ...event, eventId: durable ?? `${key}:${occurrence}` };
  });
  const checkpoint = (offset: number) => digest(identified.slice(0, offset).map(e => JSON.stringify(content(e, false))).join('\n'));
  const cursorReset = token !== null && (cursor > identified.length || (cursor > 0 && token !== checkpoint(cursor)));
  const from = cursorReset ? 0 : cursor;
  const windowed = tail ? identified.slice(-limit) : identified.filter(event => event.seq > from).slice(0, limit);
  const nextCursor = windowed.at(-1)?.seq ?? null;
  return { events: windowed, nextCursor, cursorToken: checkpoint(nextCursor ?? from), cursorReset };
}
