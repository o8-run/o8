/** Sparse UTF-16 source map: unchanged runs use one linear segment. */
interface Segment { start: number; end: number; sourceStart: number; sourceEnd: number }
export interface MappedOutput {
  text: string;
  segments: Segment[];
}
export function sourceOffset(value: MappedOutput, index: number, end = false): number {
  const position = end ? index - 1 : index;
  let low = 0; let high = value.segments.length - 1;
  while (low < high) { const mid = (low + high + 1) >>> 1; if (value.segments[mid].start <= position) low = mid; else high = mid - 1; }
  const segment = value.segments[low];
  if (!segment) return 0;
  return segment.end - segment.start === segment.sourceEnd - segment.sourceStart
    ? segment.sourceStart + index - segment.start : end ? segment.sourceEnd : segment.sourceStart;
}
export function normalizeOutput(input: string, preserveEscapes = false): MappedOutput {
  let mapped: MappedOutput = { text: input, segments: input ? [{ start: 0, end: input.length, sourceStart: 0, sourceEnd: input.length }] : [] };
  if (!/[^\x00-\x7f]|[%\\&]/.test(input)) return mapped;
  for (let pass = 0; pass < 3; pass++) {
    const pieces: string[] = []; const segments: Segment[] = [];
    let cursor = 0; let length = 0; let changed = false; let segmentIndex = 0;
    const push = (part: string, sourceStart: number, sourceEnd: number) => {
      if (!part.length) return;
      pieces.push(part);
      const previous = segments.at(-1);
      if (previous && previous.sourceEnd === sourceStart && previous.end - previous.start === previous.sourceEnd - previous.sourceStart && part.length === sourceEnd - sourceStart) {
        previous.end += part.length; previous.sourceEnd = sourceEnd;
      } else segments.push({ start: length, end: length + part.length, sourceStart, sourceEnd });
      length += part.length;
    };
    const plain = (start: number, end: number) => {
      while (segmentIndex < mapped.segments.length && mapped.segments[segmentIndex].end <= start) segmentIndex++;
      let position = start;
      while (position < end) {
        const segment = mapped.segments[segmentIndex]; const stop = Math.min(end, segment.end);
        push(mapped.text.slice(position, stop), sourceOffset(mapped, position), sourceOffset(mapped, stop, true));
        position = stop; if (stop === segment.end) segmentIndex++;
      }
    };
    const escapes = /\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|((?:%[0-9a-f]{2})+)|\\([\\"'`])|&#(?:x[0-9a-f]+|[0-9]+);?|&(?:colon|comma|sol|semi|Tab|NewLine|quot|apos|amp|lt|gt);|[^\x00-\x7f]/giu;
    for (const match of mapped.text.matchAll(escapes)) {
      const hex = match[1] ?? match[2] ?? match[3];
      let decoded = hex && parseInt(hex, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(hex, 16)) : match[5] ?? match[0];
      if (match[0].startsWith('&#')) { const number = parseInt(match[0].replace(/^&#x?/i, ''), /^&#x/i.test(match[0]) ? 16 : 10); if (number <= 0x10ffff) decoded = String.fromCodePoint(number); }
      else if (match[0].startsWith('&')) { const entities: Record<string, string> = { colon: ':', comma: ',', sol: '/', semi: ';', Tab: '\t', NewLine: '\n', quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' }; decoded = entities[match[0].slice(1, -1)] ?? match[0]; }
      if (match[4]) { try { decoded = decodeURIComponent(match[4]); } catch { decoded = match[0]; } }
      if (preserveEscapes && (match[5] || /["'`\\\r\n]/.test(decoded))) decoded = match[0];
      decoded = decoded.normalize('NFKC').replace(/[\p{Cf}\p{M}]/gu, '');
      if (decoded === match[0]) continue;
      changed = true;
      plain(cursor, match.index);
      push(decoded, sourceOffset(mapped, match.index), sourceOffset(mapped, match.index + match[0].length, true));
      cursor = match.index + match[0].length;
    }
    if (!changed) break;
    plain(cursor, mapped.text.length);
    mapped = { text: pieces.join(''), segments };
  }
  return mapped;
}
