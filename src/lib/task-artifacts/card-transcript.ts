import 'server-only';
import { findLaneBySession, getLane } from '@/lib/lane/registry';
import { isLaneTerminal } from '@/lib/lane/terminal-states';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { missionCardView } from './card';
import { acceptedCardDecision, listMissionCardsByPacket, listMissionCardsByThread } from './store';
import type { TaskArtifactRecord } from './types';

/** A packet card stops taking decisions once its lane can no longer be steered. */
function closedReason(record: TaskArtifactRecord): string | null {
  if (record.state !== 'live') return record.stateReason ?? `The card is ${record.state}.`;
  if (record.target.kind !== 'packet') return null;
  const lane = record.target.laneId ? getLane(record.target.laneId) : null;
  if (!lane) return 'The packet lane no longer exists.';
  if (isLaneTerminal(lane.status)) return `The packet is ${lane.status}.`;
  return null;
}

/**
 * Mission cards (#5468) as transcript entries, so every transcript that reads
 * session history draws the card where it was emitted and rebuilds its receipt
 * from server state on reload. Orchestrator threads read `llm-chat:<thread>`;
 * packet sessions read the cards attached to their packet.
 */
export function missionCardTranscriptEntries(sessionKey: string): MobileTranscriptEntry[] {
  let records: TaskArtifactRecord[] = [];
  try {
    if (sessionKey.startsWith('llm-chat:')) {
      records = listMissionCardsByThread(sessionKey.slice('llm-chat:'.length));
    } else {
      const packetId = findLaneBySession(sessionKey)?.packetId;
      if (packetId) records = listMissionCardsByPacket(packetId);
    }
  } catch (error) {
    console.warn('[task-artifacts] mission card transcript read failed:', error);
    return [];
  }
  const entries: MobileTranscriptEntry[] = [];
  for (const record of records) {
    const card = missionCardView(record, acceptedCardDecision(record.id), closedReason(record));
    if (!card) continue;
    const timestamp = Date.parse(record.createdAt);
    entries.push({
      id: `card-${record.id}`,
      role: 'assistant',
      text: card.summary ?? record.title,
      type: 'card',
      card,
      timestamp: Number.isFinite(timestamp) ? timestamp : undefined,
      timestampLabel: Number.isFinite(timestamp)
        ? new Date(timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : '',
    });
  }
  return entries;
}

/**
 * Place a session's cards in its full transcript by time. Only the paged
 * history read (the native transcript) carries cards: their entry id is stable
 * while their state changes, so id-based deltas such as mobile sync must not.
 */
export function withMissionCardEntries(sessionKey: string, transcript: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  const cards = missionCardTranscriptEntries(sessionKey);
  if (cards.length === 0) return transcript;
  const at = (entry: MobileTranscriptEntry) => (typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp)
    ? entry.timestamp : Number.NEGATIVE_INFINITY);
  return [...transcript.filter((entry) => entry.type !== 'card'), ...cards]
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => at(left.entry) - at(right.entry) || left.index - right.index)
    .map(({ entry }) => entry);
}
