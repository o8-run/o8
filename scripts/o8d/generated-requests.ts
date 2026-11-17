/** Deterministic request generation. Profiles must follow each handler's parsing. */
export interface ParameterDomain { name: string; valid: readonly string[]; invalid?: readonly string[]; boundary?: readonly string[] }
export interface GeneratedRequest { seed: number; caseIndex: number; path: string; kind: string }
export const DEFAULT_PARITY_SEED = 6327;
// GET list uses get(), exact enum comparisons and untrimmed lowercased q.
// It does not parse pagination; do not invent a cursor parameter for this route.
export const CHAT_LIST_PARAMETERS: readonly ParameterDomain[] = [
  { name: 'q', valid: ['fixture', 'review', 'repository', 'no-match'], boundary: [' ', '\n', 'x'.repeat(4096)] },
  { name: 'include', valid: ['orchestrator'], invalid: ['true', 'ORCHESTRATOR', ' orchestrator'] },
  { name: 'archived', valid: ['include', 'true', '1', 'only'], invalid: ['false', '0', 'ONLY', ' only'] },
  { name: 'surface', valid: ['mobile-assistant'], invalid: ['desktop', 'MOBILE-ASSISTANT', ' mobile-assistant'] },
];
export function generateRequests(options: {
  path: string; parameters: readonly ParameterDomain[]; count?: number; seed?: number;
  /** Opaque TS response cursors, only for handlers that accept before. */
  cursors?: readonly string[];
}): GeneratedRequest[] {
  const raw = options.seed ?? process.env.O8D_PARITY_SEED ?? DEFAULT_PARITY_SEED;
  const seed = Number(raw);
  if (String(raw).trim() === '' || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('Invalid O8D_PARITY_SEED: expected uint32');
  const count = options.count ?? 500;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid generated request count');
  let state = seed;
  const random = (length: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % length;
  };
  const kinds = ['missing', 'empty', 'valid', 'invalid', 'repeated', 'unicode', 'boundary', 'mixed'];
  return Array.from({ length: count }, (_, caseIndex) => {
    const query = new URLSearchParams();
    const kind = kinds[caseIndex % kinds.length];
    // Round-robin coverage guarantees every parameter sees every input class.
    const parameter = options.parameters[Math.floor(caseIndex / kinds.length) % options.parameters.length];
    if (parameter && kind !== 'missing') {
      const valid = parameter.valid.length ? parameter.valid : [''];
      const value = valid[random(valid.length)];
      if (kind === 'empty') query.append(parameter.name, '');
      else if (kind === 'valid') query.append(parameter.name, value);
      else if (kind === 'invalid') {
        const invalid = parameter.invalid?.length ? parameter.invalid : ['invalid'];
        query.append(parameter.name, invalid[random(invalid.length)]);
      } else if (kind === 'repeated') {
        const pair = Math.floor(caseIndex / (kinds.length * Math.max(1, options.parameters.length))) % 2 ? ['', value] : [value, ''];
        for (const item of pair) query.append(parameter.name, item);
      } else if (kind === 'unicode') query.append(parameter.name, ['雪', 'e\u0301', '\u{1f600}', 'İ'][random(4)]);
      else if (kind === 'boundary') {
        const boundary = parameter.boundary?.length ? parameter.boundary : [' ', '0', '-1', '2147483647'];
        query.append(parameter.name, boundary[random(boundary.length)]);
      } else {
        for (const domain of options.parameters) {
          if (random(3) === 0) continue;
          const values = ['', ...domain.valid, ...(domain.invalid ?? []), '雪'];
          query.append(domain.name, values[random(values.length)]);
        }
      }
    }
    if (kind === 'valid' && options.cursors?.length && options.parameters.some(domain => domain.name === 'before')) {
      query.set('before', options.cursors[random(options.cursors.length)]);
    }
    return { seed, caseIndex, kind, path: options.path + (query.size ? `?${query}` : '') };
  });
}
/** Pointer only; values must not leak into differential receipts. */
function differencePointer(left: unknown, right: unknown, pointer = ''): string | null {
  if (Object.is(left, right)) return null;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return pointer;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const child = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return child;
    const found = differencePointer(a[key], b[key], child);
    if (found !== null) return found;
  }
  // Sparse arrays and extra trailing holes remain distinct as JSON lengths.
  if (Array.isArray(left) && Array.isArray(right) && left.length !== right.length) return pointer;
  return null;
}
export function mismatchReceipt(request: GeneratedRequest, expected: unknown, candidate: unknown) {
  const pointer = differencePointer(expected, candidate);
  return pointer === null ? null : { seed: request.seed, caseIndex: request.caseIndex, path: request.path, pointer };
}
/** Greedy reduction for a deterministic fixture reset/replay predicate. */
export async function shrinkRequest(path: string, stillDiffers: (path: string) => Promise<boolean>): Promise<string> {
  const url = new URL(path, 'http://fixture');
  let pairs = [...url.searchParams.entries()];
  const render = (entries: string[][]) => url.pathname + (entries.length ? `?${new URLSearchParams(entries)}` : '');
  for (let index = 0; index < pairs.length;) {
    const reduced = pairs.filter((_, at) => at !== index);
    if (await stillDiffers(render(reduced))) pairs = reduced;
    else index++;
  }
  return render(pairs);
}
