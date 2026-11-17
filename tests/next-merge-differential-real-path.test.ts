import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { mergeTranscriptEntries } from '@/components/desktop/thoughts/utils';
import {
  DEFAULT_MERGE_SEED, firstDifference, generateMergeCases, mergeSeed, type MergeCase,
} from '../scripts/next/merge-cases';

const fixturePath = 'native/o8-next/fixtures/merge-cases.json';
const committed = JSON.parse(readFileSync(fixturePath, 'utf8')) as MergeCase[];

it('generates identical bytes for a seed on two runs, including an override', () => {
  for (const seed of [DEFAULT_MERGE_SEED, mergeSeed(), 0, 0xffffffff]) {
    expect(JSON.stringify(generateMergeCases(seed))).toBe(JSON.stringify(generateMergeCases(seed)));
  }
  const inputs = (seed: number) => generateMergeCases(seed).map(({ current, incoming }) => ({ current, incoming }));
  expect(inputs(1)).not.toEqual(inputs(2));
  expect(mergeSeed('42')).toBe(42);
  expect(() => mergeSeed('invalid')).toThrow('unsigned 32-bit');
});

it('reports the first difference for a mutated result', () => {
  expect(firstDifference([{ text: 'oracle' }], [{ text: 'mutation' }])).toBe('/0/text');
  expect(firstDifference({ args: { a: 1, b: 2 } }, { args: { b: 2, a: 1 } })).toBe('/args/@key-order');
});

it('keeps the committed corpus equal to the real TypeScript merge oracle', () => {
  // An override records/checks an exploratory corpus; commit the default seed.
  const cases = [
    ...committed.slice(0, 5).map(({ name, current, incoming }) => ({ name, current, incoming })),
    ...generateMergeCases(mergeSeed()),
  ].map(item => ({ ...item, expected: mergeTranscriptEntries(item.current, item.incoming) }));
  if (process.env.O8_MERGE_WRITE === '1') {
    writeFileSync(fixturePath, `[\n${cases.map((item, index) => JSON.stringify(item, null, index < 5 ? 2 : undefined)).join(',\n')}\n]\n`);
    return;
  }
  expect(committed.length, `seed=${mergeSeed()} case=${Math.min(committed.length, cases.length)} first difference=/length`).toBe(cases.length);
  for (const [index, oracle] of cases.entries()) {
    const { knownDifference, ...actual } = committed[index];
    const difference = firstDifference(oracle, actual);
    expect(difference, `seed=${mergeSeed()} case=${index} ${oracle.name} first difference=${difference}`).toBeUndefined();
    // Deep equality alone ignores property insertion order used by tool signatures.
    expect(JSON.stringify(actual), `seed=${mergeSeed()} case=${index} serialized order`).toBe(JSON.stringify(oracle));
    if (knownDifference) {
      expect(knownDifference.issue).toBe('https://github.com/o8-run/o8/issues/6328');
      expect(firstDifference(knownDifference.rust, oracle.expected)).toBeDefined();
    }
  }
});
