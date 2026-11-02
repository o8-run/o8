import type { MobileTranscriptEntry, MobileTranscriptToolCall } from '@/lib/mobile/types';
import { isVisualizationReference, type VisualizationReference } from './types';

/** References travel as tool results, not agent-authored markdown or executable HTML. */
export function toolVisualizationReferences(calls: MobileTranscriptToolCall[] = []): VisualizationReference[] {
  const refs = new Map<string, VisualizationReference>();
  for (const call of calls) {
    const name = call.name === 'o8_run' ? call.args?.name : call.name;
    if (typeof name !== 'string' || !/(?:^|[_.])o8_html_render$/.test(name) || !call.result || call.status === 'error' || call.result.length > 40_000) continue;
    try {
      const result = JSON.parse(call.result) as { visualization?: unknown; result?: { visualization?: unknown }; content?: Array<{ type?: string; text?: string }> };
      const ref = result.visualization ?? result.result?.visualization;
      if (isVisualizationReference(ref)) refs.set(ref.id, ref);
      for (const part of result.content ?? []) {
        if (part.type !== 'text' || !part.text) continue;
        try {
          const nested = JSON.parse(part.text) as { visualization?: unknown };
          if (isVisualizationReference(nested.visualization)) refs.set(nested.visualization.id, nested.visualization);
        } catch { /* Other text is not a visualization reference. */ }
      }
    } catch { /* Partial tool results stay in the ordinary tool strip. */ }
  }
  return [...refs.values()];
}

/** Conversation-local producing message identities, shared by all revisions. */
export type TranscriptVisualizationAnchors = Map<string, string>;

/** Fallback for providers that do not retain full tool results. */
export function placeTranscriptVisualizations(refs: VisualizationReference[], messages: MobileTranscriptEntry[], anchors?: TranscriptVisualizationAnchors): Map<number, VisualizationReference[]> {
  const embedded = new Map<string, { index: number; reference: VisualizationReference }>();
  messages.forEach((message, index) => {
    for (const reference of toolVisualizationReferences(message.toolCalls)) {
      const root = reference.rootId ?? reference.id;
      if (!embedded.has(root)) { embedded.set(root, { index, reference }); anchors?.set(root, message.id); }
    }
  });
  const buckets = new Map<number, VisualizationReference[]>();
  for (const ref of refs) {
    const root = ref.rootId ?? ref.id;
    const anchor = embedded.get(root);
    if (anchor !== undefined) {
      if ((ref.version ?? 1) > (anchor.reference.version ?? 1)) {
        const bucket = buckets.get(anchor.index) ?? []; bucket.push(ref); buckets.set(anchor.index, bucket);
      }
      continue;
    }
    const known = anchors?.get(root);
    if (known) {
      const index = messages.findIndex(message => message.id === known);
      // A partial page has not loaded the producing turn. Wait for that turn
      // instead of attaching the document to an unrelated visible reply.
      if (index < 0) continue;
      const bucket = buckets.get(index) ?? []; bucket.push(ref); buckets.set(index, bucket);
      continue;
    }
    const time = Date.parse(ref.createdAt);
    let index = -1;
    let nearestTime = -Infinity;
    for (let i = 0; i < messages.length; i++) {
      const timestamp = messages[i].timestamp;
      if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp <= time && timestamp >= nearestTime) {
        nearestTime = timestamp; index = i;
      }
    }
    // Legacy transcripts with no clocks used the tail slot. Remember that
    // identity on first placement so later growth cannot move the document.
    if (index < 0 && messages.length && !messages.some(message => typeof message.timestamp === 'number' && Number.isFinite(message.timestamp))) index = messages.length - 1;
    // On a cold tail, no loaded turn precedes this historical document.
    // Wait for backfill rather than remembering the first unrelated reply.
    if (index < 0 && messages.length) continue;
    // A visual created during a provider turn can precede its final assistant
    // timestamp. Attach it to that reply, before the reply's actions, rather
    // than leaving it underneath the operator's prompt.
    if (messages[index]?.role !== 'assistant') {
      for (let i = index + 1; i < messages.length; i++) {
        if (messages[i].role === 'user') break;
        if (messages[i].role === 'assistant') { index = i; break; }
      }
    }
    if (index >= 0) anchors?.set(root, messages[index].id);
    const bucket = buckets.get(index) ?? [];
    bucket.push(ref);
    buckets.set(index, bucket);
  }
  return buckets;
}
