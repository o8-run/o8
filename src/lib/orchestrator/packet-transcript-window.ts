import { createHash } from 'node:crypto';
import type { TranscriptEvent } from './transcript-normalizer';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Position is pagination only. Identity excludes it so inserted lane events and
 * a sliding runtime tail cannot rename retained rows. Checkpoint the whole prefix
 * so an insertion before the cursor also invalidates an otherwise valid offset. */
export function transcriptWindow(events: TranscriptEvent[], cursor: number, limit: number, tail: boolean, token: string | null) {
  const identified = events.map(event => ({
    ...event,
    eventId: digest(JSON.stringify({ ...event, seq: undefined })),
  }));
  const checkpoint = (offset: number) => digest(identified.slice(0, offset).map(e => e.eventId).join('\n'));
  const cursorReset = cursor > identified.length || (cursor > 0 && token !== null && token !== checkpoint(cursor));
  const from = cursorReset ? 0 : cursor;
  const windowed = tail ? identified.slice(-limit) : identified.slice(from, from + limit);
  const nextCursor = windowed.at(-1)?.seq ?? from;
  return { events: windowed, nextCursor, cursorToken: checkpoint(nextCursor), cursorReset };
}
