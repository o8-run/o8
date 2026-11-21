import 'server-only';

import type Database from 'better-sqlite3';

import { broadcastGeneratedLinesSince as countGeneratedLines, claimBroadcastLineSlot } from './hourly-cap';

import { callCodex, type CallCodexOptions } from '@/lib/cortex/qa/llm/codex-adapter';
import { getSqlite } from '@/lib/db';
import { ensureV44BroadcastSchema } from '@/lib/db/v44-broadcast-migration';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { resolveBrainCodexRouteSync } from '@/lib/operator/brain-routing';
import { buildBroadcastCommentaryPrompt } from './commentary-prompt';
import { listRecentBroadcastEvents } from './events';
import {
  isGeneratedCommentary,
  isMomentEvent,
  momentFactKey,
  narratedFactKeysSince,
  narrationWindowStart,
  speakableText,
} from './narration';
import { appendBroadcastEvent } from './post';
import { recurring } from '@/lib/background-work/ledger';

const DIRECTOR_TICK_MS = 30_000;
const FEED_SLICE_LIMIT = 100;

export interface BroadcastDirectorSettings {
  broadcastCommentary: 'off' | 'interval';
  intervalMinutes: number;
  minNewEvents: number;
  maxPerHour: number;
}

export type BroadcastCommentaryRunner = (
  prompt: string,
  options: Pick<CallCodexOptions, 'model' | 'reasoningEffort'>,
) => Promise<string>;

export interface BroadcastDirectorResult {
  status: 'posted' | 'skipped';
  reason: 'posted' | 'off' | 'in_flight' | 'interval' | 'no_new_events' | 'min_new_events' | 'max_per_hour';
  eventId?: string;
  newEventCount?: number;
}

interface DirectorRunRow {
  created_at: string;
}

let commentaryInFlight = false;
let directorTimer: NodeJS.Timeout | null = null;

export function resolveBroadcastDirectorSettings(): BroadcastDirectorSettings {
  const values = getOperatorDefaultsSync().values;
  return {
    broadcastCommentary: values.broadcastCommentary,
    intervalMinutes: values.broadcastCommentaryIntervalMinutes,
    minNewEvents: values.broadcastCommentaryMinNewEvents,
    maxPerHour: values.broadcastCommentaryMaxPerHour,
  };
}

function lastDirectorRun(sqlite: Database.Database): DirectorRunRow | null {
  return sqlite.prepare(`
    SELECT created_at
    FROM broadcast_events
    WHERE kind = 'commentary'
      AND actor = 'mister'
      AND json_extract(metadata_json, '$.director') = 1
    ORDER BY created_at DESC, sequence DESC
    LIMIT 1
  `).get() as DirectorRunRow | undefined ?? null;
}

// Re-exported from its own module so the claim path and the count share one
// definition and neither file has to import the other (#1840).
export { broadcastGeneratedLinesSince } from './hourly-cap';

export async function runBroadcastDirectorOnce(options: {
  sqlite?: Database.Database;
  now?: Date;
  settings?: BroadcastDirectorSettings;
  runner?: BroadcastCommentaryRunner;
  model?: string;
  reasoningEffort?: CallCodexOptions['reasoningEffort'];
} = {}): Promise<BroadcastDirectorResult> {
  const settings = options.settings ?? resolveBroadcastDirectorSettings();
  if (settings.broadcastCommentary === 'off') return { status: 'skipped', reason: 'off' };
  if (commentaryInFlight) return { status: 'skipped', reason: 'in_flight' };

  const sqlite = options.sqlite ?? getSqlite();
  ensureV44BroadcastSchema(sqlite);
  const now = options.now ?? new Date();
  const lastRun = lastDirectorRun(sqlite);
  if (lastRun) {
    const intervalMs = settings.intervalMinutes * 60_000;
    if (now.getTime() - Date.parse(lastRun.created_at) < intervalMs) {
      return { status: 'skipped', reason: 'interval' };
    }
  }
  // Cheap early exit so a full window costs no commentary call. The binding
  // decision is the claim around the insert below.
  if (countGeneratedLines(sqlite, new Date(now.getTime() - 60 * 60_000).toISOString()) >= settings.maxPerHour) {
    return { status: 'skipped', reason: 'max_per_hour' };
  }

  const recent = listRecentBroadcastEvents({ limit: FEED_SLICE_LIMIT }, sqlite).events;
  // The shared suppression view: a fact the speaker already voiced is not news,
  // and a generated voice line is not feed input to narrate back (o8 #1822).
  const narratedFacts = narratedFactKeysSince(sqlite, narrationWindowStart(now));
  const newEvents = recent.filter((event) => (
    (!lastRun || event.timestamp > lastRun.created_at)
    && !isGeneratedCommentary(event)
    && !(isMomentEvent(event) && narratedFacts.has(momentFactKey(event)))
  ));
  if (newEvents.length === 0) return { status: 'skipped', reason: 'no_new_events', newEventCount: 0 };
  if (newEvents.length < settings.minNewEvents) {
    return { status: 'skipped', reason: 'min_new_events', newEventCount: newEvents.length };
  }

  commentaryInFlight = true;
  try {
    const route = options.model
      ? { model: options.model, reasoningEffort: options.reasoningEffort }
      : resolveBrainCodexRouteSync();
    const runner = options.runner ?? callCodex;
    const output = (await runner(buildBroadcastCommentaryPrompt(newEvents, recent), route)).trim();
    // A setting changed while the model was running applies before publication.
    if (!options.settings && resolveBroadcastDirectorSettings().broadcastCommentary === 'off') {
      return { status: 'skipped', reason: 'off' };
    }
    const text = speakableText(output);
    if (!text) throw new Error('Broadcast commentary runner returned no text.');
    // The commentary call above is an await, so the count read before it is
    // stale by now. Claim the slot in the same transaction as the insert.
    const event = claimBroadcastLineSlot(sqlite, now, settings.maxPerHour, () => appendBroadcastEvent({
      kind: 'commentary',
      actor: 'mister',
      text,
    }, {
      sqlite,
      now,
      metadata: {
        director: true,
        model: route.model,
        reasoningEffort: route.reasoningEffort ?? null,
        feedEventCount: newEvents.length,
        factKeys: [...new Set(newEvents.filter(isMomentEvent).map(momentFactKey))],
        sourceEventIds: newEvents.map((event) => event.id),
        provenance: {
          rule: 'interval-commentary',
          reason: 'The configured commentary interval elapsed with enough new durable events.',
          sources: newEvents.map((event) => ({
            id: event.id,
            kind: event.kind,
            title: event.title,
            detail: event.detail,
            timestamp: event.timestamp,
            laneId: event.laneId,
            packetId: event.packetId,
          })),
        },
      },
    }));
    if (!event) {
      return { status: 'skipped', reason: 'max_per_hour', newEventCount: newEvents.length };
    }
    return {
      status: 'posted',
      reason: 'posted',
      eventId: event.id,
      newEventCount: newEvents.length,
    };
  } finally {
    commentaryInFlight = false;
  }
}

export function startBroadcastDirectorLoop(): () => void {
  if (directorTimer) return () => undefined;
  const tick = () => {
    void runBroadcastDirectorOnce().catch((error) => {
      console.warn(`[broadcast-director] ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  tick();
  directorTimer = recurring('broadcast-director', tick, DIRECTOR_TICK_MS);
  directorTimer.unref();
  return () => {
    if (directorTimer) clearInterval(directorTimer);
    directorTimer = null;
  };
}
