import { foldAcpSecret, minimumAcpSecretLength, visitRedactionViews } from './output-normalization';
import { compileAcpMatcher } from './output-matcher';

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
