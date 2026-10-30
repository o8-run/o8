#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'yaml';

if (process.argv.length !== 2) throw new Error('Usage: node scripts/ci/prepare-integration-policy.mjs');
const root = fileURLToPath(new URL('../../', import.meta.url));
const workflow = parse(readFileSync(path.join(root, '.github/workflows/next-surface-boundary.yml'), 'utf8'));
const pin = workflow.jobs?.boundary?.env?.POLICY_BOOTSTRAP_REF;
const checker = workflow.jobs?.boundary?.env?.CHECKER_PATH;
if (typeof pin !== 'string' || !/^[a-f0-9]{40}$/i.test(pin)) {
  throw new Error('Integration policy prerequisite requires a complete immutable checker SHA.');
}
if (typeof checker !== 'string' || !checker || checker.includes('\0')) {
  throw new Error('Integration policy prerequisite requires the declared checker path.');
}

function hasObject(spec, type) {
  const result = spawnSync('git', ['cat-file', '-t', spec], { cwd: root, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === type;
}
// The declared bootstrap commit may be outside the checked-out branch's ancestry.
const available = () => hasObject(pin, 'commit') && hasObject(`${pin}:${checker}`, 'blob');

if (!available()) {
  console.log(`[integration-policy] fetching declared checker object ${pin}`);
  execFileSync('git', ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', pin], { cwd: root, stdio: 'inherit' });
}
if (!available()) throw new Error('The declared immutable checker commit or blob is unavailable after fetch.');
console.log(`[integration-policy] ready ${pin}`);
