import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

type Json = Record<string, unknown>;
type ContextPart = 'base' | 'turn';
const MARKER = /<o8_turn_context part="(base|turn)" sha256="([a-f0-9]{64})" chars="(\d+)">\n/g;
const CLOSE = '\n</o8_turn_context>';

export function appBridgeContext(prompt: string, part: ContextPart): { part: ContextPart; hash: string; text: string } {
  const hash = createHash('sha256').update(prompt).digest('hex');
  return { part, hash, text: `Current o8 ${part} instructions (replaces previous ${part} instructions):\n`
    + `<o8_turn_context part="${part}" sha256="${hash}" chars="${prompt.length}">\n${prompt}${CLOSE}` };
}

/** Read the retained developer history, including compaction replacements, rather than a sidecar cache. */
export async function retainedAppBridgeContextHashes(rolloutPath: unknown): Promise<Partial<Record<ContextPart, string>>> {
  if (typeof rolloutPath !== 'string') return {};
  let hashes: Partial<Record<ContextPart, string>> = {};
  const inspect = (item: Json) => {
    if (item.type !== 'message' || item.role !== 'developer' || !Array.isArray(item.content)) return;
    for (const part of item.content as Json[]) {
      if (typeof part.text !== 'string') continue;
      const marker = new RegExp(MARKER.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = marker.exec(part.text))) {
        const length = Number(match[3]);
        const end = marker.lastIndex + length;
        if (!Number.isSafeInteger(length) || end > part.text.length || part.text.slice(end, end + CLOSE.length) !== CLOSE
          || createHash('sha256').update(part.text.slice(marker.lastIndex, end)).digest('hex') !== match[2]) {
          hashes = {};
          return;
        }
        hashes[match[1] as ContextPart] = match[2];
        // A quoted envelope inside operator text belongs to this part's body.
        marker.lastIndex = end + CLOSE.length;
      }
    }
  };
  const input = createReadStream(rolloutPath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let entry: Json;
      try { entry = JSON.parse(line) as Json; } catch { continue; }
      const payload = entry.payload as Json | undefined;
      if (!payload) continue;
      if (entry.type === 'compacted') {
        hashes = {};
        if (Array.isArray(payload.replacement_history)) {
          for (const item of payload.replacement_history as Json[]) inspect(item);
        }
      } else if (entry.type === 'response_item') {
        inspect(payload);
      } else if (entry.type === 'event_msg' && payload.type === 'thread_rolled_back') {
        hashes = {};
      }
    }
    return hashes;
  } catch {
    // Without retained-history proof, resend the context instead of omitting it.
    return {};
  } finally {
    lines.close();
    input.destroy();
  }
}
