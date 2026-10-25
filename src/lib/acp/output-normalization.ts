import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';

export interface RedactionView {
  value: string;
  skipBase64?: boolean;
  base64?: boolean;
  /** Half-open original UTF-16 span; maps are evaluated only for actual matches. */
  span(start: number, end: number, padding?: number): [number, number];
}
interface Replacement { start: number; end: number; value: string }

function sliceView(view: RedactionView, start: number, end: number): RedactionView {
  return { value: view.value.slice(start, end), skipBase64: view.skipBase64, base64: view.base64, span: (a, b, padding) => view.span(start + a, start + b, padding) };
}
function replaceView(view: RedactionView, replacements: Replacement[]): RedactionView {
  const parts: string[] = [];
  const segments: Array<{ start: number; end: number; source: number; replacement?: Replacement }> = [];
  let cursor = 0; let length = 0;
  for (const item of replacements) {
    if (cursor < item.start) {
      parts.push(view.value.slice(cursor, item.start));
      segments.push({ start: length, end: length + item.start - cursor, source: cursor });
      length += item.start - cursor;
    }
    parts.push(item.value);
    segments.push({ start: length, end: length + item.value.length, source: item.start, replacement: item });
    length += item.value.length; cursor = item.end;
  }
  parts.push(view.value.slice(cursor));
  segments.push({ start: length, end: length + view.value.length - cursor, source: cursor });
  const locate = (index: number) => {
    let low = 0; let high = segments.length - 1;
    while (low < high) { const mid = (low + high) >>> 1; if (segments[mid].end <= index) low = mid + 1; else high = mid; }
    return segments[low];
  };
  return { value: parts.join(''), span(start, end) {
    const first = locate(start); const last = locate(end - 1);
    const a = first.replacement?.start ?? first.source + start - first.start;
    const b = last.replacement?.end ?? last.source + end - last.start;
    return view.span(a, b);
  } };
}

function escapes(view: RedactionView, kind: 'json' | 'percent' | 'form', chains: Replacement[]): RedactionView {
  const replacements: Replacement[] = [];
  const pattern = kind === 'json' ? /\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g : /(?:%[0-9a-fA-F]{2})+|\+/g;
  let chainIndex = 0;
  const blocked = (start: number, end: number) => {
    while (chainIndex < chains.length && chains[chainIndex].end <= start) chainIndex++;
    return chainIndex < chains.length && chains[chainIndex].start < end;
  };
  for (const token of view.value.matchAll(pattern)) {
    if (token[0] === '+' && kind !== 'form') continue;
    try {
      if (kind !== 'json' && token[0] !== '+') {
        const encoded = [...token[0].matchAll(/%([0-9a-fA-F]{2})/g)];
        const bytes = Buffer.from(encoded.map(part => blocked(token.index + part.index, token.index + part.index + part[0].length) ? 0xff : Number.parseInt(part[1], 16)));
        for (const [start, end] of utf8Runs(bytes)) {
          let byte = start;
          for (const char of bytes.subarray(start, end).toString('utf8')) {
            const last = byte + Buffer.byteLength(char) - 1;
            replacements.push({ start: token.index + encoded[byte].index,
              end: token.index + encoded[last].index + encoded[last][0].length, value: char });
            byte = last + 1;
          }
        }
      } else {
        if (blocked(token.index, token.index + token[0].length)) continue;
        const value = kind === 'json' ? JSON.parse(`"\\${token[1]}"`) as string : ' ';
        replacements.push({ start: token.index, end: token.index + token[0].length, value });
      }
    } catch { /* Invalid escape syntax is ordinary text, never evidence of a secret. */ }
  }
  return replacements.length ? replaceView(view, replacements) : view;
}

function compactView(view: RedactionView, pattern: RegExp): RedactionView {
  const value = view.value.replace(pattern, '');
  if (value === view.value) return view;
  let positions: Int32Array | undefined;
  const position = (index: number): number => {
    // Fingerprints need only outer bounds. Keep those cheap without constructing
    // an interior offset table for large text that contains no saved value.
    if (!positions && (index < 16 || value.length - 1 - index < 16)) {
      const backwards = index >= 16;
      let remaining = backwards ? value.length - 1 - index : index;
      for (let cursor = backwards ? view.value.length - 1 : 0; backwards ? cursor >= 0 : cursor < view.value.length; cursor += backwards ? -1 : 1) {
        pattern.lastIndex = 0;
        if (!pattern.test(view.value[cursor]) && remaining-- === 0) return cursor;
      }
    }
    if (!positions) {
      positions = new Int32Array(value.length); let output = 0; let cursor = 0;
      pattern.lastIndex = 0;
      for (const removed of view.value.matchAll(pattern)) {
        for (; cursor < removed.index; cursor++) positions[output++] = cursor;
        cursor += removed[0].length;
      }
      for (; cursor < view.value.length; cursor++) positions[output++] = cursor;
    }
    return positions[index];
  };
  return { value, span(start, end) {
    return view.span(position(start), position(end - 1) + 1);
  } };
}

/** One escaped prefix character, including alternating JSON/percent layers. */
export function escapePrefix(value: string, cursor: number, marker: string): { cursor: number; marker: string } | null {
  if (marker === '%') {
    const hex = value.slice(cursor, cursor + 2).toLowerCase();
    if (hex === '25' || hex === '5c') return { cursor: cursor + 2, marker: hex === '25' ? '%' : '\\' };
  } else {
    const token = value.slice(cursor, cursor + 5);
    if (token === 'u0025' || token === 'u005c' || token === 'u005C') return { cursor: cursor + 5, marker: token === 'u0025' ? '%' : '\\' };
  }
  return null;
}
function prefixChains(view: RedactionView): Replacement[] {
  const replacements: Replacement[] = [];
  for (let index = 0; index < view.value.length; index++) {
    if (view.value[index] !== '%' && view.value[index] !== '\\') continue;
    let state = { cursor: index + 1, marker: view.value[index] }; let steps = 0;
    let next;
    while ((next = escapePrefix(view.value, state.cursor, state.marker))) { state = next; steps++; }
    if (steps > 1) { replacements.push({ start: index, end: state.cursor, value: state.marker }); index = state.cursor - 1; }
  }
  return replacements;
}

/** Canonical alphabet view used for direct encoded matches before nested decoding. */
function base64View(view: RedactionView): RedactionView {
  const alphabet = (code: number) => code >= 65 && code <= 90 || code >= 97 && code <= 122
    || code >= 48 && code <= 57 || code === 43 || code === 47 || code === 45 || code === 95;
  // A single flat buffer avoids one temporary string per separator in large or
  // binary output. Only initialized bytes are converted back into text.
  const output = Buffer.allocUnsafe(view.value.length); let length = 0;
  for (let index = 0; index < view.value.length; index++) {
    const code = view.value.charCodeAt(index);
    if (alphabet(code)) output[length++] = code === 43 ? 45 : code === 47 ? 95 : code;
  }
  const value = output.toString('latin1', 0, length);
  let positions: Int32Array | undefined;
  const position = (index: number): number => {
    if (!positions && (index < 16 || length - 1 - index < 16)) {
      const backwards = index >= 16;
      let remaining = backwards ? length - 1 - index : index;
      for (let cursor = backwards ? view.value.length - 1 : 0; backwards ? cursor >= 0 : cursor < view.value.length; cursor += backwards ? -1 : 1) {
        if (alphabet(view.value.charCodeAt(cursor)) && remaining-- === 0) return cursor;
      }
    }
    if (!positions) {
      positions = new Int32Array(length); let target = 0;
      for (let cursor = 0; cursor < view.value.length; cursor++) if (alphabet(view.value.charCodeAt(cursor))) positions[target++] = cursor;
    }
    return positions[index];
  };
  return { value, base64: true, span(start, end, padding = 0) {
    return view.span(position(start), paddingEnd(view.value, position(end - 1) + 1, padding));
  } };
}

function paddingEnd(value: string, end: number, required: number): number {
  if (!required) return end;
  const padding = /^[\p{White_Space}\p{Separator}\p{Cc}\p{Cf}]*=([\p{White_Space}\p{Separator}\p{Cc}\p{Cf}]*=)?/u.exec(value.slice(end));
  return padding && padding[0].replace(/[^=]/g, '').length === required ? end + padding[0].length : end;
}

/** UTF-8 islands, excluding invalid bytes rather than inventing replacement characters. */
function utf8Runs(bytes: Buffer, minimum = 1): Array<[number, number]> {
  const runs: Array<[number, number]> = []; let start = 0;
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    const size = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2
      : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
    let valid = size > 0 && index + size <= bytes.length;
    for (let step = 1; valid && step < size; step++) valid = bytes[index + step] >= 0x80 && bytes[index + step] <= 0xbf;
    if (size === 3) valid &&= first !== 0xe0 || bytes[index + 1] >= 0xa0;
    if (size === 3) valid &&= first !== 0xed || bytes[index + 1] <= 0x9f;
    if (size === 4) valid &&= first !== 0xf0 || bytes[index + 1] >= 0x90;
    if (size === 4) valid &&= first !== 0xf4 || bytes[index + 1] <= 0x8f;
    if (valid) index += size;
    else { if (index - start >= minimum) runs.push([start, index]); start = ++index; }
  }
  if (bytes.length - start >= minimum) runs.push([start, bytes.length]);
  return runs;
}
function base64Views(view: RedactionView, minimum: number): RedactionView[] {
  // Both alphabets share sextet values. Every other character, including controls,
  // Unicode separators and padding, is ignored by the recoverable encoding view.
  const compact: RedactionView = { value: view.value, span: (a, b) => [a, b] };
  const results: RedactionView[] = [];
  for (let offset = 0; offset < 4; offset++) {
    const bytes = Buffer.from(compact.value.slice(offset), 'base64url');
    if (bytes.length < minimum) continue;
    // Invalid UTF-8 bytes are barriers for literal matching, but a subsequent
    // Base64 projection may discard them without fabricating Unicode characters.
    const byteText = bytes.toString('latin1');
    const byteView: RedactionView = { value: byteText, span(a, b) {
      const [from, to] = compact.span(offset + Math.floor(a * 8 / 6), offset + Math.ceil(b * 8 / 6));
      return view.span(from, to, (3 - b % 3) % 3);
    } };
    const projected = base64View(byteView);
    if (projected.value.length >= Math.ceil(minimum * 4 / 3)) results.push(projected);
    const utf8 = '(?:[\\x00-\\x7f]|[\\xc2-\\xdf][\\x80-\\xbf]|\\xe0[\\xa0-\\xbf][\\x80-\\xbf]|[\\xe1-\\xec\\xee-\\xef][\\x80-\\xbf]{2}|\\xed[\\x80-\\x9f][\\x80-\\xbf]|\\xf0[\\x90-\\xbf][\\x80-\\xbf]{2}|[\\xf1-\\xf3][\\x80-\\xbf]{3}|\\xf4[\\x80-\\x8f][\\x80-\\xbf]{2})';
    const runs: Iterable<[number, number]> = isUtf8(bytes) ? [[0, bytes.length]]
      : (function* () { for (const run of byteText.matchAll(new RegExp(`${utf8}{${Math.ceil(minimum / 2)},}`, 'g'))) yield [run.index, run.index + run[0].length] as [number, number]; })();
    for (const [start, end] of runs) {
      const value = bytes.subarray(start, end).toString('utf8');
      if (value.length < minimum) continue;
      let byteOffsets: Uint32Array | undefined;
      results.push({ value, span(a, b) {
        // A Unicode match may end between UTF-16 surrogates; include its full bytes.
        if (a && /[\uDC00-\uDFFF]/.test(value[a]) && /[\uD800-\uDBFF]/.test(value[a - 1])) a--;
        if (b < value.length && /[\uDC00-\uDFFF]/.test(value[b]) && /[\uD800-\uDBFF]/.test(value[b - 1])) b++;
        if (!byteOffsets) {
          byteOffsets = new Uint32Array(value.length + 1);
          let byte = 0;
          for (let index = 0; index < value.length;) {
            const point = value.codePointAt(index)!;
            const units = point > 0xffff ? 2 : 1;
            byteOffsets[index] = byte;
            if (units === 2) byteOffsets[index + 1] = byte;
            byte += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
            index += units; byteOffsets[index] = byte;
          }
        }
        const first = start + byteOffsets[a];
        const last = start + byteOffsets[b];
        const from = offset + Math.floor(first * 8 / 6);
        const to = offset + Math.ceil(last * 8 / 6);
        const [localStart, localEnd] = compact.span(from, to);
        return view.span(localStart, localEnd, (3 - last % 3) % 3);
      } });
    }
  }
  return results;
}

/** Decode only valid syntax; inspect actual matches before exploring further orders. */
export function visitRedactionViews(value: string, minimum: number,
  inspect: (view: RedactionView) => Array<[number, number]>, covered: (start: number, end: number) => boolean, matchCount: () => number): void {
  const stack: Array<() => void> = [];
  const empty = new Set<string>();
  let skipped = 0;
  const schedule = (view: RedactionView) => stack.push(() => {
    if (!view.value) return;
    const content = createHash('sha256').update(view.value).update(String(!!view.base64)).update(String(!!view.skipBase64)).digest('hex');
    if (empty.has(content)) return;
    if (matchCount() && covered(...view.span(0, view.value.length))) { skipped++; return; }
    const count = matchCount(); const skippedBefore = skipped;
    stack.push(() => { if (count === matchCount() && skippedBefore === skipped) empty.add(content); });
    const matches = inspect(view).sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    const explore = (end: number) => {
      if (end - cursor < minimum) return;
      const part = sliceView(view, cursor, end);
      const chains = part.base64 || !/[%\\]/.test(part.value) ? [] : prefixChains(part);
      if (part.base64) {
        stack.push(() => { for (const decoded of base64Views(part, minimum)) schedule(decoded); });
        return;
      }
      // Match canonical encoded secrets before constructing nested binary views.
      if (!part.skipBase64) stack.push(() => {
        if (!matchCount() || !covered(...part.span(0, part.value.length))) schedule(base64View(part));
        else skipped++;
      });
      stack.push(() => {
        const stripped = compactView(part, /[\p{White_Space}\p{Separator}\p{Cc}\p{Cf}]+/gu);
        if (stripped.value !== part.value && stripped.value.length >= minimum) schedule({ ...stripped, skipBase64: true });
      });
      for (const kind of ['form', 'percent', 'json'] as const) stack.push(() => {
        const decoded = escapes(part, kind, chains); if (decoded.value !== part.value) schedule(decoded);
      });
      if (chains.length) schedule(replaceView(part, chains));
    };
    // Matched spans are barriers, so decoding cannot join their neighboring text.
    for (const [start, end] of matches) { if (start > cursor) explore(start); cursor = Math.max(cursor, end); }
    explore(view.value.length);
  });
  schedule({ value, span: (start, end) => [start, end] });
  while (stack.length) stack.pop()!();
}
