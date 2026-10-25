import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const config = fileURLToPath(new URL('../../config/vitest/vitest.dated-fixtures.config.ts', import.meta.url));

export function probeDatedFixtures(root, probes) {
  const errors = [];
  for (const probe of probes) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'o8-dated-probe-')));
    try {
      const reportPath = join(directory, 'report.json');
      const env = { ...process.env, O8_DATED_FIXTURE_FILE: probe.path,
        O8_DATED_FIXTURE_NOW: String(probe.now), O8_DATED_FIXTURE_REPORT: reportPath,
        O8_LIVE_APP_TESTS: '0' };
      // Each probe owns the same isolated-data lifecycle as the regular suite.
      for (const key of ['O8_TEST_DATA_DIR_PINNED', 'O8_TEST_RUN_DATA_ROOT',
        'CORTEX_IDE_DATA_DIR', 'O8_DATA_DIR', 'O8_TEST_FIXTURE_SWEEP_PARENT']) delete env[key];
      const result = spawnSync(process.execPath, [vitest, 'run', '--config', config], {
        cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000,
      });
      let passed = false;
      try {
        const report = JSON.parse(readFileSync(reportPath, 'utf8'));
        passed = !result.error && result.status === 0 && report.success === true
          && report.numTotalTests > 0 && report.testResults?.length === 1
          && realpathSync(report.testResults[0].name) === realpathSync(join(root, probe.path));
      } catch { /* A missing/malformed report or wrong file is not verification. */ }
      const date = new Date(probe.now).toISOString();
      if (passed) {
        console.log(`[dated-fixtures] ${probe.path}: passed with Date after ${date}`);
      } else {
        errors.push(`${probe.path}: failed with Date after ${date}; pin Date before validation, including imports and earlier hooks (fixed expiry in ${probe.fixture})`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return errors;
}
