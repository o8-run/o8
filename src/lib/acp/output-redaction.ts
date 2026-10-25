/** Per-process snapshot: rotating a saved credential cannot unmask a resident agent. */
export function createAcpOutputRedactor(values: string[]) {
  const secrets = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
  const pattern = secrets.length
    ? new RegExp(secrets.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    : null;
  const marker = ['[redacted]', '[hidden]', '•••', ''].find(value => !secrets.some(secret => value.includes(secret)))!;
  const text = (value: string) => pattern ? value.replace(pattern, marker) : value;
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
      if (pattern) for (const match of pending.matchAll(pattern)) {
        if (match.index >= end) break;
        end = Math.max(end, match.index + match[0].length);
      }
      if (end) emit(text(pending.slice(0, end)));
      pending = pending.slice(end);
    };
  } };
}
