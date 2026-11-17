import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInventory } from './native-route-inventory.mjs';

const route = { path: '/api/example', methods: ['GET'], state: 'red', test: 'tests/example.test.ts', fallback: true, reason: 'Saved case only' };
const tests = new Map([[route.test, "fetch('/api/example')"]]);
test('equal route count passes', () => {
  assert.deepEqual(checkInventory([route], tests, 439, 439), []);
});
test('above-budget route count requires an explicit budget update', () => {
  assert.deepEqual(checkInventory([route], tests, 440, 439), [
    'TypeScript route count 440 does not equal budget 439; update crates/o8d/route-budget.json in this pull request',
  ]);
});
test('below-budget route count requires the matching removal budget update', () => {
  assert.deepEqual(checkInventory([route], tests, 438, 439), [
    'TypeScript route count 438 does not equal budget 439; update crates/o8d/route-budget.json in this pull request',
  ]);
});
test('an explicitly raised budget admits the matching route count', () => {
  assert.deepEqual(checkInventory([route], tests, 440, 440), []);
});
test('rejects missing per-route coverage without granting a state', () => {
  assert.deepEqual(checkInventory([route], tests, 439, 439), []);
  assert.match(checkInventory([route], tests, 440, 439).join(), /route count/);
  assert.match(checkInventory([route], new Map(), 439, 439).join(), /test/);
  assert.match(checkInventory([{ ...route, state: 'invented' }], tests, 439, 439).join(), /state/);
  assert.match(checkInventory([route, route], tests, 439, 439).join(), /duplicate/);
});
