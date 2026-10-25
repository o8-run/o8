import { createHash } from 'node:crypto';
import { SECRET_PATTERNS, VIEWER_SECRET_PATTERNS, CREDENTIAL_LINE_PATTERNS } from './output-redaction-matchers';

export interface RedactedSpan {
  /** Half-open UTF-8 byte offsets into the returned, redacted text. */
  start: number;
  end: number;
  kind: 'credential';
}

const MASK = '[redacted]';
interface MappedText { text: string; starts: number[]; ends: number[]; identity?: true }
export interface OutputRedactionContext {
  knownValues?: readonly string[];
  activeCredentialHashes?: ReadonlySet<string>;
}

/** Normalize only for matching; all unmasked source bytes stay unchanged. */
function normalize(input: string, preserveEscapes: boolean): MappedText {
  // Most source and raster data URLs need no normalization or per-character maps.
  if (!/[^\x09\x0a\x0d\x20-\x7e]|[%\\]/.test(input)) return { text: input, starts: [], ends: [], identity: true };
  let mapped: MappedText = { text: input, starts: [], ends: [] };
  for (let i = 0; i < input.length; i++) { mapped.starts.push(i); mapped.ends.push(i + 1); }
  for (let pass = 0; pass < 3; pass++) {
    const next: MappedText = { text: '', starts: [], ends: [] };
    const escapes = /\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})|((?:%[0-9a-f]{2})+)|\\([\\"'`])/giy;
    for (let i = 0; i < mapped.text.length;) {
      escapes.lastIndex = i;
      const match = escapes.exec(mapped.text);
      const width = match?.[0].length ?? (mapped.text.codePointAt(i)! > 0xffff ? 2 : 1);
      const hex = match && (match[1] ?? match[2] ?? match[3]);
      let decoded = hex && parseInt(hex, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(hex, 16)) : match?.[5] ?? mapped.text.slice(i, i + width);
      if (match?.[4]) {
        try { decoded = decodeURIComponent(match[4]); }
        catch { decoded = match[4]; }
      }
      if (preserveEscapes && match && (match[5] || /["'`\\\r\n]/.test(decoded))) decoded = match[0];
      const normalized = decoded.normalize('NFKC').replace(/[\p{Cf}\p{M}]/gu, '');
      next.text += normalized;
      for (let j = 0; j < normalized.length; j++) {
        next.starts.push(mapped.starts[i]); next.ends.push(mapped.ends[i + width - 1]);
      }
      i += width;
    }
    mapped = next;
  }
  return mapped;
}

/** One shared detector, with source mapping for escaped and Unicode-split forms. */
export function redactOutputText(input: string, context: OutputRedactionContext = {}): { text: string; spans: RedactedSpan[] } {
  const ranges: Array<{ start: number; end: number }> = [];
  const preserved = normalize(input, true);
  const decoded = preserved.identity ? preserved : normalize(input, false);
  for (const mapped of preserved.text === decoded.text ? [preserved] : [preserved, decoded]) {
    const mark = (start: number, length: number) => {
      if (length) ranges.push({ start: mapped.identity ? start : mapped.starts[start], end: mapped.identity ? start + length : mapped.ends[start + length - 1] });
    };
    for (const value of context.knownValues ?? []) {
      const literal = normalize(value, false).text;
      if (!literal) continue;
      for (let start = mapped.text.indexOf(literal); start !== -1; start = mapped.text.indexOf(literal, start + literal.length)) mark(start, literal.length);
    }
    if (context.activeCredentialHashes?.size) {
      for (const candidate of mapped.text.matchAll(/[A-Za-z0-9_-]{6,}/g)) {
        if (context.activeCredentialHashes.has(createHash('sha256').update(candidate[0]).digest('hex'))) mark(candidate.index, candidate[0].length);
      }
    }
    for (const [pattern] of [...VIEWER_SECRET_PATTERNS, ...SECRET_PATTERNS, ...CREDENTIAL_LINE_PATTERNS]) {
      // Each scan owns its cursor; concurrent requests never share regex state.
      for (const match of mapped.text.matchAll(new RegExp(pattern.source, pattern.flags))) mark(match.index, match[0].length);
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  let text = ''; let cursor = 0; let bytes = 0;
  const spans: RedactedSpan[] = [];
  for (const range of merged) {
    const plain = input.slice(cursor, range.start);
    text += plain + MASK;
    bytes += Buffer.byteLength(plain, 'utf8');
    spans.push({ start: bytes, end: bytes + MASK.length, kind: 'credential' });
    bytes += MASK.length;
    cursor = range.end;
  }
  return { text: text + input.slice(cursor), spans };
}
