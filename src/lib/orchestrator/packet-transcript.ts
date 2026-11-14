import { access, open, readdir, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { getCodexRolloutPath } from '@/lib/codex/sessions';
import { getOwnedCodexSessionIdentityId, getOwnedCodexTelemetrySources } from '@/lib/codex/owned';
import { getOwnedClaudeCodeTelemetrySources } from '@/lib/claude-code/owned';
import { getOwnedGeminiTelemetrySources } from '@/lib/gemini/owned';
import { readLaneTerminalReason, type LaneTerminalReason } from '@/lib/lane/terminal-reason';
import { findLatestLaneByPacket, getLaneEvents, listLanes } from '@/lib/lane/registry';
import { getSqlite } from '@/lib/db';
import { operatorSteerFailure, QUEUED_STEER_NOTE } from '@/lib/orchestrator/operator-mission-service/steer-queue';
import { getOwnedOpencodeTelemetrySources } from '@/lib/opencode/owned';
import { readOwnedPiBuiltinTelemetryTail } from '@/lib/pi-builtin/telemetry';
import { readOrchestratorControlPlaneState } from '@/lib/orchestrator/control-plane';
import { createCodexEventNormalizer, normalizeCodexEvents, type TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
import {
  normalizeClaudeCodeEvents,
  normalizeOpencodeEvents,
} from '@/lib/orchestrator/transcript-normalizer-multi';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { normalizePiBuiltinEvents } from '@/lib/orchestrator/transcript-normalizer-pi';

const MAX_TAIL_BYTES = 256_000;

type TranscriptRuntime = 'codex' | 'opencode' | 'claude-code' | 'gemini' | 'pi-builtin' | null;

interface ResolvedJsonl {
  raw: string;
  events?: TranscriptEvent[];
  runtime: TranscriptRuntime;
  fallbackTimestamp?: string;
  unsupportedReason?: string;
  historyComplete?: boolean;
  earliestEventTime?: string;
}

interface RawTailSnapshot {
  raw: string;
  modifiedAt?: string;
}

export interface SessionTranscriptReadback {
  sessionKey: string;
  runtime: TranscriptRuntime;
  events: TranscriptEvent[];
  unsupportedReason?: string;
  historyComplete?: boolean;
  earliestEventTime?: string;
}

export interface PacketTranscriptReadback extends SessionTranscriptReadback {
  packetId: string;
  note?: string;
  terminalReason?: LaneTerminalReason | null;
}

type LaneSteerTranscriptEvent = Extract<TranscriptEvent, { type: 'steer' }>;
type LaneHuddleTranscriptEvent = Extract<TranscriptEvent, { type: 'assistant' }>;

function findPacket(packetId: string): OrchestratorPacket | null {
  try {
    const mission = readOrchestratorControlPlaneState();
    return mission.packets.find((packet) => packet.id === packetId) ?? null;
  } catch {
    return null;
  }
}

async function readRawTailSnapshot(filePath: string, maxBytes = MAX_TAIL_BYTES): Promise<RawTailSnapshot> {
  try {
    const resolved = await realpath(filePath);
    const handle = await open(resolved, 'r');
    try {
      const stat = await handle.stat();
      const bytesToRead = Math.min(stat.size, maxBytes);
      if (bytesToRead <= 0) return { raw: '', modifiedAt: stat.mtime.toISOString() };
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, stat.size - bytesToRead);
      return { raw: buffer.toString('utf8'), modifiedAt: stat.mtime.toISOString() };
    } finally {
      await handle.close();
    }
  } catch {
    return { raw: '' };
  }
}

async function readRawTail(filePath: string, maxBytes = MAX_TAIL_BYTES): Promise<string> {
  return (await readRawTailSnapshot(filePath, maxBytes)).raw;
}

async function readOwnedRunStdouts(stdoutPaths: string[]): Promise<RawTailSnapshot> {
  const chunks: string[] = [];
  let budget = MAX_TAIL_BYTES;
  let modifiedAt: string | undefined;
  for (const stdoutPath of [...stdoutPaths].reverse()) {
    if (budget <= 0) break;
    const snapshot = await readRawTailSnapshot(stdoutPath, budget);
    if (!modifiedAt && snapshot.modifiedAt) modifiedAt = snapshot.modifiedAt;
    if (snapshot.raw) {
      chunks.unshift(snapshot.raw);
      budget -= Buffer.byteLength(snapshot.raw, 'utf8');
    }
  }
  return { raw: chunks.join('\n'), modifiedAt };
}

async function findClaudeCodeJsonl(sessionId: string): Promise<string | null> {
  const claudeHome = process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const projectsDir = path.join(claudeHome, 'projects');
  let dirs: string[] = [];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue searching other encoded project directories.
    }
  }
  return null;
}

/** Stream complete Codex history without retaining raw tool payloads in memory. */
async function readCodexHistory(paths: string[], native = false): Promise<TranscriptEvent[]> {
  const normalizer = createCodexEventNormalizer(undefined, native);
  for (const filePath of paths) {
    const handle = await open(await realpath(filePath), 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0) continue;
      // Fix the snapshot end so an actively growing log cannot prolong this request.
      const stream = handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) normalizer.append(line);
      } finally {
        lines.close();
        stream.destroy();
      }
    } finally {
      await handle.close();
    }
  }
  return normalizer.events;
}

async function resolveRawJsonlForSession(sessionKey: string, fullHistory = false, native = false): Promise<ResolvedJsonl> {
  if (!sessionKey) return { raw: '', runtime: null };

  if (sessionKey.startsWith('pi-builtin-owned:')) {
    const tail = await readOwnedPiBuiltinTelemetryTail(sessionKey);
    return { raw: tail.raw, runtime: 'pi-builtin' };
  }

  if (sessionKey.startsWith('codex-owned:')) {
    try {
      const sources = await getOwnedCodexTelemetrySources(sessionKey);
      if (!sources) return { raw: '', runtime: 'codex' };
      // Exec stdout omits event times. Its bound rollout retains the original
      // event timestamps and call identities, including after the pane reopens.
      if (sources.threadId) try {
        const identityId = await getOwnedCodexSessionIdentityId(sessionKey);
        const rolloutPath = await getCodexRolloutPath(`codex:${sources.threadId}`, identityId ?? undefined);
        if (fullHistory && rolloutPath) {
          const events = await readCodexHistory([rolloutPath], native);
          if (events.length) return { raw: '', events, runtime: 'codex', historyComplete: true };
        }
        const raw = rolloutPath ? await readRawTail(rolloutPath) : '';
        if (raw.trim()) return { raw, runtime: 'codex' };
      } catch {
        // A missing runtime inventory must not hide the owned stdout fallback.
      }
      const tail = await readOwnedRunStdouts(sources.stdoutPaths);
      if (fullHistory) return { raw: '', events: await readCodexHistory(sources.stdoutPaths, native), runtime: 'codex', historyComplete: true };
      return { raw: tail.raw, runtime: 'codex', fallbackTimestamp: tail.modifiedAt };
    } catch {
      return { raw: '', runtime: 'codex' };
    }
  }

  if (sessionKey.startsWith('codex:') || sessionKey.startsWith('codex-discovered:')) {
    try {
      const rolloutPath = await getCodexRolloutPath(sessionKey);
      if (!rolloutPath) return { raw: '', runtime: 'codex' };
      if (fullHistory) return { raw: '', events: await readCodexHistory([rolloutPath], native), runtime: 'codex', historyComplete: true };
      return { raw: await readRawTail(rolloutPath), runtime: 'codex' };
    } catch {
      return { raw: '', runtime: 'codex' };
    }
  }

  if (sessionKey.startsWith('opencode-owned:')) {
    try {
      const sources = await getOwnedOpencodeTelemetrySources(sessionKey);
      if (!sources) return { raw: '', runtime: 'opencode' };
      return { raw: (await readOwnedRunStdouts(sources.stdoutPaths)).raw, runtime: 'opencode' };
    } catch {
      return { raw: '', runtime: 'opencode' };
    }
  }

  if (sessionKey.startsWith('claude-code-owned:')) {
    try {
      const sources = await getOwnedClaudeCodeTelemetrySources(sessionKey);
      if (!sources) return { raw: '', runtime: 'claude-code' };
      return { raw: (await readOwnedRunStdouts(sources.stdoutPaths)).raw, runtime: 'claude-code' };
    } catch {
      return { raw: '', runtime: 'claude-code' };
    }
  }

  if (sessionKey.startsWith('claude-code:')) {
    try {
      const sessionId = sessionKey.replace('claude-code:', '');
      if (sessionId.startsWith('live-')) return { raw: '', runtime: 'claude-code' };
      const jsonlPath = await findClaudeCodeJsonl(sessionId);
      if (!jsonlPath) return { raw: '', runtime: 'claude-code' };
      return { raw: await readRawTail(jsonlPath), runtime: 'claude-code' };
    } catch {
      return { raw: '', runtime: 'claude-code' };
    }
  }

  if (sessionKey.startsWith('gemini-owned:')) {
    try {
      await getOwnedGeminiTelemetrySources(sessionKey);
    } catch {
      // Same unsupported response either way.
    }
    return {
      raw: '',
      runtime: 'gemini',
      unsupportedReason: 'gemini-transcript-not-supported-yet',
    };
  }

  if (sessionKey.startsWith('gemini:') || sessionKey.startsWith('gemini-discovered:')) {
    return {
      raw: '',
      runtime: 'gemini',
      unsupportedReason: 'gemini-transcript-not-supported-yet',
    };
  }

  return { raw: '', runtime: null };
}

function normalizeForRuntime(
  runtime: TranscriptRuntime,
  raw: string,
  fallbackTimestamp?: string,
  native = false,
): TranscriptEvent[] {
  if (!raw) return [];
  switch (runtime) {
    case 'pi-builtin':
      return normalizePiBuiltinEvents(raw).map(event => native ? { ...event, nativeTimestamp: event.ts === '1970-01-01T00:00:00.000Z' ? '' : event.ts } : event);
    case 'codex':
      return normalizeCodexEvents(raw, fallbackTimestamp, native);
    case 'opencode':
      return normalizeOpencodeEvents(raw, undefined, native);
    case 'claude-code':
      return normalizeClaudeCodeEvents(raw, undefined, native);
    default:
      return [];
  }
}

function readTextPayload(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function laneSteerEvents(laneId: string, native = false): LaneSteerTranscriptEvent[] {
  // Read intents separately so a long busy turn's delivery receipts cannot
  // paginate the original message out of the pane.
  const queued = getSqlite().prepare(`SELECT id, payload_json, timestamp FROM lane_events
    WHERE lane_id = ? AND verb = 'steered_packet'
      AND json_extract(payload_json, '$.deliveryState') = 'queued'
    ORDER BY rowid DESC LIMIT 100`).all(laneId) as Array<{ id: string; payload_json: string; timestamp: string }>;
  const events = [...new Map([
    ...getLaneEvents(laneId, 500),
    ...queued.map(row => ({ id: row.id, laneId, verb: 'steered_packet' as const,
      actor: 'orchestrator' as const, payload: JSON.parse(row.payload_json), timestamp: row.timestamp })),
  ].map(event => [event.id, event])).values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const intents = events.filter(event => event.verb === 'steered_packet');
  const failures = new Map<string, typeof events[number]>();
  for (const failure of events.filter(event => event.verb === 'steer_failed')) {
    const intent = failure.payload.steerEventId
      ? intents.find(event => event.id === failure.payload.steerEventId)
      : [...intents].reverse().find(event => failure.payload.clientMutationId
        ? event.payload.clientMutationId === failure.payload.clientMutationId
        : event.timestamp <= failure.timestamp && event.payload.message === failure.payload.message);
    if (intent) failures.set(intent.id, failure);
  }
  return events
    .filter(event => event.verb === 'steered_packet' || (event.verb === 'steer_failed'
      && ![...failures.values()].some(failure => failure.id === event.id)))
    .map((event, index) => {
      const source = readTextPayload(event.payload, 'source', 'actor') || event.actor || 'orchestrator';
      const text = readTextPayload(event.payload, 'message', 'text');
      const noteText = readTextPayload(event.payload, 'note', 'error');
      const stderrHead = readTextPayload(event.payload, 'stderrHead');
      const delivery = event.payload.deliveryState === 'queued'
        ? getSqlite().prepare(`SELECT payload_json FROM lane_events WHERE lane_id = ?
          AND verb = 'steer_delivery' AND json_extract(payload_json, '$.steerEventId') = ?
          ORDER BY rowid DESC LIMIT 1`).get(laneId, event.id) as { payload_json: string } | undefined
        : undefined;
      const receipt = delivery ? JSON.parse(delivery.payload_json) as { state: string; note: string } : null;
      const failure = failures.get(event.id);
      const failed = event.verb === 'steer_failed' || receipt?.state === 'failed' || Boolean(failure);
      const note = operatorSteerFailure(receipt?.note ?? (event.payload.deliveryState === 'queued'
        ? QUEUED_STEER_NOTE : failure
          ? [readTextPayload(failure.payload, 'note', 'error'), readTextPayload(failure.payload, 'stderrHead')].filter(Boolean).join('\n')
          : [noteText, stderrHead].filter(Boolean).join('\n')));
      return {
        seq: index + 1,
        ...(native ? { eventId: event.id } : {}),
        ts: event.timestamp,
        type: 'steer',
        source,
        text: text || note || 'Steer requested.',
        failed,
        ...(note ? { note } : {}),
      };
    });
}

function laneHuddleEvents(laneId: string, native = false): LaneHuddleTranscriptEvent[] {
  return getLaneEvents(laneId, 500)
    .filter((event) => event.verb === 'agent_report' && event.payload.event === 'huddle')
    .map((event, index) => {
      const message = readTextPayload(event.payload, 'message') || 'Huddle plan posted.';
      return {
        seq: index + 1,
        ...(native ? { eventId: event.id } : {}),
        ts: event.timestamp,
        type: 'assistant',
        text: message,
      };
    });
}

function laneSteerEventsForSession(sessionKey: string, native = false): LaneSteerTranscriptEvent[] {
  if (!sessionKey) return [];
  const lane = listLanes().find((candidate) => candidate.sessionKey === sessionKey);
  return lane ? laneSteerEvents(lane.id, native) : [];
}

function laneHuddleEventsForSession(sessionKey: string, native = false): LaneHuddleTranscriptEvent[] {
  if (!sessionKey) return [];
  const lane = listLanes().find((candidate) => candidate.sessionKey === sessionKey);
  return lane ? laneHuddleEvents(lane.id, native) : [];
}

function mergeTranscriptEvents(runtimeEvents: TranscriptEvent[], extraEvents: TranscriptEvent[]): TranscriptEvent[] {
  if (extraEvents.length === 0) return runtimeEvents;
  const stamped = [...runtimeEvents, ...extraEvents]
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftMs = new Date(left.event.ts).getTime();
      const rightMs = new Date(right.event.ts).getTime();
      const leftSafe = Number.isFinite(leftMs) ? leftMs : 0;
      const rightSafe = Number.isFinite(rightMs) ? rightMs : 0;
      return leftSafe - rightSafe || left.index - right.index;
    });
  return stamped.map(({ event }, index) => ({ ...event, seq: index + 1 }) as TranscriptEvent);
}

export function readSessionSteerTranscriptEvents(sessionKey: string, native = false): LaneSteerTranscriptEvent[] {
  return laneSteerEventsForSession(sessionKey, native);
}

export function readSessionHuddleTranscriptEvents(sessionKey: string, native = false): LaneHuddleTranscriptEvent[] {
  return laneHuddleEventsForSession(sessionKey, native);
}

export async function readSessionTranscriptEvents(sessionKey: string, fullHistory = false, native = false): Promise<SessionTranscriptReadback> {
  const resolved = await resolveRawJsonlForSession(sessionKey, fullHistory, native);
  if (resolved.unsupportedReason) {
    return {
      sessionKey,
      runtime: resolved.runtime,
      events: [],
      unsupportedReason: resolved.unsupportedReason,
    };
  }

  const runtimeEvents = resolved.events ?? normalizeForRuntime(resolved.runtime, resolved.raw, resolved.fallbackTimestamp, native);
  const earliest = runtimeEvents.map(event => Date.parse((event as TranscriptEvent & { nativeTimestamp?: string }).nativeTimestamp ?? event.ts)).filter(Number.isFinite);
  return {
    sessionKey,
    runtime: resolved.runtime,
    historyComplete: resolved.historyComplete === true,
    earliestEventTime: earliest.length ? new Date(earliest.reduce((a, b) => Math.min(a, b))).toISOString() : undefined,
    events: mergeTranscriptEvents(
      runtimeEvents,
      [...laneHuddleEventsForSession(sessionKey, native), ...laneSteerEventsForSession(sessionKey, native)],
    ),
  };
}

export async function readPacketTranscriptEvents(packetId: string, fullHistory = false, native = false): Promise<PacketTranscriptReadback> {
  const packet = findPacket(packetId);
  const packetSessionKey = packet?.lane?.sessionKey?.trim() ?? '';
  const packetLane = findLatestLaneByPacket(packetId);
  // A new sessionless attempt must never inherit a prior attempt's transcript.
  const sessionKey = packetLane ? packetLane.sessionKey?.trim() || '' : packetSessionKey;
  const terminalReason = readLaneTerminalReason(packetLane);

  if (!packet && !sessionKey && !packetLane) {
    return { packetId, sessionKey: '', runtime: null, events: [], note: 'packet_not_found' };
  }

  if (!sessionKey) {
    return { packetId, sessionKey: '', runtime: null, events: [], note: 'no_session_binding', terminalReason };
  }

  const readback = await readSessionTranscriptEvents(sessionKey, fullHistory, native);
  const packetEvents = packetLane && packetLane.sessionKey !== sessionKey
    ? [...laneHuddleEvents(packetLane.id, native), ...laneSteerEvents(packetLane.id, native)]
    : [];
  return {
    packetId,
    ...readback,
    terminalReason,
    events: mergeTranscriptEvents(readback.events, packetEvents),
  };
}

export function latestTranscriptEventAt(events: TranscriptEvent[]): string | null {
  let latestMs = 0;
  let latestIso: string | null = null;

  for (const event of events) {
    const parsed = new Date(event.ts).getTime();
    if (!Number.isFinite(parsed) || parsed <= latestMs) continue;
    latestMs = parsed;
    latestIso = new Date(parsed).toISOString();
  }

  return latestIso;
}
