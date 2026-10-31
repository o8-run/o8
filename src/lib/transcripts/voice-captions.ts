import type { MobileTranscriptEntry } from '@/lib/mobile/types';

export type VoiceCaption = {
  sessionId: string;
  direction: 'input' | 'output';
  revision: number;
  startMs: number;
  endMs: number;
  delegatedUserMessageId?: string;
};

export function readVoiceCaption(value: unknown): VoiceCaption | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.sessionId !== 'string' || !v.sessionId || !['input', 'output'].includes(String(v.direction))
    || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1
    || typeof v.startMs !== 'number' || !Number.isFinite(v.startMs) || v.startMs < 0
    || typeof v.endMs !== 'number' || !Number.isFinite(v.endMs) || v.endMs < v.startMs) return undefined;
  return { sessionId: v.sessionId, direction: v.direction as VoiceCaption['direction'], revision: Number(v.revision),
    startMs: v.startMs, endMs: v.endMs,
    ...(typeof v.delegatedUserMessageId === 'string' && (v.delegatedUserMessageId.startsWith('orch-user-')
      || /^(review-user-assistant-queued-|lead-user-)[A-Za-z0-9_-]+$/.test(v.delegatedUserMessageId))
      ? { delegatedUserMessageId: v.delegatedUserMessageId } : {}) };
}

/** A stale history write must not shrink a streamed caption or remove its send link. */
export function preserveVoiceCaption<T extends { voice?: unknown }>(existing: T, inbound: T): T {
  const before = readVoiceCaption(existing.voice);
  const after = readVoiceCaption(inbound.voice);
  return before && (!after || (before.sessionId === after.sessionId && before.revision > after.revision)) ? existing : inbound;
}

/** Keep the spoken evidence stored; replace it visually only when its exact CLI message exists. */
export function visibleVoiceTranscript(entries: MobileTranscriptEntry[]): MobileTranscriptEntry[] {
  const sends = new Set(entries.filter(entry => entry.role === 'user' && !entry.voice).map(entry => entry.id));
  return entries.filter(entry => !entry.voice?.delegatedUserMessageId || !sends.has(entry.voice.delegatedUserMessageId));
}
