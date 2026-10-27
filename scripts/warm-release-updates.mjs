#!/usr/bin/env node
import { warmUpdatePublication } from './lib/release-update-warmup.mjs';

try {
  const args = process.argv.slice(2);
  const allowed = new Set(['--version', '--previous-version', '--published-at', '--receipt', '--retry-ms', '--timeout-ms']);
  if (args.length % 2 || args.some((value, index) => index % 2 === 0 && !allowed.has(value))) {
    throw new Error('Invalid update publication arguments.');
  }
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) options.set(args[index], args[index + 1]);
  const receipt = await warmUpdatePublication({ root: process.cwd(), version: options.get('--version'),
    previousVersion: options.get('--previous-version'), publishedAt: options.get('--published-at'),
    receiptPath: options.get('--receipt'), retryMs: options.get('--retry-ms'), timeoutMs: options.get('--timeout-ms') });
  console.log(`[update-publication] ${receipt.status} version=${receipt.version} previous=${receipt.previousVersion} publishToOfferMs=${receipt.publishToOfferMs}`);
  if (receipt.status !== 'offered') process.exitCode = 1;
} catch (error) {
  console.error(`[update-publication] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
