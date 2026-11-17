import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInventory } from './native-route-inventory.mjs';

const route = { path: '/api/example', methods: ['GET'], state: 'red', test: 'tests/example.test.ts', fallback: true, reason: 'Saved case only' };
const tests = new Map([[route.test, "fetch('/api/example')"]]);
test('rejects growth and missing per-route coverage without granting a state', () => {
  assert.deepEqual(checkInventory([route], tests, 439, 439), []);
  assert.match(checkInventory([route], tests, 440, 439).join(), /route count/);
  assert.match(checkInventory([route], new Map(), 439, 439).join(), /test/);
  assert.match(checkInventory([{ ...route, state: 'invented' }], tests, 439, 439).join(), /state/);
  assert.match(checkInventory([route, route], tests, 439, 439).join(), /duplicate/);
});
