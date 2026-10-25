/** Match finite common representations, never decode or rewrite arbitrary agent output. */
function secretRepresentations(value: string): string[] {
  const forms = new Set([value]);
  const percentCases = (encoded: string) => {
    forms.add(encoded);
    forms.add(encoded.replace(/%[A-F0-9]{2}/g, part => part.toLowerCase()));
  };
  try { percentCases(encodeURIComponent(value)); percentCases(encodeURI(value)); }
  catch { /* Lone surrogates have no URI representation; raw/JSON/UTF-8 forms still apply. */ }
  percentCases(new URLSearchParams({ token: value }).toString().slice(6));
  const base64 = Buffer.from(value, 'utf8').toString('base64');
  forms.add(base64); forms.add(base64.replace(/=+$/, ''));
  forms.add(base64.replace(/\+/g, '-').replace(/\//g, '_'));
  forms.add(Buffer.from(value, 'utf8').toString('base64url'));
  const unicode = (char: string) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
  const escaped = JSON.stringify(value).slice(1, -1);
  const ascii = escaped.replace(/[\u007f-\uffff]/g, unicode);
  const htmlSafe = escaped.replace(/[<>&\u2028\u2029]/g, unicode);
  for (const encoded of [ascii, htmlSafe, value.split('').map(unicode).join('')]) {
    forms.add(encoded);
    forms.add(encoded.replace(/\\u[0-9a-f]{4}/g, part => part.slice(0, 2) + part.slice(2).toUpperCase()));
  }
  // Encoded values can themselves appear inside a JSON diagnostic string.
  for (const encoded of [...forms]) {
    forms.add(encoded.replace(/\//g, '\\/'));
    const json = JSON.stringify(encoded).slice(1, -1);
    forms.add(json); forms.add(json.replace(/\//g, '\\/'));
  }
  return [...forms].filter(Boolean);
}

/** Per-process snapshot: rotating a saved credential cannot unmask a resident agent. */
export function createAcpOutputRedactor(values: string[]) {
  const secrets = [...new Set([...new Set(values.filter(Boolean))].flatMap(secretRepresentations))].sort((a, b) => b.length - a.length);
  const marker = ['[redacted]', '[hidden]', '•••', ''].find(value => !secrets.some(secret => value.includes(secret)))!;
  // Accepted saved values can exceed V8's combined-regex limit after encoding.
  // Literal ranges also let overlapping credentials redact as one complete span.
  const matches = (value: string) => {
    // Keep storage proportional to output size, even for many overlapping matches.
    let edges: Int32Array | undefined;
    for (const secret of secrets) {
      let start = value.indexOf(secret);
      while (start >= 0) {
        edges ??= new Int32Array(value.length + 1);
        edges[start] += 1; edges[start + secret.length] -= 1;
        start = value.indexOf(secret, start + 1);
      }
    }
    const merged: Array<{ start: number; end: number }> = [];
    if (!edges) return merged;
    let active = 0; let start = 0;
    for (let index = 0; index < edges.length; index += 1) {
      const previous = active; active += edges[index];
      if (!previous && active) start = index;
      else if (previous && !active) merged.push({ start, end: index });
    }
    return merged;
  };
  const text = (value: string) => {
    const parts: string[] = []; let cursor = 0;
    for (const match of matches(value)) {
      parts.push(value.slice(cursor, match.start), marker); cursor = match.end;
    }
    parts.push(value.slice(cursor)); return parts.join('');
  };
  const prefixes = secrets.map(secret => {
    const table = new Array<number>(secret.length).fill(0);
    for (let i = 1, matched = 0; i < secret.length; i += 1) {
      while (matched && secret[i] !== secret[matched]) matched = table[matched - 1];
      if (secret[i] === secret[matched]) matched += 1;
      table[i] = matched;
    }
    return { secret, table };
  });
  const suffixLength = (value: string) => Math.max(0, ...prefixes.map(({ secret, table }) => {
    let matched = 0;
    for (let i = 0; i < value.length; i += 1) {
      while (matched && value[i] !== secret[matched]) matched = table[matched - 1];
      if (value[i] === secret[matched]) matched += 1;
      if (matched === secret.length) matched = table[matched - 1];
    }
    return matched;
  }));
  function redact<T>(value: T, keys = false): T {
    if (typeof value === 'string') return text(value) as T;
    if (Array.isArray(value)) return value.map(item => redact(item, keys)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [keys ? text(key) : key, redact(item, keys)])) as T;
    }
    return value;
  }
  return { redact, stream(emit: (value: string) => void) {
    let pending = '';
    return (chunk: string, final = false, maskPartial = false) => {
      pending += chunk;
      const keep = suffixLength(pending);
      if (final && maskPartial && keep) {
        emit(text(pending.slice(0, -keep)) + marker);
        pending = '';
        return;
      }
      let end = final ? pending.length : Math.max(0, pending.length - keep);
      // Never cut a complete match at the retained suffix boundary.
      for (const match of matches(pending)) {
        if (match.start >= end) break;
        end = Math.max(end, match.end);
      }
      if (end) emit(text(pending.slice(0, end)));
      pending = pending.slice(end);
    };
  } };
}
