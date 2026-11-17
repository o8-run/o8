import { expect, it } from 'vitest';
import { generateRequests, CHAT_LIST_PARAMETERS, mismatchReceipt, shrinkRequest } from '../scripts/o8d/generated-requests';

it('generates repeatable parser-derived requests with required input classes', () => {
  const options = { path: '/api/v2/chat-history/list', parameters: CHAT_LIST_PARAMETERS, count: 500, seed: 6327 };
  const requests = generateRequests(options);
  expect(requests).toHaveLength(500);
  expect(generateRequests(options)).toEqual(requests);
  expect(generateRequests({ ...options, seed: 6328 })).not.toEqual(requests);
  expect(new Set(requests.map(request => request.kind))).toEqual(new Set(['missing', 'empty', 'valid', 'invalid', 'repeated', 'unicode', 'boundary', 'mixed']));
  for (const parameter of CHAT_LIST_PARAMETERS) {
    expect(requests.some(request => new URL(request.path, 'http://fixture').searchParams.getAll(parameter.name).length === 2)).toBe(true);
  }
});
it('uses the environment seed override and replays opaque oracle cursors', () => {
  const prior = process.env.O8D_PARITY_SEED;
  try {
    process.env.O8D_PARITY_SEED = '123';
    const options = { path: '/fixture', parameters: [{ name: 'before', valid: [''] }], cursors: ['opaque+/雪='], count: 500 };
    const requests = generateRequests(options);
    expect(requests[0].seed).toBe(123);
    expect(requests.some(request => new URL(request.path, 'http://fixture').searchParams.get('before') === 'opaque+/雪=')).toBe(true);
    process.env.O8D_PARITY_SEED = 'not-a-seed';
    expect(() => generateRequests(options)).toThrow('O8D_PARITY_SEED');
  } finally {
    if (prior === undefined) delete process.env.O8D_PARITY_SEED;
    else process.env.O8D_PARITY_SEED = prior;
  }
});
it('detects a mutated candidate field at its JSON pointer without disclosing values', () => {
  const request = generateRequests({ path: '/fixture', parameters: [], count: 1, seed: 6327 })[0];
  const oracle = { body: { conversations: [{ title: 'expected-private' }] } };
  const rust = structuredClone(oracle);
  rust.body.conversations[0].title = 'mutated-private';
  expect(mismatchReceipt(request, oracle, oracle)).toBeNull();
  const receipt = mismatchReceipt(request, oracle, rust);
  expect(receipt).toEqual({ seed: 6327, caseIndex: 0, path: '/fixture', pointer: '/body/conversations/0/title' });
  expect(JSON.stringify(receipt)).not.toContain('private');
});
it('shrinks irrelevant query pairs while preserving a mismatch', async () => {
  const path = await shrinkRequest('/fixture?q=bad&include=orchestrator&archived=only', async candidate => new URL(candidate, 'http://fixture').searchParams.has('q'));
  expect(path).toBe('/fixture?q=bad');
});
