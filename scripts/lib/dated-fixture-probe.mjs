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
      const casesPath = join(directory, 'cases.json');
      const env = { ...process.env, O8_DATED_FIXTURE_FILE: probe.path,
        O8_DATED_FIXTURE_NOW: String(probe.now), O8_DATED_FIXTURE_REPORT: reportPath,
        O8_DATED_FIXTURE_CASES: casesPath, O8_DATED_FIXTURE_TEST: '',
        O8_LIVE_APP_TESTS: '0' };
      // Each probe owns the same isolated-data lifecycle as the regular suite.
      for (const key of ['O8_TEST_DATA_DIR_PINNED', 'O8_TEST_RUN_DATA_ROOT',
        'CORTEX_IDE_DATA_DIR', 'O8_DATA_DIR', 'O8_TEST_FIXTURE_SWEEP_PARENT']) delete env[key];
      const options = {
        cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180_000,
      };
      const collection = spawnSync(process.execPath, [vitest, 'list', '--config', config], options);
      let passed = false;
      let count = 0;
      let stage = 'collection';
      try {
        const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
        const expectedFile = realpathSync(join(root, probe.path));
        passed = !collection.error && collection.status === 0
          && realpathSync(cases.file) === expectedFile && cases.tests.length > 0
          && cases.tests.every(test => typeof test.id === 'string' && typeof test.name === 'string')
          && new Set(cases.tests.map(test => test.id)).size === cases.tests.length;
        if (passed) {
          for (const test of cases.tests) {
            // A new process for each ID runs only that test and its ancestor
            // hooks, including parameterized tests with identical names.
            rmSync(reportPath, { force: true });
            stage = test.name;
            passed = false;
            const result = spawnSync(process.execPath, [vitest, 'run', '--config', config], {
              ...options, env: { ...env, O8_DATED_FIXTURE_TEST: test.id },
            });
            const report = JSON.parse(readFileSync(reportPath, 'utf8'));
            passed = !result.error && result.status === 0 && report.success === true
              && report.numPassedTests === 1 && report.testResults?.length === 1
              && realpathSync(report.testResults[0].name) === expectedFile;
            if (!passed) break;
            count++;
          }
        }
      } catch { passed = false; /* A missing/malformed report or wrong file is not verification. */ }
      const date = new Date(probe.now).toISOString();
      if (passed) {
        console.log(`[dated-fixtures] ${probe.path}: ${count} isolated tests passed with Date after ${date}`);
      } else {
        errors.push(`${probe.path}: ${stage} failed with Date after ${date}; pin Date before validation, including imports and earlier hooks, and restore it afterwards (fixed expiry in ${probe.fixture})`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return errors;
}
