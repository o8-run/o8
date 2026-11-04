#!/usr/bin/env node
// Refresh from gate logs: node scripts/ci/integration-weights.mjs shard-*.log
// With no arguments, read a concatenated gate log from stdin instead.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const weightsPath = join(process.cwd(), 'tests/integration-weights.json');
const weights = JSON.parse(readFileSync(weightsPath, 'utf8'));
const logs = process.argv.slice(2);
const updated = new Set();
for (const source of logs.length > 0 ? logs : [0]) {
  const log = readFileSync(source, 'utf8');
  for (const line of log.split('\n')) {
    const match = /\[integration-gate\] \d+\/\d+ (?:PASS|FAIL) (.+?) · \d+\/\d+ passed · (\d+(?:\.\d+)?)s(?:\s|$)/.exec(line);
    if (!match) continue;
    weights[match[1]] = Math.max(1, Math.ceil(Number(match[2])));
    updated.add(match[1]);
  }
}
const sorted = Object.fromEntries(Object.keys(weights).sort().map(file => [file, weights[file]]));
writeFileSync(weightsPath, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`[integration-weights] updated ${updated.size} files`);
