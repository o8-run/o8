import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, expect, it } from 'vitest';

mkdirSync(resolve('work'), { recursive: true });
const root = mkdtempSync(resolve('work/standing-dispatch-budget-'));
const preload = join(root, 'fixture-runner.cjs');
// Only the external Vitest sample runner is finite. The speed CLI and receipt gate are real.
writeFileSync(preload, `
const cp = require('node:child_process');
const fs = require('node:fs');
cp.spawnSync = (_binary, args, options) => {
  if (!args[0].endsWith('vitest.mjs')) throw new Error('Unexpected fixture subprocess');
  fs.writeFileSync(options.env.O8_SPEED_RECEIPT, JSON.stringify({dispatchToOutputMs:Number(process.env.O8_TEST_DISPATCH_MS),runtimeSessionReused:true,tasks:2,pullRequests:2}));
  return {status:0};
};
require('node:module').syncBuiltinESMExports();
`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

it.each([1999, 2000, 3101])('enforces the under-two-second target at the speed CLI for a %i ms sample', ms => {
  const output = join(root, String(ms));
  mkdirSync(output);
  const result = spawnSync(process.execPath, ['--require', preload, 'scripts/speed/dispatch-fixture.mjs', '--standing', `--output=${output}`], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, O8_TEST_DISPATCH_MS: String(ms) },
  });
  expect(result.status, result.stderr).toBe(ms < 2000 ? 0 : 1);
  const receipt = JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8'));
  expect(receipt.samples.map((row: { dispatchToOutputMs: number }) => row.dispatchToOutputMs)).toEqual([ms, ms, ms]);
  if (ms >= 2000) expect(receipt.failures).toHaveLength(3);
});
