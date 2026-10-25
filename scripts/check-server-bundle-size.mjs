#!/usr/bin/env node
// Build only server bundles, using the exact desktop-export build contract.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleServers } from './lib/server-bundles.mjs';

const args = process.argv.slice(2);
let root = fileURLToPath(new URL('..', import.meta.url));
let budgetPath = fileURLToPath(new URL('server-bundle-budget.json', import.meta.url));
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (!['--root', '--budget'].includes(flag) || !args[index + 1]) {
    throw new Error('Usage: node scripts/check-server-bundle-size.mjs [--root directory] [--budget file]');
  }
  if (flag === '--root') root = resolve(args[++index]);
  else budgetPath = resolve(args[++index]);
}

// Decimal MB matches the bundle measurements in #4630. Budgets are read-only;
// an intentional increase is reviewed as an edit to the committed JSON file.
const toleranceBytes = 1_000_000;
const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
if (!budget.outputs || typeof budget.outputs !== 'object' || Array.isArray(budget.outputs)
  || !Number.isSafeInteger(budget.totalBytes) || budget.totalBytes < 0
  || Object.values(budget.outputs).some(bytes => !Number.isSafeInteger(bytes) || bytes < 0)) {
  throw new Error('Invalid server bundle budget');
}
const outDir = mkdtempSync(join(tmpdir(), 'o8-server-size-'));
try {
  const { outputs } = bundleServers({ root, outDir });
  let failed = false;
  const compare = (key, bytes, baseline) => {
    console.log(`${key}: ${bytes} bytes (budget ${baseline}, delta ${bytes - baseline})`);
    if (bytes - baseline > toleranceBytes) {
      console.error(`${key} exceeds budget by ${bytes - baseline} bytes (allowed growth: 1 MB).`);
      failed = true;
    }
  };
  for (const output of outputs) compare(output.budgetKey, output.bytes, budget.outputs[output.budgetKey] ?? 0);
  compare('total', outputs.reduce((sum, output) => sum + output.bytes, 0), budget.totalBytes);
  if (failed) {
    console.error('Server bundle size check failed. Review growth and edit scripts/server-bundle-budget.json only if intentional.');
    process.exitCode = 1;
  } else console.log('Server bundle size check passed.');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
