import 'server-only';

import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { fetchNextJson } from '@/lib/ws-server/next-fetch';
import {
  attentionEventIsCurrent,
  attentionSubscriptionEnabled,
  isBroadcastQuietTime,
  type BroadcastAttentionPolicySettings,
} from './attention-policy';
import { broadcastEventSpecifics } from './commentary-prompt';
import { buildBroadcastSnapshot } from './snapshot';
import { claimBroadcastLineSlot } from './hourly-cap';
import { listBroadcastEvents } from './events';
import {
  BROADCAST_SPOKEN_MAX_LENGTH,
  clipPhrase,
  firstSentence,
  isMomentEvent,
  expiredNarratedFactKeys,
  momentFactKey,
  narratedFactKeysSince,
  narrationWindowStart,
  NARRATION_REPETITION_WINDOW_MS,
  speakableText,
} from './narration';
import { speakBroadcastWithNativeTts } from './native-tts';
import { appendBroadcastEvent } from './post';
import type { BroadcastEvent } from './types';

const SPEAKER_TICK_MS = 1_000;
/** With voice off, nothing speaks, so the cursor only needs to keep up. */
const VOICE_OFF_TICK_EVERY = 15;
const MAX_QUEUE_DEPTH = 3;
const COMMENTARY_PAGE_LIMIT = 100;
const MOMENT_COALESCE_MS = 1_000;
const REPETITION_WINDOW_MS = NARRATION_REPETITION_WINDOW_MS;
const SUBJECT_MAX_LENGTH = 64;
const DETAIL_MAX_LENGTH = 88;
const MAX_DEFERRED_MOMENTS = 6;

export interface BroadcastVoiceSettings extends BroadcastAttentionPolicySettings {
  broadcastVoice: 'off' | 'on';
  lullMinutes: number;
  maxPerHour: number;
}

export interface BroadcastSpeechLine {
  id: string;
  actor: string;
  text: string;
  timestamp: string;
  priority?: boolean;
  suppressed?: boolean;
  factKeys?: string[];
}

interface CommentaryPage {
  commentary: BroadcastSpeechLine[];
  cursor: string | null;
  hasMore: boolean;
}

interface QueueEntry extends BroadcastSpeechLine {
  priority: boolean;
  order: number;
  representedIds: string[];
  representedTexts: string[];
}

export type BroadcastSpeechRunner = (text: string) => Promise<void>;
export type BroadcastCommentaryLoader = (cursor: string | null) => Promise<CommentaryPage>;

export interface BroadcastSpeakerTickResult {
  status: 'processed' | 'skipped';
  reason: 'processed' | 'in_flight';
  cursor: string | null;
  queued: number;
  generated: string[];
}

function voiceSettings(): BroadcastVoiceSettings {
  const values = getOperatorDefaultsSync().values;
  return {
    broadcastVoice: values.broadcastVoice,
    lullMinutes: values.broadcastVoiceLullMinutes,
    maxPerHour: values.broadcastCommentaryMaxPerHour,
    quietHours: values.broadcastVoiceQuietHours,
    quietStart: values.broadcastVoiceQuietStart,
    quietEnd: values.broadcastVoiceQuietEnd,
    attention: values.broadcastVoiceAttention,
    approvals: values.broadcastVoiceApprovals,
    reviews: values.broadcastVoiceReviews,
    failures: values.broadcastVoiceFailures,
    completions: values.broadcastVoiceCompletions,
    calendar: values.broadcastVoiceCalendar,
    timeCheckins: values.broadcastVoiceTimeCheckins,
  };
}

async function loadCommentary(cursor: string | null): Promise<CommentaryPage> {
  const searchParams = new URLSearchParams({ limit: String(COMMENTARY_PAGE_LIMIT) });
  if (cursor) searchParams.set('since', cursor);
  const response = await fetchNextJson<Partial<CommentaryPage>>('/api/broadcast/commentary', { searchParams });
  if (!Array.isArray(response.commentary) || typeof response.hasMore !== 'boolean') {
    throw new Error('Broadcast commentary endpoint returned an invalid page.');
  }
  return {
    commentary: response.commentary as BroadcastSpeechLine[],
    cursor: typeof response.cursor === 'string' ? response.cursor : null,
    hasMore: response.hasMore,
  };
}

function subject(event: BroadcastEvent): string {
  const separator = event.title.indexOf(' · ');
  return separator >= 0 ? event.title.slice(separator + 3) : 'the current packet';
}

function stringSpecific(specifics: Record<string, unknown>, key: string): string | null {
  const value = specifics[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberSpecific(specifics: Record<string, unknown>, key: string): number | null {
  const value = specifics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function payloadText(event: BroadcastEvent, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = event.payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ');
  }
  return null;
}

function packetLabel(event: BroadcastEvent, specifics = broadcastEventSpecifics(event, null)): string {
  const title = subject(event);
  if (title !== 'the current packet') return clipPhrase(title, SUBJECT_MAX_LENGTH);
  const issue = specifics.issue;
  if (typeof issue === 'number' || typeof issue === 'string') return `issue #${issue}`;
  return 'an unnamed packet';
}

function countPhrase(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value < 1 ? 2 : 0)}`;
}

function mergeSentence(event: BroadcastEvent, specifics: Record<string, unknown>): string {
  const label = packetLabel(event, specifics);
  const commitSubject = stringSpecific(specifics, 'commitSubject');
  const changedFileCount = numberSpecific(specifics, 'changedFileCount');
  const evidence = [
    commitSubject ? `\u201c${clipPhrase(commitSubject, DETAIL_MAX_LENGTH)}\u201d` : null,
    changedFileCount !== null ? countPhrase(changedFileCount, 'file') : null,
  ].filter((value): value is string => value !== null);
  return evidence.length > 0 ? `${label} merged: ${evidence.join(', ')}.` : `${label} merged.`;
}

function approvalSentence(event: BroadcastEvent, specifics: Record<string, unknown>, isRevisit = false): string {
  const action = event.detail || payloadText(event, 'summary', 'command', 'description');
  const label = packetLabel(event, specifics);
  const opening = isRevisit ? `Approval still pending for ${label}` : `Approval pending for ${label}`;
  if (!action || label.toLowerCase() === action.toLowerCase()) return `${opening}.`;
  return `${opening}: ${firstSentence(action, DETAIL_MAX_LENGTH)}.`;
}

function reviewSentence(event: BroadcastEvent, specifics: Record<string, unknown>, isRevisit = false): string {
  const label = packetLabel(event, specifics);
  const findingsCount = numberSpecific(specifics, 'findingsCount');
  const firstFinding = specifics.firstFinding && typeof specifics.firstFinding === 'object'
    ? specifics.firstFinding as { file?: unknown }
    : null;
  const file = typeof firstFinding?.file === 'string' && firstFinding.file ? firstFinding.file : null;
  const evidence = findingsCount !== null && findingsCount > 0
    ? `${countPhrase(findingsCount, 'finding')}${file ? ` in ${clipPhrase(file, DETAIL_MAX_LENGTH)}` : ''}`
    : null;
  // A second review turn on the same packet is real news, so it is not
  // suppressed -- but repeating the first utterance verbatim makes the voice
  // sound like it stuttered. One word places it in sequence (#1842).
  if (specifics.approved === true) {
    const verdict = isRevisit ? `Review approved again for ${label}` : `Review approved for ${label}`;
    return evidence ? `${verdict}, ${evidence}.` : `${verdict}.`;
  }
  const changes = isRevisit ? `Review requests changes again on ${label}` : `Review requests changes on ${label}`;
  return evidence
    ? `${changes}: ${evidence}.`
    : `${changes}.`;
}

function failureSentence(event: BroadcastEvent, specifics: Record<string, unknown>): string {
  const label = packetLabel(event, specifics);
  const reason = event.detail || payloadText(event, 'reason', 'message', 'error');
  return reason
    ? `${label} failed: ${firstSentence(reason, DETAIL_MAX_LENGTH)}.`
    : `${label} failed and needs attention.`;
}

function spendSentence(event: BroadcastEvent, specifics: Record<string, unknown>): string {
  const label = packetLabel(event, specifics);
  const cost = numberSpecific(specifics, 'costUsd');
  const tokens = numberSpecific(specifics, 'inputTokens');
  const amount = cost !== null
    ? formatUsd(cost)
    : tokens !== null ? `${tokens.toLocaleString()} tokens` : null;
  return amount ? `${label} hit the spend cap at ${amount}.` : `${label} hit the spend cap.`;
}

function leaseTimeoutSentence(event: BroadcastEvent, specifics: Record<string, unknown>): string {
  const label = packetLabel(event, specifics);
  const resource = stringSpecific(specifics, 'resource') || event.detail;
  return resource
    ? `${label} timed out waiting for ${clipPhrase(resource, DETAIL_MAX_LENGTH)}.`
    : `${label} timed out waiting on a lease.`;
}

function attentionSentence(event: BroadcastEvent, specifics: Record<string, unknown>): string {
  const label = packetLabel(event, specifics);
  const reason = event.detail || payloadText(event, 'question', 'reason', 'message');
  return reason
    ? `${label} needs you: ${firstSentence(reason, DETAIL_MAX_LENGTH)}.`
    : `${label} needs your attention.`;
}

function completionSentence(event: BroadcastEvent, specifics: Record<string, unknown>): string {
  const label = packetLabel(event, specifics);
  return `${label} finished.`;
}

function calendarSentence(event: BroadcastEvent): string {
  const title = payloadText(event, 'calendarTitle') || event.detail || 'Your next calendar event';
  const startLocal = payloadText(event, 'startLocal');
  const minutesUntilStart = numberSpecific(event.payload, 'minutesUntilStart');
  const timing = minutesUntilStart !== null
    ? ` in ${countPhrase(minutesUntilStart, 'minute')}`
    : startLocal ? ` at ${clipPhrase(startLocal, 32)}` : '';
  return `Calendar${timing}: ${clipPhrase(title, DETAIL_MAX_LENGTH)}.`;
}

function scheduledAttentionSentence(event: BroadcastEvent): string | null {
  const text = payloadText(event, 'automationText') || event.detail;
  return text ? speakableText(text) : null;
}

function momentSentence(event: BroadcastEvent, isRevisit = false): string | null {
  const specifics = broadcastEventSpecifics(event, null);
  if (event.kind === 'packet_failed') return failureSentence(event, specifics);
  if (event.kind === 'operator_attention') return attentionSentence(event, specifics);
  if (event.kind === 'calendar_imminent') return calendarSentence(event);
  if (event.kind === 'scheduled_attention') return scheduledAttentionSentence(event);
  if (event.kind === 'review_verdict') return reviewSentence(event, specifics, isRevisit);
  if (event.kind === 'merge') return mergeSentence(event, specifics);
  if (event.kind === 'approval') return approvalSentence(event, specifics, isRevisit);
  if (event.kind === 'spend_cap') return spendSentence(event, specifics);
  if (event.kind === 'lease_timeout') return leaseTimeoutSentence(event, specifics);
  if (event.kind === 'agent_completed') return completionSentence(event, specifics);
  return null;
}

/** Highest-signal first — a burst that overflows defers the tail, it never truncates it. */
const MOMENT_ORDER: BroadcastEvent['kind'][] = [
  'packet_failed',
  'operator_attention',
  'calendar_imminent',
  'scheduled_attention',
  'review_verdict',
  'merge',
  'approval',
  'spend_cap',
  'lease_timeout',
  'agent_completed',
];

export interface ComposedMomentLine {
  text: string;
  spokenEvents: BroadcastEvent[];
  deferredEvents: BroadcastEvent[];
}

/**
 * Build one short spoken line from a burst. Sentences are added while the line
 * stays inside the spoken length budget; whatever does not fit is handed back
 * so the next tick speaks it instead of this one running long.
 */
export function composeMomentLine(
  input: BroadcastEvent | BroadcastEvent[],
  revisitFacts: ReadonlySet<string> = new Set(),
): ComposedMomentLine | null {
  const events = (Array.isArray(input) ? input : [input]).filter(isMomentEvent);
  if (events.length === 0) return null;
  const reviewPackets = new Set(events.filter((event) => event.kind === 'review_verdict').map((event) => event.packetId).filter(Boolean));
  const relevant = events.filter((event) => !(
    event.kind === 'approval'
    && event.packetId
    && reviewPackets.has(event.packetId)
    && /review/i.test(event.detail ?? '')
  ));
  const ordered = [...relevant].sort((left, right) => (
    MOMENT_ORDER.indexOf(left.kind) - MOMENT_ORDER.indexOf(right.kind)
  ));

  const sentences: string[] = [];
  const spokenEvents: BroadcastEvent[] = [];
  const deferredEvents: BroadcastEvent[] = [];
  const composedFacts = new Set<string>();
  let length = 0;
  for (const event of ordered) {
    const fact = momentFactKey(event);
    const sentence = momentSentence(event, revisitFacts.has(fact));
    if (!sentence) continue;
    // One fact, one sentence — the same verdict arrives from two tables and
    // must not be said twice inside a single utterance (o8 #1822).
    if (composedFacts.has(fact) || sentences.includes(sentence)) {
      spokenEvents.push(event);
      continue;
    }
    composedFacts.add(fact);
    const projected = length + sentence.length + (sentences.length > 0 ? 1 : 0);
    if (sentences.length > 0 && projected > BROADCAST_SPOKEN_MAX_LENGTH) {
      deferredEvents.push(event);
      continue;
    }
    sentences.push(sentence);
    spokenEvents.push(event);
    length = projected;
  }
  const text = speakableText(sentences.join(' '));
  return text ? { text, spokenEvents, deferredEvents } : null;
}

export function broadcastMomentLine(
  input: BroadcastEvent | BroadcastEvent[],
  revisitFacts?: ReadonlySet<string>,
): string | null {
  return composeMomentLine(input, revisitFacts)?.text ?? null;
}

function lullLine(sqlite: Database.Database): string | null {
  const snapshot = buildBroadcastSnapshot(20, sqlite);
  if (!snapshot.focus) return null;
  const running = snapshot.lanes.filter((lane) => (
    lane.status === 'running' || lane.status === 'launching' || lane.status === 'awaiting_orchestrator'
  )).length;
  const waiting = snapshot.pendingApprovals.count > 0
    || snapshot.lanes.some((lane) => lane.status === 'reviewing');
  const lanePhrase = `${running} ${running === 1 ? 'lane' : 'lanes'} running`;
  const latest = [...snapshot.recentEvents].reverse().find((event) => (
    event.kind !== 'commentary' && event.kind !== 'conversation' && event.kind !== 'focus'
  ));
  const latestMoment = latest ? broadcastMomentLine(latest) : null;
  const latestDetail = latestMoment || (latest?.detail
    ? `Latest for ${packetLabel(latest)}: ${firstSentence(latest.detail, DETAIL_MAX_LENGTH)}.`
    : null);
  const focus = `${snapshot.focus.issue ? `issue #${snapshot.focus.issue}, ` : ''}${clipPhrase(snapshot.focus.title, SUBJECT_MAX_LENGTH)}`;
  const goal = snapshot.focus.goal ? ` The goal is ${clipPhrase(snapshot.focus.goal, DETAIL_MAX_LENGTH)}.` : '';
  return speakableText(`${latestDetail ? `${latestDetail} ` : ''}Still on ${focus}.${goal} ${lanePhrase}${waiting ? ', with review pending' : ''}.`) || null;
}

export class BroadcastSpeaker {
  private cursor: string | null = null;
  private eventCursor: string | null = null;
  private queue: QueueEntry[] = [];
  private seen = new Set<string>();
  private recentFacts = new Map<string, number>();
  private recentTexts = new Map<string, number>();
  private pendingMoments: BroadcastEvent[] = [];
  private order = 0;
  private tickInFlight = false;
  private commentaryInitialized = false;
  private eventsInitialized = false;
  private drainPromise: Promise<void> | null = null;
  private lastFeedEventAt: number | null = null;
  private lullAnnounced = false;

  constructor(
    private readonly options: {
      sqlite?: Database.Database;
      speak?: BroadcastSpeechRunner;
      loadCommentary?: BroadcastCommentaryLoader;
      includeExisting?: boolean;
    } = {},
  ) {}

  state(): { cursor: string | null; queued: number; speaking: boolean } {
    return { cursor: this.cursor, queued: this.queue.length, speaking: this.drainPromise !== null };
  }

  async flush(): Promise<void> {
    await this.drainPromise;
  }

  private pruneRecent(nowMs: number): void {
    for (const [key, timestamp] of this.recentFacts) {
      if (nowMs - timestamp >= REPETITION_WINDOW_MS) this.recentFacts.delete(key);
    }
    for (const [key, timestamp] of this.recentTexts) {
      if (nowMs - timestamp >= REPETITION_WINDOW_MS) this.recentTexts.delete(key);
    }
  }

  private textKey(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  private queueSummary(texts: string[]): string {
    const unique = [...new Set(texts.map((text) => text.trim()).filter(Boolean))];
    let output = 'Queued updates condensed:';
    for (let index = 0; index < unique.length; index += 1) {
      const candidate = `${output} ${unique[index]}`;
      if (candidate.length <= BROADCAST_SPOKEN_MAX_LENGTH) {
        output = candidate;
      } else {
        output += ` ${unique.length - index} more queued ${unique.length - index === 1 ? 'update is' : 'updates are'} included.`;
        break;
      }
    }
    return speakableText(output);
  }

  private collapseOverflow(sqlite: Database.Database): void {
    while (this.queue.length > MAX_QUEUE_DEPTH) {
      const ordered = [...this.queue].sort((left, right) => Number(left.priority) - Number(right.priority) || left.order - right.order);
      const pair = ordered.slice(0, 2);
      const representedIds = pair.flatMap((entry) => entry.representedIds);
      const representedTexts = pair.flatMap((entry) => entry.representedTexts);
      const factKeys = [...new Set(pair.flatMap((entry) => entry.factKeys ?? []))];
      this.queue = this.queue.filter((entry) => !pair.includes(entry));
      const summary: QueueEntry = {
        id: `queue-summary:${representedIds.join(':')}`,
        actor: 'symon',
        text: this.queueSummary(representedTexts),
        timestamp: pair[0].timestamp,
        priority: pair.some((entry) => entry.priority),
        order: Math.min(...pair.map((entry) => entry.order)),
        factKeys,
        representedIds,
        representedTexts,
      };
      this.queue.push(summary);
      appendBroadcastEvent({ kind: 'commentary', actor: 'symon', text: summary.text }, {
        sqlite,
        metadata: { speakerQueueSummary: true, speechSuppressed: true, representedEventIds: representedIds },
      });
    }
  }

  private enqueue(line: BroadcastSpeechLine, sqlite: Database.Database, nowMs: number): void {
    if (this.seen.has(line.id) || line.suppressed || !line.text.trim()) return;
    this.pruneRecent(nowMs);
    const textKey = this.textKey(line.text);
    if (line.priority !== true
      && (this.recentTexts.has(textKey) || this.queue.some((entry) => this.textKey(entry.text) === textKey))) return;
    this.seen.add(line.id);
    const entry: QueueEntry = {
      ...line,
      priority: line.priority === true,
      order: this.order++,
      representedIds: [line.id],
      representedTexts: [line.text],
    };
    this.queue.push(entry);
    this.collapseOverflow(sqlite);
    this.queue.sort((left, right) => (
      Number(right.priority) - Number(left.priority) || left.order - right.order
    ));
  }

  private startDrain(sqlite: Database.Database): void {
    if (this.drainPromise || this.queue.length === 0) return;
    const speak = this.options.speak ?? speakBroadcastWithNativeTts;
    this.drainPromise = (async () => {
      while (this.queue.length > 0) {
        const line = this.queue.shift();
        if (!line) break;
        try {
          const spokenAt = Date.now();
          for (const text of line.representedTexts) this.recentTexts.set(this.textKey(text), spokenAt);
          for (const fact of line.factKeys ?? []) this.recentFacts.set(fact, spokenAt);
          await speak(line.text);
          const heardAt = new Date().toISOString();
          const recordHeard = sqlite.prepare(`
            UPDATE broadcast_events
            SET metadata_json = json_set(metadata_json, '$.speechHeardAt', ?)
            WHERE id = ?
          `);
          // A condensed line also delivers the events it represents. Retain
          // their receipts so an explicit catch-up cannot speak them again.
          sqlite.transaction(() => {
            for (const id of line.representedIds) {
              if (id.startsWith('broadcast:')) recordHeard.run(heardAt, id.slice('broadcast:'.length));
            }
          })();
        } catch (error) {
          console.warn(`[broadcast-speaker] ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })().finally(() => {
      this.drainPromise = null;
      if (this.queue.length > 0) this.startDrain(sqlite);
    });
  }

  private generatedLine(
    text: string,
    trigger: 'lull' | 'moment',
    sourceEvents: BroadcastEvent[],
    now: Date,
    sqlite: Database.Database,
    factKeys: string[] = [],
    maxPerHour: number,
  ): BroadcastSpeechLine | null {
    const scheduled = sourceEvents.find((event) => event.kind === 'scheduled_attention');
    // The cap is claimed in the same transaction as the insert, so the
    // director cannot append between this speaker's check and its write (#1840).
    const event = claimBroadcastLineSlot(sqlite, now, maxPerHour, () => appendBroadcastEvent(
      { kind: 'commentary', actor: 'symon', text },
      {
        sqlite,
        now,
        metadata: {
          voiceTrigger: trigger,
          sourceEventId: sourceEvents[0]?.id ?? null,
          sourceEventIds: sourceEvents.map((event) => event.id),
          hourlyCapped: true,
          provenance: {
            rule: scheduled ? 'scheduled-automation' : trigger === 'moment' ? 'subscribed-current-event' : 'time-checkin',
            reason: scheduled
              ? 'A durable o8 automation produced a subscribed read-only Symon check-in.'
              : trigger === 'moment'
                ? 'An enabled attention subscription matched a current durable event.'
              : 'The configured quiet-work interval elapsed while an operator focus remained active.',
            sources: sourceEvents.map((event) => ({
              id: event.id,
              kind: event.kind,
              title: event.title,
              detail: event.detail,
              timestamp: event.timestamp,
              laneId: event.laneId,
              packetId: event.packetId,
            })),
          },
          ...(factKeys.length > 0 ? { factKeys } : {}),
        },
      },
    ));
    if (!event) return null;
    return {
      id: `broadcast:${event.id}`,
      actor: event.actor,
      text,
      timestamp: event.timestamp,
      priority: false,
      factKeys,
    };
  }

  async tick(options: { now?: Date; settings?: BroadcastVoiceSettings } = {}): Promise<BroadcastSpeakerTickResult> {
    if (this.tickInFlight) {
      return { status: 'skipped', reason: 'in_flight', cursor: this.cursor, queued: this.queue.length, generated: [] };
    }
    this.tickInFlight = true;
    const sqlite = this.options.sqlite ?? getSqlite();
    const now = options.now ?? new Date();
    const settings = options.settings ?? voiceSettings();
    const quiet = isBroadcastQuietTime(now, settings);
    const generated: string[] = [];
    try {
      const loader = this.options.loadCommentary ?? loadCommentary;
      const initialPoll = !this.commentaryInitialized;
      let hasMore = true;
      while (hasMore) {
        const page = await loader(this.cursor);
        this.cursor = page.cursor;
        hasMore = page.hasMore;
        for (const line of page.commentary) {
          // Priority means speak on demand, not replay historical requests
          // on every startup. Bootstrap advances every page without speaking.
          const maySpeak = !initialPoll || this.options.includeExisting === true;
          const normalSpeechEnabled = settings.broadcastVoice === 'on' && !quiet;
          if (maySpeak && (normalSpeechEnabled || line.priority)) this.enqueue(line, sqlite, now.getTime());
        }
      }
      this.commentaryInitialized = true;

      const initialEventPoll = !this.eventsInitialized;
      const feedEvents: BroadcastEvent[] = [];
      let eventHasMore = true;
      while (eventHasMore) {
        const page = listBroadcastEvents({ cursor: this.eventCursor, limit: COMMENTARY_PAGE_LIMIT }, sqlite);
        this.eventCursor = page.cursor;
        eventHasMore = page.hasMore;
        feedEvents.push(...page.events);
      }
      this.eventsInitialized = true;
      const externalEvents = feedEvents.filter((event) => (
        !(event.kind === 'commentary' && (
          event.payload.voiceTrigger || event.payload.speakerQueueDrop || event.payload.speakerQueueSummary
        ))
      ));
      if (externalEvents.length > 0) {
        this.lastFeedEventAt = Math.max(...externalEvents.map((event) => Date.parse(event.timestamp)));
        this.lullAnnounced = false;
      } else if (this.lastFeedEventAt === null) {
        this.lastFeedEventAt = now.getTime();
      }

      if (settings.broadcastVoice === 'on' && !quiet) {
        const momentEvents = (initialEventPoll && this.options.includeExisting !== true ? [] : feedEvents)
          .filter(isMomentEvent)
          .filter((event) => attentionSubscriptionEnabled(event, settings))
          .filter((event) => attentionEventIsCurrent(event, sqlite, now.getTime()));
        const pendingIds = new Set(this.pendingMoments.map((event) => event.id));
        this.pendingMoments.push(...momentEvents.filter((event) => !pendingIds.has(event.id)));
        // Waiting and approval state can resolve during the coalescing window.
        // Re-check immediately before composition so Symon never announces a
        // request that stopped being true after it entered the pending burst.
        this.pendingMoments = this.pendingMoments
          .filter((event) => attentionSubscriptionEnabled(event, settings))
          .filter((event) => attentionEventIsCurrent(event, sqlite, now.getTime()));
        const firstMomentAt = this.pendingMoments.length > 0 ? Date.parse(this.pendingMoments[0].timestamp) : Number.NaN;
        if (this.pendingMoments.length > 0 && (!Number.isFinite(firstMomentAt) || now.getTime() - firstMomentAt >= MOMENT_COALESCE_MS)) {
          this.pruneRecent(now.getTime());
          const burstFacts = new Set<string>();
          const queuedFacts = new Set(this.queue.flatMap((entry) => entry.factKeys ?? []));
          // The shared suppression view: anything the director already narrated
          // (and anything this speaker said before a restart) counts as said.
          const narratedFacts = narratedFactKeysSince(sqlite, narrationWindowStart(now));
          // Said earlier this session, suppression since expired — a genuine
          // second visit, phrased as one rather than repeated verbatim (#1842).
          const revisitFacts = expiredNarratedFactKeys(sqlite, now);
          const unsaid = this.pendingMoments.filter((event) => {
            const fact = momentFactKey(event);
            if (this.recentFacts.has(fact) || queuedFacts.has(fact) || burstFacts.has(fact) || narratedFacts.has(fact)) {
              return false;
            }
            burstFacts.add(fact);
            return true;
          });
          this.pendingMoments = [];
          const composed = composeMomentLine(unsaid, revisitFacts);
          if (composed) {
            const spokenFacts = [...new Set(composed.spokenEvents.map((event) => momentFactKey(event)))];
            const line = this.generatedLine(
              composed.text,
              'moment',
              composed.spokenEvents,
              now,
              sqlite,
              spokenFacts,
              settings.maxPerHour,
            );
            if (line) {
              generated.push(line.id);
              this.enqueue(line, sqlite, now.getTime());
              // Whatever did not fit stays unsaid rather than making this line
              // run long; the next tick speaks it as its own short update.
              this.pendingMoments = composed.deferredEvents.slice(0, MAX_DEFERRED_MOMENTS);
            }
          }
        }

        const lullAt = (this.lastFeedEventAt ?? now.getTime()) + settings.lullMinutes * 60_000;
        if (settings.timeCheckins && !this.lullAnnounced && now.getTime() >= lullAt) {
          const text = lullLine(sqlite);
          if (text) {
            const line = this.generatedLine(text, 'lull', [], now, sqlite, [], settings.maxPerHour);
            if (line) {
              generated.push(line.id);
              this.enqueue(line, sqlite, now.getTime());
              this.lullAnnounced = true;
            }
          }
        }
      } else if (quiet) {
        // Quiet hours advance every durable cursor but never build a morning
        // backlog of stale nighttime interruptions.
        this.pendingMoments = [];
      }
      this.startDrain(sqlite);
      return { status: 'processed', reason: 'processed', cursor: this.cursor, queued: this.queue.length, generated };
    } finally {
      this.tickInFlight = false;
    }
  }
}

let speakerTimer: NodeJS.Timeout | null = null;
let loopSpeaker: BroadcastSpeaker | null = null;
let speakerUnavailableWarningActive = false;

export function startBroadcastSpeakerLoop(): () => void {
  if (speakerTimer) return () => undefined;
  loopSpeaker = new BroadcastSpeaker();
  let voiceOffTicks = 0;
  const voiceOff = () => {
    try { return voiceSettings().broadcastVoice === 'off'; } catch { return false; }
  };
  const tick = () => {
    if (voiceOff() && voiceOffTicks++ % VOICE_OFF_TICK_EVERY !== 0) return;
    void loopSpeaker?.tick()
      .then((result) => {
        if (result?.status === 'processed') speakerUnavailableWarningActive = false;
      })
      .catch((error) => {
        if (!speakerUnavailableWarningActive) {
          console.warn(`[broadcast-speaker] ${error instanceof Error ? error.message : String(error)}`);
        }
        speakerUnavailableWarningActive = true;
      });
  };
  tick();
  speakerTimer = setInterval(tick, SPEAKER_TICK_MS);
  speakerTimer.unref();
  return () => {
    if (speakerTimer) clearInterval(speakerTimer);
    speakerTimer = null;
    loopSpeaker = null;
    speakerUnavailableWarningActive = false;
  };
}
