import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('fails both Monaco assertions when their shared production build exceeds its deadline', () => {
  const root = mkdtempSync(join(tmpdir(), 'o8-monaco-build-failure-'));
  const receipt = join(root, 'builds');
  const report = join(root, 'vitest.json');
  const preload = join(root, 'deadline.cjs');
  try {
    // Exercise the real test and Next process. Only its deadline is shortened;
    // the process must fail, and both assertions must report failed, not skipped.
    writeFileSync(preload, `
      const childProcess = require('node:child_process');
      const { appendFileSync } = require('node:fs');
      const { syncBuiltinESMExports } = require('node:module');
      const execute = childProcess.execFileSync;
      childProcess.execFileSync = function(file, args, options) {
        if (args?.[0] === ${JSON.stringify(resolve('node_modules/next/dist/bin/next'))} && args[1] === 'build') {
          appendFileSync(${JSON.stringify(receipt)}, 'build\\n');
          return execute.call(this, file, args, { ...options, timeout: 1 });
        }
        return execute.call(this, file, args, options);
      };
      syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run',
      'tests/next-monaco-chunk-real-path.test.ts', '--maxWorkers=1', '--reporter=json', `--outputFile=${report}`], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', NODE_OPTIONS: `--require=${preload} --max-old-space-size=8192` },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const summary = JSON.parse(readFileSync(report, 'utf8'));
    expect(summary.numFailedTests).toBe(2);
    expect(summary.numPendingTests).toBe(0);
    expect(summary.testResults.flatMap((suite: { assertionResults: Array<{ status: string }> }) =>
      suite.assertionResults.map(test => test.status))).toEqual(['failed', 'failed']);
    expect(readFileSync(receipt, 'utf8').trim().split('\n')).toEqual(['build']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
