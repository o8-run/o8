import { createHash } from 'node:crypto';
import { SECRET_PATTERNS, VIEWER_SECRET_PATTERNS, CREDENTIAL_LINE_PATTERNS } from './output-redaction-matchers';
import { normalizeOutput, sourceOffset } from './output-redaction-normalize';
import { assignmentRanges } from './output-redaction-statements';
import { foldAcpSecret, minimumAcpSecretLength, visitRedactionViews } from './output-normalization';
import { compileAcpMatcher } from './output-matcher';

export interface RedactedSpan {
  /** Half-open UTF-8 byte offsets into the returned, redacted text. */
  start: number;
  end: number;
  kind: 'credential';
}
export interface OutputRedactionContext {
  knownValues?: readonly string[];
  normalizedValues?: readonly string[];
  activeCredentialHashes?: ReadonlySet<string>;
  /** Server-only attestation after projecting complete source ranges onto a patch. */
  verifiedDiffs?: ReadonlySet<string>;
}
export const isViewerDiff = (text: string) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text);
const TRIGGER = /token|ticket|jwt|session|secret|passw(?:or)?d|authorization|cookie|api[_-]?key|credential|bearer|basic|eyJ|o8d_|o8pw_|o8sp_|cwk_|[sr]k[_-]|ghp_|github_pat_|xox[baprs]-|AKIA|ASIA|AIza|[?&#;]code=|:\/\/[^\s/:]+:[^\s/@]+@|--user|-u(?:\s|\S)|[?&](?:auth|key)=|process\s*\.\s*env\s*\[|-----BEGIN/i;
const DEVICE = /(?<![A-Za-z0-9_-])[a-f0-9]{64}(?![A-Za-z0-9_-])/gi;

/** Complete-source intervals, also used to project secrets into partial diff hunks. */
export function credentialSourceRanges(input: string, context: OutputRedactionContext = {}): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const preserved = normalizeOutput(input, true);
  const decoded = /[%\\&]/.test(preserved.text) ? normalizeOutput(input) : preserved;
  const literals = context.normalizedValues ?? context.knownValues?.map(value => normalizeOutput(value).text) ?? [];
  for (const mapped of preserved.text === decoded.text ? [preserved] : [preserved, decoded]) {
    if (/\bd[\t\r\n]*a[\t\r\n]*t[\t\r\n]*a[\t\r\n]*:\s*(?:[a-z][\w.+\s-]*\/|;|,)|<!DOCTYPE[\s\S]*?<!ENTITY/i.test(mapped.text)) return [{ start: 0, end: input.length }];
    const mark = (start: number, length: number) => {
      if (length) ranges.push({ start: sourceOffset(mapped, start), end: sourceOffset(mapped, start + length, true) });
    };
    for (const literal of literals) {
      if (!literal) continue;
      for (let start = mapped.text.indexOf(literal); start !== -1; start = mapped.text.indexOf(literal, start + literal.length)) mark(start, literal.length);
    }
    if (context.activeCredentialHashes?.size) {
      for (const candidate of mapped.text.matchAll(DEVICE)) {
        if (context.activeCredentialHashes.has(createHash('sha256').update(candidate[0]).digest('hex'))) mark(candidate.index, candidate[0].length);
      }
    }
    if (!TRIGGER.test(mapped.text)) continue;
    for (const range of assignmentRanges(mapped.text)) mark(range.start, range.end - range.start);
    for (const [pattern] of [...VIEWER_SECRET_PATTERNS, ...SECRET_PATTERNS, ...CREDENTIAL_LINE_PATTERNS]) {
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
  return merged;
}
/** Unknown partial hunks fail closed; source-backed producers attest their sanitized result. */
export function redactOutputText(input: string, context: OutputRedactionContext = {}): { text: string; spans: RedactedSpan[] } {
  let ranges = isViewerDiff(input) && !context.verifiedDiffs?.has(input) ? [{ start: 0, end: input.length }] : credentialSourceRanges(input, context);
  for (const match of input.matchAll(/\[redacted\]/g)) ranges.push({ start: match.index, end: match.index + 10 });
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  ranges = merged;
  let text = ''; let cursor = 0; let bytes = 0;
  const spans: RedactedSpan[] = [];
  for (const range of ranges) {
    const plain = input.slice(cursor, range.start);
    text += plain + '[redacted]'; bytes += Buffer.byteLength(plain, 'utf8');
    spans.push({ start: bytes, end: bytes + 10, kind: 'credential' }); bytes += 10; cursor = range.end;
  }
  return { text: text + input.slice(cursor), spans };
}


/** Per-process snapshot: rotating a saved credential cannot unmask a resident agent. */
export function createAcpOutputRedactor(values: string[]) {
  const secrets = [...new Set(values.filter(Boolean).flatMap(value => [value, Buffer.from(value, 'utf8').toString('utf8')]))];
  const foldedSecrets = [...new Set(secrets.map(foldAcpSecret).filter(Boolean))];
  const encoded = [...new Set(secrets.map(secret => Buffer.from(secret).toString('base64url')))];
  const rawMatcher = compileAcpMatcher(secrets);
  const foldedMatcher = foldedSecrets.length === secrets.length && foldedSecrets.every((value, index) => value === secrets[index])
    ? rawMatcher : compileAcpMatcher(foldedSecrets);
  const base64Matcher = compileAcpMatcher(encoded, false);
  const marker = ['[redacted]', '[hidden]', '•••', ''].find(value => ![...secrets, ...foldedSecrets].some(secret => value.includes(secret)))!;
  const minimum = Math.min(...secrets.map(minimumAcpSecretLength));
  const ranges = (value: string): Array<[number, number]> => {
    if (!value || !secrets.length) return [];
    const spans: Array<[number, number]> = [];
    const covered = new Set<string>();
    visitRedactionViews(value, minimum, view => {
      const matches: Array<[number, number]> = [];
      const find = view.base64 ? base64Matcher : view.folded ? foldedMatcher : rawMatcher;
      for (const match of find(view.value)) {
        const span = view.span(...match, view.base64 ? (4 - (match[1] - match[0]) % 4) % 4 : 0);
        matches.push(match); spans.push(span); covered.add(String(span));
      }
      return matches;
    }, (start, end) => covered.has(`${start},${end}`), () => spans.length);
    const merged: Array<[number, number]> = [];
    for (const span of spans.sort((a, b) => a[0] - b[0])) {
      const previous = merged[merged.length - 1];
      if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
      else merged.push(span);
    }
    return merged;
  };
  const verified = new Set<string>(); let verifiedUnits = 0;
  const remember = (value: string) => {
    if (verified.has(value) || value.length > 8 * 1024 * 1024) return;
    verified.add(value); verifiedUnits += value.length;
    while (verifiedUnits > 8 * 1024 * 1024 || verified.size > 128) {
      const oldest = verified.values().next().value!;
      verified.delete(oldest); verifiedUnits -= oldest.length;
    }
  };
  const chunks = (values: string[]): string[] => {
    const spans = ranges(values.join(''));
    // Every substring of a completely inspected, match-free logical value is
    // also safe on its own. Reuse that result through downstream event wrappers;
    // never skip inspection of newly joined chunks. Cache only unchanged text.
    if (!spans.length) { for (const value of values) remember(value); return values; }
    let offset = 0;
    return values.map(value => {
      const parts: string[] = []; let cursor = 0;
      for (const [start, end] of spans) {
        if (end <= offset || start >= offset + value.length) continue;
        const localStart = Math.max(0, start - offset);
        parts.push(value.slice(cursor, localStart));
        if (end <= offset + value.length) parts.push(marker);
        cursor = Math.min(value.length, end - offset);
      }
      parts.push(value.slice(cursor)); offset += value.length; return parts.join('');
    });
  };
  const text = (value: string) => verified.has(value) ? value : chunks([value])[0];

  function redact<T>(value: T, keys = false): T {
    if (typeof value === 'string') return text(value) as T;
    if (Array.isArray(value)) return value.map(item => redact(item, keys)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [keys ? text(key) : key, redact(item, keys)])) as T;
    }
    return value;
  }
  return { redact, chunks, hasSecrets: secrets.length > 0, stream(emit: (value: string) => void) {
    let pending = '';
    return (chunk: string, final = false, intermediate = false) => {
      if (!secrets.length) { if (chunk) emit(chunk); return; }
      pending += chunk;
      // A tool notification is not the end of the logical output: encodings can
      // continue after it. Only a terminal boundary can prove a suffix harmless.
      if (final && !intermediate) { if (pending) emit(text(pending)); pending = ''; }
    };
  } };
}
