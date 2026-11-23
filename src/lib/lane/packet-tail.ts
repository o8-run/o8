import { getSqlite } from '@/lib/db';
import { resolvePortInfo } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import type { LaneEvent, LaneEventActor, LaneEventVerb, LaneStatus } from './types';

export const PACKET_TAIL_SCHEMA = 'o8/lane.event/v1' as const;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_TIMEOUT_MS = 25_000;
const PACKET_TAIL_INTERNAL_TIMEOUT_MS = 2_000;

interface PacketTailRow {
  id: string;
  lane_id: string;
  verb: string;
  actor: string;
  payload_json: string;
  timestamp: string;
  lane_packet_id: string | null;
  lane_status: string | null;
}

interface LanePacketRow {
  packet_id: string | null;
  status: string | null;
}

export interface PacketTailEvent {
  schema: typeof PACKET_TAIL_SCHEMA;
  id: string;
  packetId: string;
  laneId: string;
  verb: LaneEventVerb | string;
  actor: LaneEventActor | string;
  event?: string;
  status?: LaneStatus | string;
  timestamp: string;
  timestampMs: number;
  payload: Record<string, unknown>;
}

export interface PacketTailBatch {
  events: PacketTailEvent[];
  nextSince: number;
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payloadJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed historical rows; callers still get the lane event.
  }
  return {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function timestampMs(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeSince(since: unknown): number {
  const value = typeof since === 'number' ? since : Number(since);
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function normalizeLimit(limit: unknown): number {
  const value = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(value));
}

function normalizeTimeoutMs(timeoutMs: unknown): number {
  const value = typeof timeoutMs === 'number' ? timeoutMs : Number(timeoutMs);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_TIMEOUT_MS, Math.floor(value));
}

function mapTailRow(row: PacketTailRow, fallbackPacketId?: string): PacketTailEvent | null {
  const payload = parsePayload(row.payload_json);
  const packetId = stringValue(payload.packetId) ?? stringValue(row.lane_packet_id) ?? fallbackPacketId;
  if (!packetId) return null;

  const event = stringValue(payload.event);
  const status = stringValue(payload.status) ?? stringValue(row.lane_status);

  return {
    schema: PACKET_TAIL_SCHEMA,
    id: row.id,
    packetId,
    laneId: row.lane_id,
    verb: row.verb,
    actor: row.actor,
    ...(event ? { event } : {}),
    ...(status ? { status } : {}),
    timestamp: row.timestamp,
    timestampMs: timestampMs(row.timestamp),
    payload,
  };
}

function nextSinceFor(events: PacketTailEvent[], fallback: number): number {
  if (events.length === 0) return fallback;
  return events.reduce((max, event) => Math.max(max, event.timestampMs), fallback);
}

export function resolvePacketTailPacketId(idOrPacketId: string): string | null {
  const trimmed = idOrPacketId.trim();
  if (!trimmed) return null;

  const row = getSqlite()
    .prepare('SELECT packet_id, status FROM lanes WHERE id = ?')
    .get(trimmed) as LanePacketRow | undefined;
  return stringValue(row?.packet_id) ?? trimmed;
}

export function listPacketTailEvents(
  packetId: string,
  options: { since?: number; limit?: number } = {},
): PacketTailEvent[] {
  const normalizedPacketId = packetId.trim();
  if (!normalizedPacketId) return [];

  const since = normalizeSince(options.since ?? 0);
  const limit = normalizeLimit(options.limit ?? DEFAULT_LIMIT);
  const sinceIso = since > 0 ? new Date(since).toISOString() : null;

  const rows = getSqlite()
    .prepare(`
      SELECT
        e.id,
        e.lane_id,
        e.verb,
        e.actor,
        e.payload_json,
        e.timestamp,
        l.packet_id AS lane_packet_id,
        l.status AS lane_status
      FROM lane_events e
      JOIN lanes l ON l.id = e.lane_id
      WHERE (
        l.packet_id = @packetId
        OR json_extract(e.payload_json, '$.packetId') = @packetId
        OR e.lane_id IN (
          SELECT lane_id
          FROM lane_events
          WHERE json_extract(payload_json, '$.packetId') = @packetId
        )
      )
        AND (@sinceIso IS NULL OR e.timestamp > @sinceIso)
      ORDER BY e.timestamp ASC, e.id ASC
      LIMIT @limit
    `)
    .all({ packetId: normalizedPacketId, sinceIso, limit }) as PacketTailRow[];

  return rows
    .map((row) => mapTailRow(row, normalizedPacketId))
    .filter((event): event is PacketTailEvent => event !== null);
}

export async function getPacketTailBatch(options: {
  packetId: string;
  since?: number;
  limit?: number;
  timeoutMs?: number;
}): Promise<PacketTailBatch> {
  const packetId = options.packetId.trim();
  const since = normalizeSince(options.since ?? 0);
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs ?? 0);
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const events = listPacketTailEvents(packetId, {
      since,
      limit: options.limit,
    });
    if (events.length > 0 || timeoutMs === 0 || Date.now() >= deadline) {
      return {
        events,
        nextSince: nextSinceFor(events, since),
      };
    }

    const waitMs = Math.min(DEFAULT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (waitMs <= 0) {
      return { events: [], nextSince: since };
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

export function buildPacketTailEventForLaneEvent(event: LaneEvent): PacketTailEvent | null {
  const lane = getSqlite()
    .prepare('SELECT packet_id, status FROM lanes WHERE id = ?')
    .get(event.laneId) as LanePacketRow | undefined;
  const packetId = stringValue(event.payload.packetId) ?? stringValue(lane?.packet_id);
  if (!packetId) return null;

  const row: PacketTailRow = {
    id: event.id,
    lane_id: event.laneId,
    verb: event.verb,
    actor: event.actor,
    payload_json: JSON.stringify(event.payload),
    timestamp: event.timestamp,
    lane_packet_id: packetId,
    lane_status: lane?.status ?? null,
  };
  return mapTailRow(row);
}

export function publishPacketTailEvent(event: LaneEvent): void {
  const packetEvent = buildPacketTailEventForLaneEvent(event);
  if (!packetEvent) return;

  void postInternalPacketTailEvent(packetEvent).catch(() => {
    // Best-effort: HTTP/MCP/CLI long-poll can still recover from SQLite.
  });
}

async function postInternalPacketTailEvent(event: PacketTailEvent): Promise<void> {
  const { wsPort } = resolvePortInfo();
  await fetch(`http://127.0.0.1:${wsPort}/internal/packet-tail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getOrCreateWsToken()}`,
      'Content-Type': 'application/json',
      // The server's own lane writes are not someone using o8. Without this, every
      // event a background loop recorded (a refused retirement's close_timing, a
      // review-stall pass) woke the idle gate and kept every loop running.
      'x-o8-background': '1',
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(PACKET_TAIL_INTERNAL_TIMEOUT_MS),
  });
}
