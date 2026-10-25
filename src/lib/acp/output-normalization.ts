import { createHash } from 'node:crypto';

export const ACP_REDACTION_LIMIT = 256 * 1024;
export interface RedactionView { value: string; starts: Int32Array; ends: Int32Array; ambiguous?: boolean }
interface Replacement { start: number; end: number; value: string; ambiguous?: boolean }
export function replaceView(view: RedactionView, replacements: Replacement[]): RedactionView {
  const parts: string[] = []; const starts: number[] = []; const ends: number[] = [];
  let cursor = 0;
  const copy = (end: number) => {
    parts.push(view.value.slice(cursor, end));
    for (; cursor < end; cursor++) { starts.push(view.starts[cursor]); ends.push(view.ends[cursor]); }
  };
  for (const replacement of replacements) {
    copy(replacement.start); parts.push(replacement.value);
    for (let index = 0; index < replacement.value.length; index++) {
      starts.push(view.starts[replacement.start]); ends.push(view.ends[replacement.end - 1]);
    }
    cursor = replacement.end;
  }
  copy(view.value.length);
  return { value: parts.join(''), starts: Int32Array.from(starts), ends: Int32Array.from(ends),
    ambiguous: view.ambiguous || replacements.some(replacement => replacement.ambiguous) };
}

function jsonEscapes(view: RedactionView): RedactionView {
  const replacements: Replacement[] = [];
  for (let index = 0; index < view.value.length; index++) {
    if (view.value[index] !== '\\') continue;
    const token = /^\\(?:u[0-9a-f]{4}|["\\/bfnrt])/i.exec(view.value.slice(index));
    if (!token) throw new Error('Ambiguous JSON escape');
    const value = JSON.parse(`"${token[0]}"`) as string;
    replacements.push({ start: index, end: index + token[0].length, value });
    index += token[0].length - 1;
  }
  return replaceView(view, replacements);
}

function percentEscapes(view: RedactionView, form: boolean): RedactionView {
  const replacements: Replacement[] = [];
  for (let index = 0; index < view.value.length; index++) {
    if (form && view.value[index] === '+') replacements.push({ start: index, end: index + 1, value: ' ' });
    if (view.value[index] !== '%') continue;
    const token = /^(?:%[0-9a-f]{2})+/i.exec(view.value.slice(index));
    if (!token) throw new Error('Ambiguous percent escape');
    // Validate UTF-8 while accepting mixed-case hex digits.
    replacements.push({ start: index, end: index + token[0].length, value: decodeURIComponent(token[0]) });
    index += token[0].length - 1;
  }
  return replaceView(view, replacements);
}

function base64Text(view: RedactionView, offset: number, whitespace: boolean, minimum: number, replacementSecret: boolean): RedactionView {
  const replacements: Replacement[] = [];
  const pattern = whitespace ? /[A-Za-z0-9+/_-][A-Za-z0-9+/_\-\t\r\n ]*={0,2}/g : /[A-Za-z0-9+/_-]+={0,2}/g;
  for (const token of view.value.matchAll(pattern)) {
    const compact = token[0].replace(/\s/g, '');
    const encoded = compact.slice(offset);
    if (encoded.length < 2) continue;
    const bytes = Buffer.from(encoded, 'base64url');
    const value = bytes.toString('utf8');
    const validUtf8 = Buffer.from(value, 'utf8').equals(bytes);
    // A nested text encoding cannot be shorter than the saved value. Ignore
    // ordinary alphabetic words whose decoded bytes have no sufficiently long text run.
    if (!(validUtf8 ? value.length >= minimum : replacementSecret || value.split('\uFFFD').some(run => run.length >= minimum))) continue;
    if (!value || value === encoded) continue;
    replacements.push({ start: token.index, end: token.index + token[0].length, value,
      ambiguous: offset !== 0 || compact !== token[0] || !validUtf8 });
  }
  return replaceView(view, replacements);
}

/** Explore decoding orders, retaining the enclosing original span for every code unit. */
export function visitRedactionViews(value: string, minimum: number, replacementSecret: boolean, inspect: (view: RedactionView) => RedactionView): void {
  if (value.length > ACP_REDACTION_LIMIT) throw new Error('Redaction input budget exceeded');
  const initial = { value, starts: Int32Array.from({ length: value.length }, (_, index) => index),
    ends: Int32Array.from({ length: value.length }, (_, index) => index + 1) };
  const queue: Array<{ view: RedactionView; depth: number }> = [{ view: initial, depth: 0 }];
  const seen = new Set<string>(); let work = value.length;
  const fingerprint = (view: RedactionView) => createHash('sha256').update(Buffer.from(view.value, 'utf16le'))
    .update(Buffer.from(view.starts.buffer)).update(Buffer.from(view.ends.buffer)).update(String(!!view.ambiguous)).digest('hex');
  seen.add(fingerprint(initial));
  for (let index = 0; index < queue.length; index++) {
    const { view, depth } = queue[index];
    // Match before decoding again: a secret may itself contain literal escape syntax.
    const current = inspect(view);
    for (const decode of [jsonEscapes, (input: RedactionView) => percentEscapes(input, false),
      (input: RedactionView) => percentEscapes(input, true), ...[0, 1, 2, 3].flatMap(offset =>
        [false, true].map(whitespace => (input: RedactionView) => base64Text(input, offset, whitespace, minimum, replacementSecret)))]) {
      const decoded = decode(current);
      if (decoded.value === current.value) continue;
      const key = fingerprint(decoded);
      if (seen.has(key)) continue;
      work += decoded.value.length;
      if (depth >= 12 || queue.length >= 64 || work > 2 * 1024 * 1024) throw new Error('Redaction normalization budget exceeded');
      seen.add(key); queue.push({ view: decoded, depth: depth + 1 });
    }
  }
}
