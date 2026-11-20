// Isolated counters around the real store; no production route is replaced.
import { appendFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const root = process.env.CORTEX_IDE_DATA_DIR;
if (!root || readFileSync(join(root, 'fixture-owner'), 'utf8') !== 'o8d-native-read/v1') throw Error('Owned diff-comments fixture required');
const require = createRequire(import.meta.url), Module = require('node:module');
const load = Module._load, wrapped = new WeakMap();
Module._load = function (request, ...args) {
  const exports = load.call(this, request, ...args);
  if (!/\/mobile\/diff-comments(?:\.ts)?$/.test(request)) return exports;
  if (!wrapped.has(exports)) wrapped.set(exports, Object.fromEntries(Object.entries(exports).map(([name, value]) => [name,
    ['createDiffComment', 'listDiffComments'].includes(name) ? (...input) => {
      appendFileSync(join(root, 'diff-comments-node-calls.jsonl'), name + '\n');
      return value(...input);
    } : value])));
  return wrapped.get(exports);
};
await import('./launcher-ws-owner-entry.mjs');
