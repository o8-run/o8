#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { readVerificationPlan } from '../lib/verify-ci.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--workflow')) throw new Error('usage: check-verify-ci.mjs [--workflow path]');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const plan = readVerificationPlan(root, args[1]);
  readVerificationPlan(root, args[1], { fullIntegration: true });
  console.log(`[verify:ci] coverage complete: ${plan.checks.length} local checks; hosted lanes explicitly classified`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
