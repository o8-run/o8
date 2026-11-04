import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { splitIntegrationFiles } from '../scripts/lib/integration-shards.mjs';

const roots: string[] = [];
const fixturePids = new Set<number>();
const fixturePidFiles: string[] = [];

function fixtureGateEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.O8_INTEGRATION_SHARD;
  delete env.O8_INTEGRATION_BASELINE;
  return env;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function rememberFixturePids(): void {
  for (const pidFile of fixturePidFiles) {
    try {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (Number.isSafeInteger(pid) && pid > 0) fixturePids.add(pid);
    } catch {}
  }
}

async function waitUntilGone(pids: number[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && pids.some(isPidAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

afterEach(async () => {
  rememberFixturePids();
  const pids = [...fixturePids];
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of pids) {
      try { process.kill(pid, signal); } catch {}
    }
    await waitUntilGone(pids);
    if (!pids.some(isPidAlive)) break;
  }
  const survivors = pids.filter(isPidAlive);
  fixturePids.clear();
  fixturePidFiles.length = 0;
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  expect(survivors).toEqual([]);
});

describe('split test gate real entry point', () => {
  it.each(['measured', 'default'])('partitions a plan exactly once with a heavy file using %s weight and keeps manifest order', (source) => {
    const fixture = mkdtempSync(join(tmpdir(), 'o8-integration-weighted-shards-'));
    roots.push(fixture);
    const orderLog = join(fixture, 'order.log');
    const files = Array.from({ length: 12 }, (_, index) => join(fixture, `${String(index).padStart(2, '0')}.test.js`));
    const configPath = join(fixture, 'integration.config.mjs');
    writeFileSync(configPath, `
export default {
  test: {
    root: ${JSON.stringify(fixture)}, globals: true, include: ['*.test.js'],
    reporters: [['json', { outputFile: process.env.O8_TEST_GATE_REPORT_PATH }]],
  },
};
`);
    for (const file of files) {
      writeFileSync(file, `
import { appendFileSync } from 'node:fs';
it('records its shard execution', () => {
  appendFileSync(${JSON.stringify(orderLog)}, ${JSON.stringify(`${file}\n`)});
  expect(true).toBe(true);
});
`);
    }
    const heavy = files[5];
    const weightsPath = join(fixture, 'weights.json');
    const measured = source === 'default' ? files.filter(file => file !== heavy) : files;
    writeFileSync(weightsPath, JSON.stringify(Object.fromEntries(measured.map(file => [file, file === heavy ? 100 : 1]))));
    if (source === 'default') expect(splitIntegrationFiles([heavy], {}, 3)[0].totalSeconds).toBe(60);
    const planPath = join(fixture, 'plan.json');
    writeFileSync(planPath, JSON.stringify({ config: configPath, files, weightsPath }));
    const shards: string[][] = [];
    for (const index of [1, 2, 3]) {
      writeFileSync(orderLog, '');
      const result = spawnSync(process.execPath, ['scripts/integration-test-gate.mjs'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
        env: {
          ...fixtureGateEnv(), O8_INTEGRATION_TEST_MODE: '1', O8_INTEGRATION_TEST_PLAN: planPath,
          O8_INTEGRATION_SHARD: `${index}/3`, O8_TEST_GATE_HEARTBEAT_MS: '100000',
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const selected = readFileSync(orderLog, 'utf8').trim().split('\n');
      expect(selected).toEqual(files.filter(file => selected.includes(file)));
      shards.push(selected);
    }
    expect(shards.flat().sort()).toEqual([...files].sort());
    const heavyShard = shards.find(selected => selected.includes(heavy))!;
    for (const selected of shards.filter(selected => selected !== heavyShard)) {
      expect(heavyShard.length).toBeLessThan(selected.length);
    }
  }, 60_000);

  it('balances the committed weights across six shards within five percent without losing or duplicating files', () => {
    const weights = JSON.parse(readFileSync('tests/integration-weights.json', 'utf8')) as Record<string, number>;
    const manifest = JSON.parse(readFileSync('tests/test-classification.json', 'utf8')) as { resourceOwning: Array<{ path: string }> };
    const files = manifest.resourceOwning.map(entry => entry.path);
    const shards = splitIntegrationFiles(files, weights, 6);
    const totals = shards.map(shard => shard.totalSeconds);
    expect(Math.max(...totals)).toBeLessThanOrEqual(Math.min(...totals) * 1.05);
    expect(shards.flatMap(shard => shard.files).sort()).toEqual([...files].sort());
    expect(Object.keys(weights)).toEqual(Object.keys(weights).sort());
    expect(Object.values(weights).every(weight => Number.isInteger(weight) && weight >= 1)).toBe(true);
  });

  it('breaks equal weights by path and equal shard totals by index while retaining manifest order', () => {
    expect(splitIntegrationFiles(['c', 'a', 'b'], { a: 1, b: 1, c: 1 }, 2)).toEqual([
      { files: ['c', 'a'], totalSeconds: 2 }, { files: ['b'], totalSeconds: 1 },
    ]);
  });

  it('finishes the hermetic gate before an integration failure and reports the causal lane', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'o8-test-gate-runner-'));
    roots.push(fixture);
    const orderLog = join(fixture, 'order.log');
    const timingReport = join(fixture, 'timings.json');
    const processLog = join(fixture, 'processes.jsonl');
    const cacheInputs = join(fixture, 'cache-inputs.json');
    const config = (file: string) => `
import { writeFileSync } from 'node:fs';
import unitConfig from ${JSON.stringify(join(process.cwd(), 'config/vitest/vitest.unit.config.ts'))};
export default {
  ...unitConfig,
  plugins: [...(unitConfig.plugins ?? []), {
    name: 'record-test-cache-inputs',
    configResolved(config) {
      writeFileSync(${JSON.stringify(cacheInputs)}, JSON.stringify(config.configFileDependencies));
    },
  }],
  test: {
    ...unitConfig.test,
    projects: undefined,
    maxWorkers: 1,
    root: ${JSON.stringify(fixture)},
    globalSetup: [],
    setupFiles: [],
    globals: true,
    include: ${JSON.stringify(file === 'unit.test.js'
      ? ['a-unit.test.js', 'z-unit-isolation.test.js', 'b-browser.test.js', 'y-browser-isolation.test.js']
      : [file])},
    exclude: [],
  },
};
`;
    writeFileSync(join(fixture, 'unit.config.mjs'), config('unit.test.js'));
    writeFileSync(join(fixture, 'integration.config.mjs'), config('integration.test.js'));
    writeFileSync(join(fixture, 'fixture-value.js'), "let value = 'clean'; export const read = () => value; export const write = next => { value = next; };\n");
    writeFileSync(join(fixture, 'fixture-mock.js'), "export const value = 'clean';\n");
    writeFileSync(join(fixture, 'a-unit.test.js'), `
import { appendFileSync } from 'node:fs';
it('unit passes first', async () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'unit\\n');
  appendFileSync(${JSON.stringify(processLog)}, JSON.stringify(process.pid) + '\\n');
  (await import('./fixture-value.js')).write('dirty');
  vi.doMock('./fixture-mock.js', () => ({ value: 'mocked' }));
  expect((await import('./fixture-mock.js')).value).toBe('mocked');
  globalThis.__fixturePoison = true;
  process.env.O8_FIXTURE_POISON = '1';
  Object.prototype.fixturePoison = true;
  process.fixturePoison = true;
  process.on('o8-fixture-poison', () => {});
  process.chdir(${JSON.stringify(fixture)});
  expect(2 + 2).toBe(4);
});
`);
    writeFileSync(join(fixture, 'z-unit-isolation.test.js'), `
import { appendFileSync } from 'node:fs';
import { read } from './fixture-value.js';
import { value } from './fixture-mock.js';
it('keeps module globals and environment isolated between pooled files', () => {
  appendFileSync(${JSON.stringify(processLog)}, JSON.stringify(process.pid) + '\\n');
  expect(read()).toBe('clean');
  expect(value).toBe('clean');
  expect(globalThis.__fixturePoison).toBeUndefined();
  expect(process.env.O8_FIXTURE_POISON).toBeUndefined();
  expect(Object.prototype.fixturePoison).toBeUndefined();
  expect(process.fixturePoison).toBeUndefined();
  expect(process.listenerCount('o8-fixture-poison')).toBe(0);
  expect(process.cwd()).toBe(${JSON.stringify(process.cwd())});
});
`);
    writeFileSync(join(fixture, 'b-browser.test.js'), `// @vitest-environment jsdom
it('poisons only its disposable browser fixture', () => {
  document.body.innerHTML = '<p>old document</p>';
  localStorage.setItem('fixture', 'old storage');
  Storage.prototype.fixturePoison = true;
  window.addEventListener('fixture-event', () => { globalThis.fixtureEvent = true; });
});
`);
    writeFileSync(join(fixture, 'y-browser-isolation.test.js'), `// @vitest-environment jsdom
it('gets fresh browser storage, prototypes, nodes and event listeners', () => {
  expect(document.body.textContent).toBe('');
  expect(localStorage.getItem('fixture')).toBeNull();
  expect(Storage.prototype.fixturePoison).toBeUndefined();
  window.dispatchEvent(new Event('fixture-event'));
  expect(globalThis.fixtureEvent).toBeUndefined();
});
`);
    writeFileSync(join(fixture, 'integration.test.js'), `
import { appendFileSync } from 'node:fs';
it('integration fails second', () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'integration\\n');
  expect('fixture failure').toBe('healthy');
});
`);
    const planPath = join(fixture, 'plan.json');
    writeFileSync(planPath, JSON.stringify([
      { id: 'unit', label: 'Hermetic fixture', config: join(fixture, 'unit.config.mjs') },
      { id: 'integration', label: 'Integration fixture', config: join(fixture, 'integration.config.mjs') },
    ]));

    const result = spawnSync(process.execPath, ['scripts/test-gates.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...fixtureGateEnv(),
        O8_TEST_GATE_TEST_MODE: '1',
        O8_TEST_GATE_PLAN: planPath,
        O8_TEST_GATE_HEARTBEAT_MS: '100000',
        O8_TEST_TIMING_REPORT_PATH: timingReport,
      },
    });

    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout, result.stderr).toContain('Hermetic fixture: PASS');
    expect(readFileSync(orderLog, 'utf8').trim().split('\n')).toEqual(['unit', 'integration']);
    expect(result.stdout).toContain('Integration fixture: FAIL');
    expect(result.stderr).toContain('failure-class=resource_or_integration_failure');
    const processes = readFileSync(processLog, 'utf8').trim().split('\n');
    expect(processes).toHaveLength(2);
    expect(processes[0]).not.toBe(processes[1]);
    expect(result.stdout).toContain('[test-timing] slowest files');
    expect(result.stdout).toContain('[test-timing] phase totals');
    const dependencies = JSON.parse(readFileSync(cacheInputs, 'utf8')) as string[];
    for (const file of ['test-timing-reporter.ts', 'duration-sequencer.ts', 'hermetic-durations.json']) {
      expect(dependencies.some(path => path.replaceAll('\\', '/').endsWith(`/config/vitest/${file}`)), file).toBe(false);
    }
    const timings = JSON.parse(readFileSync(timingReport, 'utf8'));
    expect(timings.files).toEqual([expect.objectContaining({
      path: 'integration.test.js', tests: 1, state: 'failed',
      totalMs: expect.any(Number), collectMs: expect.any(Number),
      setupMs: expect.any(Number), testsMs: expect.any(Number),
    })]);
    expect(timings.files[0].totalMs).toBeGreaterThanOrEqual(timings.files[0].testsMs);
    expect(timings.phaseTotals).toMatchObject({
      collectMs: timings.files[0].collectMs, environmentMs: timings.files[0].environmentMs,
      setupMs: timings.files[0].setupMs, testsMs: timings.files[0].testsMs,
    });

    const estimatesPath = join(fixture, 'duration-estimates.json');
    const update = spawnSync(process.execPath, [
      'scripts/update-hermetic-durations.mjs', timingReport, estimatesPath,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(update.status, update.stderr).toBe(0);
    const estimates = JSON.parse(readFileSync(estimatesPath, 'utf8'));
    expect(Object.keys(estimates.slowFiles)).toEqual(['integration.test.js']);
    expect(estimates.defaultMs).toBeGreaterThan(0);
    expect(estimates.jsdomMs).toBeGreaterThan(0);

    // Exercise real Vitest sharding with unknown fixture paths as well as the
    // checked-in timing inventory used in CI. Every fixture must run once.
    const shardReports: string[] = [];
    for (const index of [1, 2]) {
      const reportPath = join(fixture, `shard-${index}.json`);
      shardReports.push(reportPath);
      const shard = spawnSync(process.execPath, [
        'node_modules/vitest/vitest.mjs', 'run', '--config', join(fixture, 'unit.config.mjs'),
        `--shard=${index}/2`,
      ], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 15_000,
        env: { ...fixtureGateEnv(), O8_TEST_GATE_REPORT_PATH: reportPath },
      });
      expect(shard.status, shard.stderr).toBe(0);
    }
    const files = shardReports.flatMap(path => JSON.parse(readFileSync(path, 'utf8')).testResults);
    expect(files.map(file => file.name.split('/').pop()).sort())
      .toEqual(['a-unit.test.js', 'b-browser.test.js', 'y-browser-isolation.test.js', 'z-unit-isolation.test.js']);
    const inventoryPath = join(fixture, 'inventory.json');
    writeFileSync(inventoryPath, JSON.stringify({ numTotalTests: 4, testResults: files }));
    const verifyInventory = (after: string, shards = shardReports) => spawnSync(process.execPath, [
      'scripts/verify-test-inventory.mjs', inventoryPath, after, ...shards,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    expect(verifyInventory(inventoryPath).status).toBe(0);
    const changedPath = join(fixture, 'changed-inventory.json');
    for (const change of ['count', 'file', 'skip']) {
      const changed = JSON.parse(readFileSync(inventoryPath, 'utf8'));
      if (change === 'count') changed.numTotalTests -= 1;
      if (change === 'file') changed.testResults[0].name += '.missing';
      if (change === 'skip') changed.testResults[0].assertionResults[0].status = 'skipped';
      writeFileSync(changedPath, JSON.stringify(changed));
      expect(verifyInventory(changedPath).status, change).toBe(1);
    }
    expect(verifyInventory(inventoryPath, [shardReports[0], shardReports[0]]).status).toBe(1);
  }, 40_000);

  it('gives every resource-owning file a fresh process after an earlier file fails', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'o8-integration-fresh-process-'));
    roots.push(fixture);
    const orderLog = join(fixture, 'order.log');
    const first = join(fixture, 'first.test.js');
    const second = join(fixture, 'second.test.js');
    const configPath = join(fixture, 'integration.config.mjs');
    writeFileSync(configPath, `
export default {
  test: {
    root: ${JSON.stringify(fixture)},
    globals: true,
    include: ['*.test.js'],
    reporters: process.env.O8_TEST_GATE_REPORT_PATH
      ? ['default', ['json', { outputFile: process.env.O8_TEST_GATE_REPORT_PATH }]]
      : ['default'],
  },
};
`);
    writeFileSync(first, `
import { appendFileSync } from 'node:fs';
it('poisons only its disposable process', () => {
  globalThis.__fixturePoison = true;
  process.env.O8_FIXTURE_POISON = '1';
  appendFileSync(${JSON.stringify(orderLog)}, 'first\\n');
  expect('broken fixture').toBe('healthy');
});
`);
    writeFileSync(second, `
import { appendFileSync } from 'node:fs';
it('starts clean after the failure', () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'second\\n');
  expect(globalThis.__fixturePoison).toBeUndefined();
  expect(process.env.O8_FIXTURE_POISON).toBeUndefined();
});
`);
    const planPath = join(fixture, 'integration-plan.json');
    writeFileSync(planPath, JSON.stringify({ config: configPath, files: [first, second] }));

    const result = spawnSync(process.execPath, ['scripts/integration-test-gate.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...fixtureGateEnv(),
        O8_INTEGRATION_TEST_MODE: '1',
        O8_INTEGRATION_TEST_PLAN: planPath,
        O8_TEST_GATE_HEARTBEAT_MS: '100000',
      },
    });

    expect(result.status).toBe(1);
    expect(readFileSync(orderLog, 'utf8').trim().split('\n')).toEqual(['first', 'second']);
    expect(result.stdout).toContain(`FAIL ${first}`);
    expect(result.stdout).toContain(`PASS ${second}`);
    expect(result.stdout).toContain('2/2 files');
  }, 40_000);

  it.skipIf(process.platform === 'win32')('resolves an alias-form and a canonical-form selection to the same vitest-canonical match, each running its body exactly once', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'o8-alias-parent-')));
    roots.push(parent);
    const canonicalRoot = join(parent, 'canonical');
    mkdirSync(canonicalRoot);
    const aliasRoot = join(parent, 'alias');
    symlinkSync(canonicalRoot, aliasRoot);
    const orderLog = join(canonicalRoot, 'order.log');
    // Selected in alias form (through the symlink) — proves the fix resolves aliases.
    const first = join(aliasRoot, 'first.test.js');
    const second = join(aliasRoot, 'second.test.js');
    // Selected in canonical form (through the real dir, no symlink hop) — proves
    // the fix doesn't regress a selection that was already correct.
    const third = join(canonicalRoot, 'third.test.js');
    const configPath = join(canonicalRoot, 'integration.config.mjs');
    writeFileSync(configPath, `
export default {
  test: {
    root: ${JSON.stringify(aliasRoot)},
    globals: true,
    include: ['*.test.js'],
    reporters: process.env.O8_TEST_GATE_REPORT_PATH
      ? ['default', ['json', { outputFile: process.env.O8_TEST_GATE_REPORT_PATH }]]
      : ['default'],
  },
};
`);
    writeFileSync(first, `
import { appendFileSync } from 'node:fs';
it('runs first through the alias path and records it ran', () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'first\\n');
  expect('fixture failure').toBe('healthy');
});
`);
    writeFileSync(second, `
import { appendFileSync } from 'node:fs';
it('runs second through the alias path and records it ran', () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'second\\n');
  expect(true).toBe(true);
});
`);
    writeFileSync(third, `
import { appendFileSync } from 'node:fs';
it('runs third through the canonical path and records it ran', () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'third\\n');
  expect(true).toBe(true);
});
`);
    const planPath = join(canonicalRoot, 'integration-plan.json');
    writeFileSync(planPath, JSON.stringify({ config: configPath, files: [first, second, third] }));

    const result = spawnSync(process.execPath, ['scripts/integration-test-gate.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...fixtureGateEnv(),
        O8_INTEGRATION_TEST_MODE: '1',
        O8_INTEGRATION_TEST_PLAN: planPath,
        O8_TEST_GATE_HEARTBEAT_MS: '100000',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('No test files found');
    expect(readFileSync(orderLog, 'utf8').trim().split('\n')).toEqual(['first', 'second', 'third']);
    expect(result.stdout).toContain(`FAIL ${first}`);
    expect(result.stdout).toContain(`PASS ${second}`);
    expect(result.stdout).toContain(`PASS ${third}`);
    expect(result.stdout).toContain('3/3 files');
  }, 40_000);

  it('reports a missing selected file as a bounded failure before spawning, keeps later files running, and never falls back to a same-prefix neighbor', () => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'o8-missing-file-')));
    roots.push(fixture);
    const orderLog = join(fixture, 'order.log');
    // Never created — this is the file under test.
    const missing = join(fixture, 'missing.test.js');
    // Configured in the include glob but NOT selected. Its filename is
    // prefixed by the missing file's filename, so a substring-filter
    // fallback (unresolved absolute path handed to vitest) would wrongly
    // match and run it in place of the missing selection.
    const neighbor = join(fixture, 'missing.test.js-neighbor.test.js');
    const valid = join(fixture, 'valid.test.js');
    const configPath = join(fixture, 'integration.config.mjs');
    writeFileSync(configPath, `
export default {
  test: {
    root: ${JSON.stringify(fixture)},
    globals: true,
    include: ['*.test.js'],
    reporters: process.env.O8_TEST_GATE_REPORT_PATH
      ? ['default', ['json', { outputFile: process.env.O8_TEST_GATE_REPORT_PATH }]]
      : ['default'],
  },
};
`);
    writeFileSync(neighbor, `
import { appendFileSync } from 'node:fs';
it('must never run because it was not selected', () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'neighbor\\n');
  expect(true).toBe(true);
});
`);
    writeFileSync(valid, `
import { appendFileSync } from 'node:fs';
it('runs after the missing selection is reported', () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'valid\\n');
  expect(true).toBe(true);
});
`);
    const planPath = join(fixture, 'integration-plan.json');
    writeFileSync(planPath, JSON.stringify({ config: configPath, files: [missing, valid] }));

    const result = spawnSync(process.execPath, ['scripts/integration-test-gate.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...fixtureGateEnv(),
        O8_INTEGRATION_TEST_MODE: '1',
        O8_INTEGRATION_TEST_PLAN: planPath,
        O8_TEST_GATE_HEARTBEAT_MS: '100000',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`FAIL ${missing}`);
    expect(result.stdout).toContain(`selected file cannot be resolved (ENOENT): ${missing}`);
    expect(result.stdout).toContain(`PASS ${valid}`);
    expect(result.stdout).toContain('2/2 files');
    expect(readFileSync(orderLog, 'utf8').trim().split('\n')).toEqual(['valid']);
  }, 40_000);

  it('times out one hanging file, verifies its tree is gone, and continues to the next file', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'o8-integration-file-timeout-'));
    roots.push(fixture);
    const orderLog = join(fixture, 'order.log');
    const hangingPidFile = join(fixture, 'hanging-worker.pid');
    fixturePidFiles.push(hangingPidFile);
    const hanging = join(fixture, 'hanging.test.js');
    const passing = join(fixture, 'passing.test.js');
    const configPath = join(fixture, 'integration.config.mjs');
    const summaryReportPath = join(fixture, 'gate-report.json');
    writeFileSync(configPath, `
export default {
  test: {
    root: ${JSON.stringify(fixture)},
    globals: true,
    include: ['*.test.js'],
    reporters: process.env.O8_TEST_GATE_REPORT_PATH
      ? ['default', ['json', { outputFile: process.env.O8_TEST_GATE_REPORT_PATH }]]
      : ['default'],
  },
};
`);
    writeFileSync(hanging, `
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
it('hangs with an escaped child', async () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'hanging\\n');
  const worker = spawn(process.execPath, ['-e', "const marker = 'o8-test-gate-hanging-worker'; setInterval(() => marker, 1000);"], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  writeFileSync(${JSON.stringify(hangingPidFile)}, String(worker.pid));
  worker.unref();
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}, 60_000);
`);
    writeFileSync(passing, `
import { appendFileSync } from 'node:fs';
it('runs after the timed-out file', () => {
  appendFileSync(${JSON.stringify(orderLog)}, 'passing\\n');
  expect(true).toBe(true);
});
`);
    const planPath = join(fixture, 'integration-plan.json');
    writeFileSync(planPath, JSON.stringify({ config: configPath, files: [hanging, passing] }));

    const result = spawnSync(process.execPath, ['scripts/integration-test-gate.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...fixtureGateEnv(),
        O8_INTEGRATION_TEST_MODE: '1',
        O8_INTEGRATION_TEST_PLAN: planPath,
        O8_TEST_GATE_FILE_TIMEOUT_MS: '3000',
        O8_TEST_GATE_HEARTBEAT_MS: '100000',
        O8_TEST_GATE_REPORT_PATH: summaryReportPath,
      },
    });
    const retainedRoot = result.stderr.match(/retained \d+ timeout receipts? under (.+)/)?.[1]?.trim();
    if (retainedRoot) roots.push(retainedRoot);
    rememberFixturePids();
    const hangingPid = [...fixturePids][0];

    expect(result.status).toBe(1);
    expect(result.error).toBeUndefined();
    expect(readFileSync(orderLog, 'utf8').trim().split('\n')).toEqual(['hanging', 'passing']);
    expect(result.stdout).toContain(`FAIL ${hanging}`);
    expect(result.stdout).toContain('timeout after 3s');
    expect(result.stdout).toContain(`PASS ${passing}`);
    expect(result.stdout).toContain('2/2 files');
    expect(result.stderr).toContain('retained 1 timeout receipt');
    expect(result.stderr).not.toContain('TREE UNCONFIRMED');
    expect(retainedRoot).toBeTruthy();
    const receipt = JSON.parse(readFileSync(join(retainedRoot!, '.o8-test-run-retain.json'), 'utf8')) as {
      reason: string;
      file: string;
      timeoutMs: number;
    };
    expect(receipt).toMatchObject({ reason: 'test_gate_file_timeout', file: hanging, timeoutMs: 3_000 });
    const report = JSON.parse(readFileSync(summaryReportPath, 'utf8')) as {
      testResults: Array<{ assertionResults: Array<{ fullName: string }> }>;
    };
    expect(report.testResults[0]?.assertionResults[0]?.fullName).toContain('timeout after 3s');
    expect(hangingPid).toBeTypeOf('number');
    expect(() => process.kill(hangingPid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  }, 40_000);
});

describe.skipIf(process.platform === 'win32')('integration gate marker-scan probe under buffered process listings', () => {
  function writePsStub(dir: string): string {
    const stubPath = join(dir, 'ps');
    writeFileSync(stubPath, `#!/usr/bin/env node
const mode = process.env.O8_TEST_PS_STUB_MODE || 'ok';
if (mode === 'fail') {
  process.exitCode = 1;
} else if (mode === 'large-clean') {
  // Deliberately > Node's spawnSync default maxBuffer (1MB) so the pre-fix
  // gate ENOBUFS-es on this scan, but the output carries no marker line
  // because the real fixture process already exited cleanly.
  const bytes = Number(process.env.O8_TEST_PS_STUB_FILLER_BYTES || 2000000);
  process.stdout.write('1 unrelated-busy-machine-process\\n');
  process.stdout.write('x'.repeat(bytes));
  process.stdout.write('\\n');
} else {
  process.stdout.write('');
}
`, { mode: 0o755 });
    return stubPath;
  }

  function runGateWithPsStub(
    fixture: string,
    file: string,
    configPath: string,
    extraEnv: Record<string, string>,
  ) {
    const stubDir = mkdtempSync(join(tmpdir(), 'o8-ps-stub-'));
    roots.push(stubDir);
    writePsStub(stubDir);
    const planPath = join(fixture, 'integration-plan.json');
    writeFileSync(planPath, JSON.stringify({ config: configPath, files: [file] }));
    return spawnSync(process.execPath, ['scripts/integration-test-gate.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...fixtureGateEnv(),
        PATH: `${stubDir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
        O8_INTEGRATION_TEST_MODE: '1',
        O8_INTEGRATION_TEST_PLAN: planPath,
        O8_TEST_GATE_HEARTBEAT_MS: '100000',
        ...extraEnv,
      },
    });
  }

  function passingFixtureConfig(fixture: string, file: string): string {
    const configPath = join(fixture, 'integration.config.mjs');
    writeFileSync(configPath, `
export default {
  test: {
    root: ${JSON.stringify(fixture)},
    globals: true,
    include: [${JSON.stringify(file)}],
    reporters: process.env.O8_TEST_GATE_REPORT_PATH
      ? ['default', ['json', { outputFile: process.env.O8_TEST_GATE_REPORT_PATH }]]
      : ['default'],
  },
};
`);
    return configPath;
  }

  it('passes a clean fixture when the marker scan output exceeds the default 1MB buffer', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'o8-ps-buffer-clean-'));
    roots.push(fixture);
    const file = join(fixture, 'clean.test.js');
    writeFileSync(file, `
it('passes and exits immediately', () => {
  expect(true).toBe(true);
});
`);
    const configPath = passingFixtureConfig(fixture, file);
    const result = runGateWithPsStub(fixture, file, configPath, { O8_TEST_PS_STUB_MODE: 'large-clean' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`PASS ${file}`);
    expect(result.stdout).not.toContain('could not be confirmed stopped');
  }, 40_000);

  it('fails and reports a sanitized diagnostic when the marker scan itself is unavailable', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'o8-ps-buffer-unavailable-'));
    roots.push(fixture);
    const file = join(fixture, 'clean.test.js');
    writeFileSync(file, `
it('passes and exits immediately', () => {
  expect(true).toBe(true);
});
`);
    const configPath = passingFixtureConfig(fixture, file);
    const result = runGateWithPsStub(fixture, file, configPath, { O8_TEST_PS_STUB_MODE: 'fail' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('could not be confirmed stopped');
    expect(result.stdout).toContain('process scan unavailable');
    expect(result.stdout).toContain('exitStatus=1');
  }, 40_000);

  it('leaves a real process carrying an unrelated marker running and untouched', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'o8-marker-scope-'));
    roots.push(fixture);
    const sentinelPidFile = join(fixture, 'sentinel.pid');
    fixturePidFiles.push(sentinelPidFile);
    const file = join(fixture, 'clean.test.js');
    writeFileSync(file, `
it('passes and exits immediately', () => {
  expect(true).toBe(true);
});
`);
    const configPath = passingFixtureConfig(fixture, file);

    // A real, test-owned, long-lived process tagged with a marker that does
    // NOT match the one the gate generates for this run. It must survive the
    // gate untouched (the scan is scoped to the gate's own marker) and is
    // cleaned up below and by the shared afterEach — never by an invented
    // PID the gate might mistakenly signal.
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, O8_TEST_FILE_MARKER: 'o8-marker-scope-unrelated-sentinel' },
    });
    writeFileSync(sentinelPidFile, String(sentinel.pid));
    sentinel.unref();

    const planPath = join(fixture, 'integration-plan.json');
    writeFileSync(planPath, JSON.stringify({ config: configPath, files: [file] }));
    const result = spawnSync(process.execPath, ['scripts/integration-test-gate.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...fixtureGateEnv(),
        O8_INTEGRATION_TEST_MODE: '1',
        O8_INTEGRATION_TEST_PLAN: planPath,
        O8_TEST_GATE_HEARTBEAT_MS: '100000',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`PASS ${file}`);
    expect(sentinel.pid).toBeTypeOf('number');
    expect(() => process.kill(sentinel.pid!, 0)).not.toThrow();
  }, 40_000);
});
