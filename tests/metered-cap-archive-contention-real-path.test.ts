import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';

const commonPath = resolve('scripts/speed/common.mjs');
const { launch, stop } = await import(/* @vite-ignore */ commonPath);

// Each recovery scenario reopens SQLite. Use fresh processes to retain that
// coverage without sharing closed application singletons between scenarios.
it.each(['runtime', 'cli'] as const)('archives a capped session after %s artifact admission clears', async (namespace) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-cap-archive-contention-')));
  const log = join(root, 'child.log');
  let passed = false;
  const cli = join(root, 'cli');
  execFileSync(process.execPath, ['cli/esbuild.config.mjs', '--worker-output', join(cli, 'bin/o8.mjs')],
    { cwd: process.cwd(), stdio: 'pipe', timeout: 30_000 });
  const env = { ...process.env };
  for (const key of ['CORTEX_IDE_DATA_DIR', 'CORTEX_IDE_DB_PATH', 'O8_DATA_DIR', 'O8_TEST_RUN_DATA_ROOT',
    'O8_TEST_DATA_DIR_PINNED', 'O8_TEST_FIXTURE_SWEEP_PARENT', 'O8_WORKTREE_ROOT']) delete env[key];
  Object.assign(env, { TMPDIR: root, TMP: root, TEMP: root, O8_PACKAGED_APP: '0',
    O8_BUNDLED_MCP_DIR: cli, O8_TEST_CAP_ARCHIVE_CONTENTION: namespace });
  const child = launch([resolve('node_modules/vitest/vitest.mjs'), 'run', '--config',
    'config/vitest/vitest.integration.config.ts', 'tests/metered-packet-cap-real-path.test.ts',
    '-t', 'holds a metered cap stop', '--reporter=verbose'], env, log);
  onTestFinished(async () => {
    await stop(child);
    if (passed) rmSync(root, { recursive: true, force: true });
    else console.error(`[cap-archive] Retained cap archival contention evidence: ${root}`);
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exit = await new Promise<number | null>((done, reject) => {
      child.child.once('error', reject);
      child.child.once('exit', done);
      timeout = setTimeout(() => reject(new Error('Nested cap recovery test did not finish.')), 120_000);
    });
    const output = readFileSync(log, 'utf8');
    expect(output).toContain(`[cap-archive] Archive refused by the fixture's live ${namespace} lifecycle owner before release.`);
    expect(exit, output).toBe(0);
    passed = true;
  } finally { clearTimeout(timeout); }
}, 150_000);
