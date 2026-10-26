import { expect, it } from 'vitest';
import { compileAcpMatcher } from './output-matcher';

it('retains overlapping failure outputs and resets between scans', () => {
  const find = compileAcpMatcher(['he', 'she', 'hers', 'his']);
  expect(find('ushers')).toEqual(expect.arrayContaining([[1, 4], [2, 4], [2, 6]]));
  expect(find('safe')).toEqual([]);
});

it('shares UTF-16 prefixes without losing distinct UTF-8 astral alternatives', () => {
  const find = compileAcpMatcher(['%😀/', '%😁/']);
  for (const value of ['%25%F0%9F%98%80%2F', '%25%f0%9f%98%81%2f']) {
    expect(find(value)).toContainEqual([0, value.length]);
  }
});

it('retains exact matches after wide marker subsets exhaust the transition-cache budget', () => {
  const secret = '%'.repeat(512) + 'X';
  const value = '%25'.repeat(512) + 'X';
  const find = compileAcpMatcher([secret]);
  expect(find(value)).toContainEqual([0, value.length]);
  expect(find(value.slice(0, -1) + 'Y')).toEqual([]);
}, 15_000);
