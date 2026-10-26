/** A failure trie for finite spellings, plus a compiled regular automaton for
 * independently escaped characters. Marker loops represent arbitrary nesting;
 * scanning never restarts a decoder or searches a remaining suffix. */
export function compileAcpMatcher(patterns: string[], escaped = true) {
  type State = { edges: Map<string, number[]>; accept: boolean };
  const states: State[] = [];
  const state = () => (states.push({ edges: new Map(), accept: false }), states.length - 1);
  const root = state();
  const edge = (from: number, char: string, to: number) => {
    const targets = states[from].edges.get(char) ?? [];
    if (!targets.includes(to)) targets.push(to);
    states[from].edges.set(char, targets);
  };
  const spelling = (from: number, text: string, to: number, hex = false) => {
    for (let i = 0; i < text.length; i++) {
      const next = i === text.length - 1 ? to : state();
      edge(from, text[i], next);
      if (hex && /[a-f]/i.test(text[i])) edge(from, text[i].toUpperCase(), next);
      from = next;
    }
  };
  const markers = new Map<number, { percent: number; json: number }>();
  const marker = (from: number) => {
    const existing = markers.get(from); if (existing) return existing;
    const percent = state(); const json = state();
    edge(from, '%', percent); edge(from, '\\', json);
    spelling(percent, '25', percent); spelling(percent, '5c', json, true);
    spelling(json, 'u0025', percent); spelling(json, 'u005c', json, true);
    const result = { percent, json }; markers.set(from, result); return result;
  };
  const short: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', '\b': 'b', '\f': 'f', '\n': 'n', '\r': 'r', '\t': 't' };
  // Only literal-marker secrets need local ambiguous decoding. Other spellings
  // are handled by the normalization views and the failure trie below.
  const local = escaped ? patterns.filter(value => /[%\\]/.test(value)) : [];
  const trie = new Map<number, Map<string, number>>();
  const percentEdges = new Set<string>();
  for (const pattern of local) {
    let from = root;
    const positions = [from];
    for (let i = 0; i < pattern.length; i++) {
      const children = trie.get(from) ?? new Map<string, number>();
      trie.set(from, children);
      let to = children.get(pattern[i]);
      if (to === undefined) { to = state(); children.set(pattern[i], to); }
      positions.push(to); from = to;
    }
    states[from].accept = true;
    for (let i = 0; i < pattern.length; i++) {
      from = positions[i]; const to = positions[i + 1];
      // Shared trie edges are expanded once, including their escape alternatives.
      if (!states[from].edges.get(pattern[i])?.includes(to)) {
        edge(from, pattern[i], to);
        const { json } = marker(from);
        spelling(json, `u${pattern.charCodeAt(i).toString(16).padStart(4, '0')}`, to, true);
        if (short[pattern[i]] !== undefined) spelling(json, short[pattern[i]], to);
      }
      const codepoint = pattern.codePointAt(i)!;
      if (codepoint >= 0xd800 && codepoint <= 0xdfff) continue;
      const key = `${from}:${codepoint}`;
      if (percentEdges.has(key)) continue;
      percentEdges.add(key);
      const bytes = Buffer.from(String.fromCodePoint(codepoint));
      let byteFrom = marker(from).percent;
      for (let j = 0; j < bytes.length; j++) {
        const end = j === bytes.length - 1 ? positions[i + (codepoint > 0xffff ? 2 : 1)] : state();
        spelling(byteFrom, bytes[j].toString(16).padStart(2, '0'), end, true);
        if (j < bytes.length - 1) byteFrom = marker(end).percent;
      }
    }
  }
  type Node = { edges: Map<string, number>; failure: number; lengths: number[] };
  const nodes: Node[] = [{ edges: new Map(), failure: 0, lengths: [] }];
  for (const pattern of patterns) {
    let current = 0;
    for (let i = 0; i < pattern.length; i++) {
      let next = nodes[current].edges.get(pattern[i]);
      if (next === undefined) {
        next = nodes.length; nodes.push({ edges: new Map(), failure: 0, lengths: [] });
        nodes[current].edges.set(pattern[i], next);
      }
      current = next;
    }
    if (pattern.length) nodes[current].lengths.push(pattern.length);
  }
  // Resolve ASCII failure transitions once. Bound the optional dense table;
  // larger dictionaries retain the same failure-trie semantics without it.
  const ascii = nodes.length <= 16384 ? new Uint32Array(nodes.length * 128) : undefined;
  if (ascii) for (const [char, next] of nodes[0].edges) if (char.charCodeAt(0) < 128) ascii[char.charCodeAt(0)] = next;
  const queue = [...nodes[0].edges.values()];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (ascii) {
      const failure = nodes[current].failure;
      ascii.copyWithin(current * 128, failure * 128, (failure + 1) * 128);
      for (const [char, next] of nodes[current].edges) if (char.charCodeAt(0) < 128) ascii[current * 128 + char.charCodeAt(0)] = next;
    }
    for (const [char, next] of nodes[current].edges) {
      let failure = nodes[current].failure;
      while (failure && !nodes[failure].edges.has(char)) failure = nodes[failure].failure;
      nodes[next].failure = nodes[failure].edges.get(char) ?? 0;
      nodes[next].lengths.push(...nodes[nodes[next].failure].lengths);
      queue.push(next);
    }
  }
  interface DfaState { ids: number[]; transitions: Map<string, Plan> }
  interface Plan { next: DfaState; sources: number[][]; accept: number[] }
  const initial: DfaState = { ids: [], transitions: new Map() };
  const subsets = new Map<string, DfaState>([['', initial]]);
  let cachedPlans = 0; let retainedEntries = 0;
  const transition = (from: DfaState, char: string): Plan => {
    const cached = from.transitions.get(char);
    if (cached) return cached;
    const moves = new Map<number, number[]>();
    for (let i = -1; i < from.ids.length; i++) {
      for (const to of states[i < 0 ? root : from.ids[i]].edges.get(char) ?? []) {
        const sources = moves.get(to) ?? []; sources.push(i); moves.set(to, sources);
      }
    }
    const ids = [...moves.keys()].sort((a, b) => a - b);
    const key = ids.join(',');
    const next = subsets.get(key) ?? { ids, transitions: new Map() };
    const plan = { next, sources: ids.map(id => moves.get(id)!),
      accept: ids.flatMap((id, index) => states[id].accept ? [index] : []) };
    // Bound adversarial cache growth, retaining exact tagged-NFA transitions
    // after the cache fills. No pattern, state, or nesting depth is discarded.
    const entries = ids.length + plan.accept.length + plan.sources.reduce((sum, sources) => sum + sources.length + 1, 0);
    if (cachedPlans < 8192 && retainedEntries + entries <= 131072) {
      cachedPlans++; retainedEntries += entries; subsets.set(key, next); from.transitions.set(char, plan);
    }
    return plan;
  };
  return (value: string): Array<[number, number]> => {
    const ranges: Array<[number, number]> = [];
    let current = 0; let dfa = initial;
    // Tags retain the earliest source start for each state. Equal states have
    // identical futures, so later starts can be discarded without losing a span.
    let tags = new Int32Array(states.length);
    let nextTags = new Int32Array(states.length);
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      const code = value.charCodeAt(i);
      if (ascii && code < 128) current = ascii[current * 128 + code];
      else {
        while (current && !nodes[current].edges.has(char)) current = nodes[current].failure;
        current = nodes[current].edges.get(char) ?? 0;
      }
      for (const length of nodes[current].lengths) ranges.push([i + 1 - length, i + 1]);
      if (!local.length) continue;
      const plan = transition(dfa, char);
      for (let target = 0; target < plan.sources.length; target++) {
        let start = i;
        for (const source of plan.sources[target]) if (source >= 0) start = Math.min(start, tags[source]);
        nextTags[target] = start;
      }
      for (const accept of plan.accept) ranges.push([nextTags[accept], i + 1]);
      [tags, nextTags] = [nextTags, tags]; dfa = plan.next;
    }
    return ranges;
  };
}
