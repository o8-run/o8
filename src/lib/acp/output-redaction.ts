import { createHash } from 'node:crypto';
import { SECRET_PATTERNS, VIEWER_SECRET_PATTERNS, CREDENTIAL_LINE_PATTERNS } from './output-redaction-matchers';
import { normalizeOutput, sourceOffset } from './output-redaction-normalize';
import { assignmentRanges } from './output-redaction-statements';

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
