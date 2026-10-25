import { ACP_REDACTION_LIMIT, replaceView, visitRedactionViews } from './output-normalization';

/** Per-process snapshot: rotating a saved credential cannot unmask a resident agent. */
export function createAcpOutputRedactor(values: string[]) {
  const secrets = [...new Set(values.filter(Boolean).flatMap(value => [value, Buffer.from(value, 'utf8').toString('utf8')]))];
  const needles = [...new Set(secrets.flatMap(value => {
    const base64 = Buffer.from(value, 'utf8').toString('base64');
    const url = base64.replace(/\+/g, '-').replace(/\//g, '_');
    return [value, base64, base64.replace(/=+$/, ''), url, url.replace(/=+$/, '')];
  }))].sort((left, right) => right.length - left.length);
  const marker = ['[redacted]', '[hidden]', '•••', ''].find(value => !secrets.some(secret => value.includes(secret)))!;
  const prefixes = needles.map(needle => {
    const table = new Int32Array(needle.length);
    for (let index = 1, matched = 0; index < needle.length; index++) {
      while (matched && needle[index] !== needle[matched]) matched = table[matched - 1];
      if (needle[index] === needle[matched]) matched++;
      table[index] = matched;
    }
    return { needle, table };
  });
  const text = (value: string, maskPartial = false) => {
    if (!value || !needles.length) return value;
    const edges = new Int32Array(Math.min(value.length, ACP_REDACTION_LIMIT) + 1);
    let work = 0;
    try {
      visitRedactionViews(value, Math.min(...secrets.map(secret => secret.length)), secrets.some(secret => secret.includes('\uFFFD')), view => {
        work += view.value.length * needles.length;
        if (work > 32 * 1024 * 1024) throw new Error('Redaction match budget exceeded');
        const ranges: Array<{ start: number; end: number; value: string }> = [];
        const matched = new Int32Array(view.value.length + 1);
        for (const { needle, table } of prefixes) {
          let start = view.value.indexOf(needle);
          while (start >= 0) {
            if (view.ambiguous) throw new Error('Ambiguous encoded credential');
            matched[start]++; matched[start + needle.length]--;
            edges[view.starts[start]]++; edges[view.ends[start + needle.length - 1]]--;
            start = view.value.indexOf(needle, start + 1);
          }
          if (maskPartial) {
            let suffix = 0;
            for (const char of view.value.split('')) {
              while (suffix && char !== needle[suffix]) suffix = table[suffix - 1];
              if (char === needle[suffix]) suffix++;
              if (suffix === needle.length) suffix = table[suffix - 1];
            }
            if (suffix) { edges[view.starts[view.value.length - suffix]]++; edges[value.length]--; }
          }
        }
        // A different decoding order may already have identified this source span.
        // Mask it in every pending view before interpreting its literal escapes.
        const covered = new Int32Array(value.length + 1);
        for (let index = 0, active = 0; index < value.length; index++) {
          active += edges[index]; covered[index + 1] = covered[index] + Number(active > 0);
        }
        for (let index = 0; index < view.value.length; index++) {
          if (covered[view.ends[index]] > covered[view.starts[index]]) { matched[index]++; matched[index + 1]--; }
        }
        let active = 0; let start = 0;
        for (let index = 0; index < matched.length; index++) {
          const previous = active; active += matched[index];
          if (!previous && active) start = index;
          else if (previous && !active) ranges.push({ start, end: index, value: '\0' });
        }
        // NUL cannot occur in a saved value. Do not decode matched literal credentials
        // again or join unrelated fragments across a removed span.
        return replaceView(view, ranges);
      });
    } catch { return marker; } // Ambiguous, malformed or over-budget decoding fails closed.
    const parts: string[] = []; let active = 0; let cursor = 0;
    for (let index = 0; index < edges.length; index++) {
      const previous = active; active += edges[index];
      if (!previous && active) parts.push(value.slice(cursor, index), marker);
      else if (previous && !active) cursor = index;
    }
    parts.push(value.slice(cursor)); return parts.join('');
  };
  function redact<T>(value: T, keys = false): T {
    if (typeof value === 'string') return text(value) as T;
    if (Array.isArray(value)) return value.map(item => redact(item, keys)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [keys ? text(key) : key, redact(item, keys)])) as T;
    }
    return value;
  }
  return { redact, stream(emit: (value: string) => void) {
    let pending = ''; let refused = false;
    return (chunk: string, final = false, maskPartial = false) => {
      if (!needles.length) { if (chunk) emit(chunk); return; }
      // Later chunks can complete nested encodings. Retain the logical value until
      // its terminal boundary; discard the whole value if its hard cap is exceeded.
      if (!refused) {
        if (pending.length + chunk.length > ACP_REDACTION_LIMIT) {
          pending = ''; refused = true; emit(marker);
        } else pending += chunk;
      }
      if (final) {
        if (!refused && pending) emit(maskPartial && /[A-Za-z0-9+/_=\-\s]$/.test(pending) ? marker : text(pending, maskPartial));
        pending = ''; refused = false;
      }
    };
  } };
}
