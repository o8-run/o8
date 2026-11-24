import 'server-only';

import type Database from 'better-sqlite3';

import { ensureV44BroadcastSchema } from '@/lib/db/v44-broadcast-migration';
import { broadcastEventSpecifics } from './commentary-prompt';
import type { BroadcastEvent } from './types';

/**
 * A spoken line is heard, not read. 260 characters is roughly two short
 * sentences — long enough to carry a verdict plus its evidence, short enough
 * that a listener absorbs it without a transcript.
 */
export const BROADCAST_SPOKEN_MAX_LENGTH = 260;

/**
 * How long a narrated fact stays suppressed. The old 30s window was shorter
 * than the interval at which the same packet's review verdict legitimately
 * re-fires (a re-review lands minutes later, and the approval-side row trails
 * the lane-side row), so every re-emission was narrated again.
 */
export const NARRATION_REPETITION_WINDOW_MS = 30 * 60_000;

/** Ids and hashes are unspeakable — they belong on screen, never in the voice. */
const ID_TOKEN_PATTERN = /\b(?:pkt|packet|lane|approval|evt|mission|session|review-turn)-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{4,}/gi;
const SHA_TOKEN_PATTERN = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g;

export function isMomentEvent(event: BroadcastEvent): boolean {
  return event.kind === 'merge'
    || (event.kind === 'approval' && event.payload.status === 'pending')
    || event.kind === 'operator_attention'
    || event.kind === 'calendar_imminent'
    || event.kind === 'scheduled_attention'
    || event.kind === 'review_verdict'
    || event.kind === 'packet_failed'
    || event.kind === 'spend_cap'
    || event.kind === 'lease_timeout'
    || event.kind === 'agent_completed';
}

/**
 * The identity of the fact an event carries, independent of which table it
 * arrived from. One packet's "changes requested" verdict reaches the feed as a
 * lane row AND an approval row; both must collapse to the same key or the same
 * verdict gets spoken twice.
 */
export function momentFactKey(event: BroadcastEvent): string {
  const specifics = broadcastEventSpecifics(event, null);
  const identity = event.packetId
    ?? event.laneId
    ?? String(specifics.issue ?? event.title);
  if (event.kind === 'review_verdict') return `review:${identity}:${String(specifics.approved ?? 'pending')}`;
  if (event.kind === 'approval') return `approval:${identity}:${String(event.payload.status ?? '')}:${event.detail ?? ''}`;
  if (event.kind === 'spend_cap') {
    return `spend:${identity}:${String(specifics.costUsd ?? specifics.inputTokens ?? '')}`;
  }
  if (event.kind === 'lease_timeout') return `lease_timeout:${identity}:${String(specifics.resource ?? event.detail ?? '')}`;
  return `${event.kind}:${identity}`;
}

/** True when this commentary row is a generated voice line rather than feed input. */
export function isGeneratedCommentary(event: BroadcastEvent): boolean {
  return event.kind === 'commentary' && (
    event.actor === 'mister'
    || Boolean(event.payload.voiceTrigger)
    || Boolean(event.payload.director)
    || Boolean(event.payload.speakerQueueSummary)
    || Boolean(event.payload.speakerQueueDrop)
  );
}

/**
 * The shared suppression view. Every narrator (the interval director and the
 * moment speaker) records the fact keys it narrated on its commentary row, and
 * every narrator reads this before narrating — so a fact voiced by one is not
 * voiced again by the other, and a restart does not replay what was just said.
 */
export function narratedFactKeysSince(sqlite: Database.Database, sinceIso: string): Set<string> {
  ensureV44BroadcastSchema(sqlite);
  const rows = sqlite.prepare(`
    SELECT metadata_json AS metadata
    FROM broadcast_events
    WHERE kind = 'commentary'
      AND created_at >= ?
      AND json_extract(metadata_json, '$.factKeys') IS NOT NULL
  `).all(sinceIso) as Array<{ metadata: string }>;
  const keys = new Set<string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.metadata) as { factKeys?: unknown };
      if (!Array.isArray(parsed.factKeys)) continue;
      for (const key of parsed.factKeys) {
        if (typeof key === 'string' && key) keys.add(key);
      }
    } catch {
      continue;
    }
  }
  return keys;
}

export function narrationWindowStart(now: Date): string {
  return new Date(now.getTime() - NARRATION_REPETITION_WINDOW_MS).toISOString();
}

/** Clip to a whole word, never mid-word, and never past `maxLength`. */
function clipPhrase(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  const cut = normalized.slice(0, maxLength - 1);
  const boundary = cut.lastIndexOf(' ');
  return `${(boundary > maxLength * 0.5 ? cut.slice(0, boundary) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

/**
 * Final gate on anything the voice says: no ids, no shas, no runaway length.
 * Applies to generated lines from every narrator, whatever built them.
 */
export function speakableText(value: string, maxLength = BROADCAST_SPOKEN_MAX_LENGTH): string {
  const stripped = value
    .replace(ID_TOKEN_PATTERN, '')
    .replace(SHA_TOKEN_PATTERN, '')
    .replace(/\(\s*\)|\[\s*\]|“\s*”/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])\s*([.!?])/g, '$2')
    .replace(/([.!?])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= maxLength) return stripped;
  const cut = stripped.slice(0, maxLength);
  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (sentenceEnd > maxLength * 0.5) return cut.slice(0, sentenceEnd + 1).trim();
  return clipPhrase(cut, maxLength);
}
