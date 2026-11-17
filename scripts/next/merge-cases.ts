import type { MobileTranscriptEntry } from '../../src/lib/mobile/types';

export const DEFAULT_MERGE_SEED = 6327;
export const GENERATED_MERGE_COUNT = 300;
export const TRIM_CODE_POINTS = [9, 10, 11, 12, 13, 32, 160, 5760,
  ...Array.from({ length: 11 }, (_, i) => 8192 + i), 8232, 8233, 8239, 8287, 12288, 65279];
export const TRIM_NEAR_MISSES = [0, 8, 14, 133, 6158, 8191, 8203, 8204, 8234, 8288, 65278, 65535];

export interface MergeCase {
  name: string;
  current: MobileTranscriptEntry[];
  incoming: MobileTranscriptEntry[];
  expected: MobileTranscriptEntry[];
  knownDifference?: { issue: string; rust: MobileTranscriptEntry[] };
}

export function mergeSeed(value = process.env.O8_MERGE_SEED): number {
  if (value === undefined) return DEFAULT_MERGE_SEED;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 0xffffffff) {
    throw new Error('O8_MERGE_SEED must be an unsigned 32-bit decimal integer');
  }
  return Number(value);
}

/** All JSON values are round-tripped before either implementation sees them. */
export function generateMergeCases(seed = mergeSeed()): Omit<MergeCase, 'expected'>[] {
  let state = seed >>> 0;
  const random = (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
  const points = [...TRIM_CODE_POINTS, ...TRIM_NEAR_MISSES];
  const numbers = [0, -0, 0.1, -0.5, Number.MIN_VALUE, Number.MAX_VALUE,
    2 ** 53 - 1, 2 ** 53, 2 ** 53 + 2, 1e21, 1e-7];
  const entry = (id: string, text: string, timestamp = random(20)): MobileTranscriptEntry => ({
    id, role: 'assistant', text, timestamp,
  });
  return Array.from({ length: GENERATED_MERGE_COUNT }, (_, i) => {
    const point = points[i % points.length];
    const padding = String.fromCodePoint(point);
    const old = { ...entry(`old-${i}`, `${padding}text${padding}`, 1), model: 'carry' };
    const next = entry(`new-${i}`, 'text', 2);
    let current: MobileTranscriptEntry[] = [old];
    let incoming = [next];
    const mode = Math.floor(i / points.length) % 8;
    if (mode === 1 || mode === 2) {
      const n = numbers[i % numbers.length];
      const keys = mode === 1 ? ['10', '2', '4294967294', '0'] : ['01', 'a', '4294967295', '-1'];
      const args = Object.fromEntries(keys.map(key => [key, { n, values: [n, true, null, 'λ'] }]));
      const reversed = Object.fromEntries(Object.entries(args).reverse());
      old.text = next.text;
      current = [{ ...old, toolCalls: [{ name: 'Read', args, status: 'running' }] }];
      incoming = [{ ...next, toolCalls: [{ name: 'Read', args: reversed, status: 'done' }] }];
    } else if (mode === 3) {
      current = [entry('a', 'a', 1), entry('b', 'b', 2), entry('c', 'c', 3)];
      incoming = [entry('b', 'changed', 2)];
    } else if (mode === 4) {
      current = [old, entry('msg-local', 'local'), entry('stream:local', 'live')];
      incoming = [entry(old.id, 'revision'), next];
    } else if (mode === 5) {
      current = [old, { ...old }];
      incoming = [next, { ...next }, entry(next.id, 'revision')];
    } else if (mode === 6) {
      incoming = i % 2 ? [] : [entry('empty', '')];
      current = i % 3 ? current : [];
    } else if (mode === 7) {
      const time = numbers[i % numbers.length];
      current = [entry('old', 'old', time), entry('msg-local', 'local', time)];
      incoming = [entry('new', 'new', numbers[random(numbers.length)])];
    }
    return JSON.parse(JSON.stringify({
      name: `generated seed=${seed} case=${i} mode=${mode} U+${point.toString(16)}`,
      current, incoming,
    })) as Omit<MergeCase, 'expected'>;
  });
}

/** Object order matters for signatures, so compare serialized bytes too in the caller. */
export function firstDifference(a: unknown, b: unknown, path = ''): string | undefined {
  if (Object.is(a, b)) return undefined;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return path || '/';
  if (Array.isArray(a) !== Array.isArray(b)) return path || '/';
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const pointer = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) return pointer;
    const difference = firstDifference(left[key], right[key], pointer);
    if (difference) return difference;
  }
  if (JSON.stringify(Object.keys(left)) !== JSON.stringify(Object.keys(right))) return `${path}/@key-order`;
  return undefined;
}
