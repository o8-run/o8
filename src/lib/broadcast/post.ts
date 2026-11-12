import 'server-only';

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { RequestPrincipalContext } from '@/lib/auth/principal';
import { getSqlite } from '@/lib/db';
import { ensureV45BroadcastFocusSchema } from '@/lib/db/v45-broadcast-focus-migration';

export const BROADCAST_TEXT_MAX_LENGTH = 2_000;
export const BROADCAST_FOCUS_TITLE_MAX_LENGTH = 120;
export const BROADCAST_FOCUS_GOAL_MAX_LENGTH = 400;
const LABEL_MAX_LENGTH = 160;

export type PostedBroadcastKind = 'commentary' | 'conversation' | 'focus';

export type BroadcastPostInput = {
  kind: 'commentary' | 'conversation';
  actor: string;
  audience?: string | null;
  text: string;
  refs?: { laneId?: string | null; packetId?: string | null } | null;
} | {
  kind: 'focus';
  actor?: string;
  title?: string;
  goal?: string | null;
  issue?: number | null;
  clear?: boolean;
};

interface PostedBroadcastEventBase {
  schema: 'o8/broadcast.posted-event/v1';
  id: string;
  actor: string;
  timestamp: string;
}

export interface PostedBroadcastFeedEvent extends PostedBroadcastEventBase {
  kind: 'commentary' | 'conversation';
  audience: string | null;
  text: string;
  refs: {
    laneId: string | null;
    packetId: string | null;
  };
}

export interface PostedBroadcastFocusEvent extends PostedBroadcastEventBase {
  kind: 'focus';
  title: string | null;
  goal: string | null;
  issue: number | null;
  startedAt: string | null;
  cleared: boolean;
}

export type PostedBroadcastEvent = PostedBroadcastFeedEvent | PostedBroadcastFocusEvent;

export class BroadcastPostError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'BroadcastPostError';
  }
}

function requiredText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BroadcastPostError(`${name} is required.`, `invalid_${name}`, 400);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new BroadcastPostError(
      `${name} must be at most ${maxLength.toLocaleString()} characters.`,
      `invalid_${name}`,
      400,
    );
  }
  return normalized;
}

function optionalText(value: unknown, name: string, maxLength = LABEL_MAX_LENGTH): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new BroadcastPostError(`${name} must be a string.`, `invalid_${name}`, 400);
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new BroadcastPostError(
      `${name} must be at most ${maxLength} characters.`,
      `invalid_${name}`,
      400,
    );
  }
  return normalized;
}

function optionalIssue(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new BroadcastPostError('issue must be a positive integer.', 'invalid_issue', 400);
  }
  return Number(value);
}

function normalizeRefs(value: unknown): { laneId: string | null; packetId: string | null } {
  if (value === undefined || value === null) return { laneId: null, packetId: null };
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new BroadcastPostError('refs must be an object.', 'invalid_refs', 400);
  }
  const refs = value as Record<string, unknown>;
  return {
    laneId: optionalText(refs.laneId, 'laneId'),
    packetId: optionalText(refs.packetId, 'packetId'),
  };
}

export function appendBroadcastEvent(
  input: BroadcastPostInput,
  options: {
    sqlite?: Database.Database;
    now?: Date;
    metadata?: Record<string, unknown>;
  } = {},
): PostedBroadcastEvent {
  if (input.kind !== 'commentary' && input.kind !== 'conversation' && input.kind !== 'focus') {
    throw new BroadcastPostError(
      'kind must be commentary, conversation, or focus.',
      'invalid_kind',
      400,
    );
  }
  const timestamp = (options.now ?? new Date()).toISOString();
  const sqlite = options.sqlite ?? getSqlite();
  ensureV45BroadcastFocusSchema(sqlite);
  if (input.kind === 'focus') {
    const cleared = input.clear === true;
    if (input.clear !== undefined && typeof input.clear !== 'boolean') {
      throw new BroadcastPostError('clear must be a boolean.', 'invalid_clear', 400);
    }
    const actor = requiredText(input.actor ?? 'operator', 'actor', LABEL_MAX_LENGTH);
    const title = cleared ? null : requiredText(input.title, 'title', BROADCAST_FOCUS_TITLE_MAX_LENGTH);
    const goal = cleared ? null : optionalText(input.goal, 'goal', BROADCAST_FOCUS_GOAL_MAX_LENGTH);
    const issue = cleared ? null : optionalIssue(input.issue);
    const event: PostedBroadcastFocusEvent = {
      schema: 'o8/broadcast.posted-event/v1',
      id: `broadcast-${randomUUID()}`,
      kind: 'focus',
      actor,
      title,
      goal,
      issue,
      startedAt: cleared ? null : timestamp,
      cleared,
      timestamp,
    };
    sqlite.prepare(`
      INSERT INTO broadcast_events
        (id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
      VALUES (?, 'focus', ?, NULL, ?, NULL, NULL, ?, ?)
    `).run(
      event.id,
      event.actor,
      event.title ?? 'Focus cleared',
      JSON.stringify({
        ...options.metadata,
        title: event.title,
        goal: event.goal,
        issue: event.issue,
        startedAt: event.startedAt,
        cleared: event.cleared,
      }),
      event.timestamp,
    );
    return event;
  }
  const actor = requiredText(input.actor, 'actor', LABEL_MAX_LENGTH);
  const audience = optionalText(input.audience, 'audience');
  const text = requiredText(input.text, 'text', BROADCAST_TEXT_MAX_LENGTH);
  const refs = normalizeRefs(input.refs);
  const event: PostedBroadcastFeedEvent = {
    schema: 'o8/broadcast.posted-event/v1',
    id: `broadcast-${randomUUID()}`,
    kind: input.kind,
    actor,
    audience,
    text,
    refs,
    timestamp,
  };
  sqlite.prepare(`
    INSERT INTO broadcast_events
      (id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.kind,
    event.actor,
    event.audience,
    event.text,
    event.refs.laneId,
    event.refs.packetId,
    JSON.stringify(options.metadata ?? {}),
    event.timestamp,
  );
  return event;
}

export function handleBroadcastPost(
  input: unknown,
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
): PostedBroadcastEvent {
  if (principal.role !== 'operator' && principal.role !== 'worker') {
    throw new BroadcastPostError(
      'Broadcast posting requires an operator or packet-bound worker credential.',
      'broadcast_post_forbidden',
      403,
    );
  }
  if (principal.role === 'worker' && !principal.packetId) {
    throw new BroadcastPostError(
      'Broadcast posting requires a packet-bound worker credential.',
      'broadcast_packet_worker_required',
      403,
    );
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BroadcastPostError('A JSON object is required.', 'invalid_broadcast_post', 400);
  }
  const body = input as Record<string, unknown>;
  if (body.kind === 'focus') {
    if (principal.role !== 'operator') {
      throw new BroadcastPostError(
        'Broadcast focus changes require an operator credential.',
        'broadcast_focus_forbidden',
        403,
      );
    }
    return appendBroadcastEvent({
      kind: 'focus',
      actor: typeof body.actor === 'string' ? body.actor : undefined,
      title: body.title as string | undefined,
      goal: body.goal as string | null | undefined,
      issue: body.issue as number | null | undefined,
      clear: body.clear as boolean | undefined,
    }, { sqlite });
  }
  const refs = normalizeRefs(body.refs);
  if (principal.role === 'worker') {
    if (refs.packetId && refs.packetId !== principal.packetId) {
      throw new BroadcastPostError(
        'A worker can post only for its bound packet.',
        'worker_packet_mismatch',
        403,
      );
    }
    if (refs.laneId && !sqlite.prepare('SELECT id FROM lanes WHERE id = ? AND packet_id = ?')
      .get(refs.laneId, principal.packetId)) {
      throw new BroadcastPostError(
        'A worker can post only for a lane of its bound packet.',
        'worker_lane_mismatch',
        403,
      );
    }
    refs.packetId = principal.packetId;
  }
  return appendBroadcastEvent({
    kind: body.kind as 'commentary' | 'conversation',
    actor: principal.role === 'worker' ? `worker:${principal.packetId}` : body.actor as string,
    audience: body.audience as string | null | undefined,
    text: body.text as string,
    refs,
  }, { sqlite });
}

export function handleBroadcastSay(
  input: unknown,
  principal: RequestPrincipalContext,
  sqlite: Database.Database = getSqlite(),
): PostedBroadcastFeedEvent {
  if (principal.role !== 'operator') {
    throw new BroadcastPostError(
      'Broadcast speech requires an operator credential.',
      'broadcast_say_forbidden',
      403,
    );
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BroadcastPostError('A JSON object is required.', 'invalid_broadcast_say', 400);
  }
  const body = input as Record<string, unknown>;
  return appendBroadcastEvent({
    kind: 'commentary',
    actor: 'symon',
    text: body.text as string,
  }, {
    sqlite,
    metadata: {
      speechPriority: true,
      onDemand: true,
      provenance: {
        rule: 'operator-requested',
        reason: 'The operator explicitly requested this spoken line.',
        sources: [],
      },
    },
  }) as PostedBroadcastFeedEvent;
}

export function appendBroadcastSpeakerQueueDrop(
  droppedEventId: string,
  options: { sqlite?: Database.Database; now?: Date } = {},
): string {
  const sqlite = options.sqlite ?? getSqlite();
  ensureV45BroadcastFocusSchema(sqlite);
  const id = `broadcast-${randomUUID()}`;
  const timestamp = (options.now ?? new Date()).toISOString();
  sqlite.prepare(`
    INSERT INTO broadcast_events
      (id, kind, actor, audience, text, lane_id, packet_id, metadata_json, created_at)
    VALUES (?, 'commentary', 'symon', NULL, ?, NULL, NULL, ?, ?)
  `).run(
    id,
    'Broadcast voice dropped the oldest queued line.',
    JSON.stringify({ droppedEventId, speakerQueueDrop: true, speechSuppressed: true }),
    timestamp,
  );
  return id;
}
