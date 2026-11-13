import { createHash } from 'node:crypto';
import type { TranscriptEvent } from './transcript-normalizer';

function identity(event: TranscriptEvent): string {
  const durable = (event as TranscriptEvent & { eventId?: string }).eventId;
  if (durable) return durable;
  if ((event.type === 'tool_call' || event.type === 'tool_result') && event.callId && !/^tool-\d+$|synthetic/.test(event.callId)) {
    return digest(JSON.stringify({ type: event.type, callId: event.callId, ts: event.ts }));
  }
  return digest(JSON.stringify({ ...event, seq: undefined, ...('callId' in event && /^tool-\d+$|synthetic/.test(event.callId ?? '') ? { callId: undefined } : {}) }));
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Position is pagination only. Identity excludes it so inserted lane events and
 * a sliding runtime tail cannot rename retained rows. Checkpoint the whole prefix
 * so an insertion before the cursor also invalidates an otherwise valid offset. */
export function transcriptWindow(events: TranscriptEvent[], cursor: number, limit: number, tail: boolean, token: string | null) {
  const identified = events.map(event => ({
    ...event,
    eventId: identity(event),
  }));
  const checkpoint = (offset: number) => digest(identified.slice(0, offset).map(e => JSON.stringify({ ...e, seq: undefined })).join('\n'));
  const cursorReset = cursor > identified.length || (cursor > 0 && token !== null && token !== checkpoint(cursor));
  const from = cursorReset ? 0 : cursor;
  const windowed = tail ? identified.slice(-limit) : identified.slice(from, from + limit);
  const nextCursor = windowed.at(-1)?.seq ?? from;
  return { events: windowed, nextCursor, cursorToken: checkpoint(nextCursor), cursorReset };
}
