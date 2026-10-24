import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig } from 'vitest/config';
import { sharedVitestConfig } from './vitest.shared';

const repoRoot = path.resolve(__dirname, '../..');
const root = process.cwd();
const file = process.env.O8_DATED_FIXTURE_FILE;
const report = process.env.O8_DATED_FIXTURE_REPORT;
if (!file || !report) throw new Error('A dated-fixture probe requires an explicit file and report');

export default defineConfig({
  ...sharedVitestConfig,
  root,
  resolve: { alias: { ...sharedVitestConfig.resolve.alias, '@': path.join(root, 'src') } },
  test: {
    ...sharedVitestConfig.test,
    name: 'dated-fixture-probe',
    runner: path.join(repoRoot, 'config/vitest/dated-fixture-runner.ts'),
    allowOnly: false,
    // Escape literal route segments such as [taskId] rather than globbing them.
    include: [file.replace(/[\\[\]{}()*?!]/g, '\\$&')],
    globalSetup: sharedVitestConfig.test.globalSetup.map(file => path.join(repoRoot, file)),
    setupFiles: sharedVitestConfig.test.setupFiles.map(file => path.join(repoRoot, file)),
    // Load before Vitest captures its own RealDate; useRealTimers must restore
    // the probe clock too, including after Date-only setSystemTime mocks.
    execArgv: ['--import', pathToFileURL(path.join(repoRoot, 'scripts/lib/dated-fixture-clock.mjs')).href],
    sequence: { setupFiles: 'list' },
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
    reporters: [['json', { outputFile: report }]],
  },
});
