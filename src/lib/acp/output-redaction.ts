import { escapePrefix, foldAcpSecret, minimumAcpSecretLength, visitRedactionViews } from './output-normalization';

interface CharacterChoice { value: string; end: number }
/** Local spelling choices retain literal escape syntax without whole-view states
 * for every layer of a long prefix chain. Invalid decoding never creates a choice. */
function* characters(value: string, start: number, expected: string): Generator<CharacterChoice> {
  if (value[start] === expected) yield { value: expected, end: start + 1 };
  if (value[start] !== '%' && value[start] !== '\\') return;
  let state = { marker: value[start], cursor: start + 1 };
  for (;;) {
    if (state.marker === '\\') {
      const token = /^(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/.exec(value.slice(state.cursor, state.cursor + 5));
      if (token) {
        const decoded = JSON.parse(`"\\${token[0]}"`) as string;
        if (decoded[0] === expected) yield { value: decoded, end: state.cursor + token[0].length };
      }
    } else {
      const token = /^[0-9a-fA-F]{2}/.exec(value.slice(state.cursor, state.cursor + 2));
      if (token) {
        const first = Number.parseInt(token[0], 16);
        const size = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2
          : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
        const bytes = [first]; let end = state.cursor + 2;
        for (let index = 1; index < size; index++) {
          if (value[end] !== '%' && value[end] !== '\\') break;
          let continuation = { marker: value[end], cursor: end + 1 };
          for (;;) {
            const next = escapePrefix(value, continuation.cursor, continuation.marker);
            if (!next) break;
            continuation = next;
          }
          const hex = value.slice(continuation.cursor, continuation.cursor + 2);
          if (continuation.marker !== '%' || !/^[89aAbB][0-9a-fA-F]$/.test(hex)) break;
          bytes.push(Number.parseInt(hex, 16)); end = continuation.cursor + 2;
        }
        if (size && bytes.length === size) {
          const buffer = Buffer.from(bytes); const decoded = buffer.toString('utf8');
          if (decoded[0] === expected && Buffer.from(decoded).equals(buffer)) yield { value: decoded, end };
        }
      }
    }
    const next = escapePrefix(value, state.cursor, state.marker);
    if (!next) return;
    state = next;
  }
}
function chainMatcher(secret: string) {
  if (!/[%\\]/.test(secret)) return () => [] as Array<[number, number]>;
  return (value: string): Array<[number, number]> => {
    if (!/%[0-9a-fA-F]{2}|\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/.test(value)) return [];
    const ranges: Array<[number, number]> = [];
    const findStart = (offset: number) => {
      const candidates = [value.indexOf(secret[0], offset), value.indexOf('%', offset), value.indexOf('\\', offset)].filter(index => index >= 0);
      return candidates.length ? Math.min(...candidates) : -1;
    };
    const failed = new Set<string>();
    let start = findStart(0);
    while (start >= 0) {
      const stack = [{ needle: 0, position: start, choices: characters(value, start, secret[0]) }];
      let matched = -1;
      while (stack.length) {
        const frame = stack[stack.length - 1]; const next = frame.choices.next();
        if (next.done) { failed.add(`${frame.position},${frame.needle}`); stack.pop(); continue; }
        const choice = next.value;
        if (!secret.startsWith(choice.value, frame.needle)) continue;
        const needle = frame.needle + choice.value.length;
        if (needle === secret.length) { matched = choice.end; break; }
        if (secret.length - needle > value.length - choice.end || failed.has(`${choice.end},${needle}`)) continue;
        stack.push({ needle, position: choice.end, choices: characters(value, choice.end, secret[needle]) });
      }
      if (matched >= 0) ranges.push([start, matched]);
      start = findStart(matched >= 0 ? matched : start + 1);
    }
    return ranges;
  };
}

/** Per-process snapshot: rotating a saved credential cannot unmask a resident agent. */
export function createAcpOutputRedactor(values: string[]) {
  const secrets = [...new Set(values.filter(Boolean).flatMap(value => [value, Buffer.from(value, 'utf8').toString('utf8')]))];
  const foldedSecrets = [...new Set(secrets.map(foldAcpSecret).filter(Boolean))];
  const encoded = [...new Set(secrets.map(secret => Buffer.from(secret).toString('base64url')))];
  const chainMatchers = secrets.map(chainMatcher);
  const foldedMatchers = foldedSecrets.map(chainMatcher);
  const marker = ['[redacted]', '[hidden]', '•••', ''].find(value => ![...secrets, ...foldedSecrets].some(secret => value.includes(secret)))!;
  const minimum = Math.min(...secrets.map(minimumAcpSecretLength));
  const ranges = (value: string): Array<[number, number]> => {
    if (!value || !secrets.length) return [];
    const spans: Array<[number, number]> = [];
    const covered = new Set<string>();
    visitRedactionViews(value, minimum, view => {
      const matches: Array<[number, number]> = [];
      for (const secret of view.base64 ? encoded : view.folded ? foldedSecrets : secrets) {
        let start = view.value.indexOf(secret);
        while (start >= 0) {
          const end = start + secret.length;
          const span = view.span(start, end, view.base64 ? (4 - secret.length % 4) % 4 : 0);
          spans.push(span); covered.add(String(span));
          matches.push([start, end]); start = view.value.indexOf(secret, start + 1);
        }
      }
      for (const match of view.base64 ? [] : (view.folded ? foldedMatchers : chainMatchers).flatMap(find => find(view.value))) {
        const span = view.span(...match);
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
