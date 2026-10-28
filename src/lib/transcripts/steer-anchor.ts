import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import type { QueuedComposerSendRecord } from '@/lib/orchestrator/composer-queue-types';

/** Exact output observed before provider admission, independent of wall clocks. */
export interface SteerTranscriptAnchor {
  assistantMessageId: string;
  sequence: number;
  text: string;
  blockText: string;
  thinking: string;
  blockThinking: string;
  toolCount: number;
}

export function validSteerTranscriptAnchor(value: unknown): value is SteerTranscriptAnchor {
  if (!value || typeof value !== 'object') return false;
  const anchor = value as Partial<SteerTranscriptAnchor>;
  return typeof anchor.assistantMessageId === 'string' && !!anchor.assistantMessageId
    && ['text', 'blockText', 'thinking', 'blockThinking'].every(key => typeof (anchor as Record<string, unknown>)[key] === 'string')
    && Number.isSafeInteger(anchor.sequence) && (anchor.sequence ?? 0) > 0
    && Number.isSafeInteger(anchor.toolCount) && (anchor.toolCount ?? -1) >= 0;
}

function prefixLength(text: string, plain: string, blocks: string): number {
  // Live block renderers insert newlines; durable runtime text is verbatim.
  if (blocks !== plain && text.startsWith(blocks)) return blocks.length;
  return text.startsWith(plain) ? plain.length : text.length;
}

/** Split presentation only. The canonical runtime message and its id stay whole. */
export function placeSteerTranscriptEntries(messages: readonly MobileTranscriptEntry[], queued: readonly QueuedComposerSendRecord[] = []): MobileTranscriptEntry[] {
  const source = [...messages];
  const ids = new Set(source.map(entry => entry.id));
  for (const item of queued) {
    if (item.status !== 'applied' || item.intent !== 'steer-now' || !validSteerTranscriptAnchor(item.steerAnchor)) continue;
    const id = `composer-steer-${item.id}`;
    if (!ids.has(id)) { ids.add(id); source.push({ id, role: 'user', text: item.payload.text,
      timestamp: item.admittedAt ?? item.createdAt, steerAnchor: item.steerAnchor,
      media: item.payload.images.map(image => ({ kind: 'image', path: image.dataUri, name: image.name })) }); }
  }
  const assistantIds = new Set(source.filter(entry => entry.role === 'assistant').map(entry => entry.id));
  const anchors = new Map<string, MobileTranscriptEntry[]>();
  for (const entry of source) {
    if (entry.role !== 'user' || !validSteerTranscriptAnchor(entry.steerAnchor)) continue;
    const key = entry.steerAnchor.assistantMessageId;
    if (!assistantIds.has(key)) continue;
    const bucket = anchors.get(key) ?? []; bucket.push(entry); anchors.set(key, bucket);
  }
  const placed = new Set([...anchors.values()].flat().map(entry => entry.id));
  return source.flatMap(entry => {
    if (placed.has(entry.id)) return [];
    const steers = anchors.get(entry.id);
    if (!steers) return [entry];
    // Equal output offsets still retain successive admission order.
    steers.sort((a, b) => a.steerAnchor!.sequence - b.steerAnchor!.sequence);
    const rows: MobileTranscriptEntry[] = [];
    let textStart = 0, thinkingStart = 0, toolStart = 0;
    for (const steer of steers) {
      const anchor = steer.steerAnchor!;
      const textEnd = Math.max(textStart, prefixLength(entry.text, anchor.text, anchor.blockText));
      const thinkingEnd = Math.max(thinkingStart, prefixLength(entry.thinking ?? '', anchor.thinking, anchor.blockThinking));
      const toolEnd = Math.max(toolStart, Math.min(entry.toolCalls?.length ?? 0, anchor.toolCount));
      if (textEnd > textStart || thinkingEnd > thinkingStart || toolEnd > toolStart) rows.push({ role: 'assistant', timestamp: entry.timestamp, timestampLabel: entry.timestampLabel,
        backend: entry.backend, model: entry.model, persistedVersion: entry.persistedVersion,
        id: `${entry.id}:before:${steer.id}`, text: entry.text.slice(textStart, textEnd),
        thinking: entry.thinking?.slice(thinkingStart, thinkingEnd), toolCalls: entry.toolCalls?.slice(toolStart, toolEnd), thinkingActive: false });
      rows.push(steer);
      textStart = textEnd; thinkingStart = thinkingEnd; toolStart = toolEnd;
    }
    rows.push({ ...entry, text: entry.text.slice(textStart), thinking: entry.thinking?.slice(thinkingStart), toolCalls: entry.toolCalls?.slice(toolStart) });
    return rows;
  });
}
