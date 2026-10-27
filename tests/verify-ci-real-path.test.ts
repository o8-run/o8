import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

const repo = process.cwd();
const root = mkdtempSync(path.join(tmpdir(), 'o8-verify-ci-'));
const workflowPath = path.join(repo, '.github/workflows/ci.yml');
const guard = path.join(repo, 'scripts/ci/check-verify-ci.mjs');
const manifest = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const bin = path.join(root, 'bin');
mkdirSync(bin);
for (const name of ['npm', 'npx', 'cargo-audit', 'cargo']) {
  const file = path.join(bin, name);
  writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('${manifest.packageManager.split('@')[1]}'); process.exit(0); }
fs.appendFileSync(process.env.VERIFY_FIXTURE_RECEIPT, JSON.stringify({
  tool: '${name}', args, ci: process.env.CI, nodeEnv: process.env.NODE_ENV,
  nodeOptions: process.env.NODE_OPTIONS, dataDir: process.env.CORTEX_IDE_DATA_DIR,
  cargoHome: process.env.CARGO_HOME, targetDir: process.env.CARGO_TARGET_DIR,
  daemon: process.env.O8D_HTTP_TEST_BINARY, display: process.env.DISPLAY, wayland: process.env.WAYLAND_DISPLAY,
}) + '\\n');
const barrier = process.env.VERIFY_FIXTURE_BARRIER;
if (barrier) {
  const path = require('node:path');
  const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  // Classification is independent of Lint. Shard 1 also awaits discovery, so
  // requiring it to start within this barrier falsely fails slow discovery.
  const classification = args.includes('test:classification:check');
  if (args.includes('lint') || classification) {
    fs.writeFileSync(path.join(barrier, classification ? 'classification' : 'lint'), 'started');
    const peer = path.join(barrier, classification ? 'lint' : 'classification');
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(peer) && Date.now() < deadline) wait();
    if (!fs.existsSync(peer)) process.exit(9);
  }
  if (args.includes('test:unit')) fs.writeFileSync(path.join(barrier, 'unit-started'), 'started');
  if ('${name}' === 'cargo' && args[0] === 'test') {
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(path.join(barrier, 'unit-started')) && Date.now() < deadline) wait();
    if (!fs.existsSync(path.join(barrier, 'unit-started'))) process.exit(9);
  }
  const testCommand = args.includes('vitest') || args.includes('typecheck') || args.includes('test:unit') || args.includes('test:integration') || args.includes('test:classification:check');
  if (testCommand) {
    const lock = path.join(barrier, 'test-process');
    try { fs.writeFileSync(lock, 'active', { flag: 'wx' }); } catch { process.exit(8); }
    process.on('exit', () => fs.unlinkSync(lock));
    wait();
    if (args.includes('test:classification:check')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  if (args.includes('tests/release-channel-real-path.test.ts')) fs.writeFileSync(path.join(barrier, 'typecheck-complete'), 'done');
  if (args.includes('scripts/smoke-merge-requires-review.ts') && !fs.existsSync(path.join(barrier, 'typecheck-complete'))) process.exit(8);
}
if ('${name}' === 'npm' && args[0] === 'audit') {
  if (args.includes('--json')) console.log(JSON.stringify({ auditReportVersion: 2, vulnerabilities: {}, metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    dependencies: { prod: 2, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 },
  } }));
  else console.log('found 0 vulnerabilities');
} else console.log('fixture command completed');
process.exit(process.env.VERIFY_FIXTURE_FAIL && (args.includes(process.env.VERIFY_FIXTURE_FAIL)
  || ('${name}' === 'cargo-audit' && process.env.VERIFY_FIXTURE_FAIL === 'audit')) ? 7 : 0);
`);
  chmodSync(file, 0o700);
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

function execute(fail = '', parallel = false) {
  return executeFixture('tests/fixture.test.ts', false, { fail, parallel });
}

function coverage(workflow: object) {
  const fixture = path.join(root, 'ci.yml');
  writeFileSync(fixture, stringify(workflow));
  return spawnSync(process.execPath, [guard, '--workflow', fixture], { cwd: repo, encoding: 'utf8' });
}
function executeFixture(selectedFile: string, nestedDependency = false,
  { fail = '', parallel = false, discoveryMs = 0, nativeChange = '', nativeState = 'untracked', setupChange = '' } = {}) {
  const directory = mkdtempSync(path.join(root, 'verifier-fixture-'));
  const files = ['scripts/verify-ci.mjs', 'scripts/lib/verify-ci.mjs', 'scripts/ci/check-verify-ci.mjs',
    'scripts/ci/resource-owning-changed.mjs', 'scripts/ci/review-dependency-changes.mjs', 'scripts/ci/native-changes.mjs',
    '.github/workflows/ci.yml', '.github/actions/next-linux-setup/action.yml'];
  for (const file of files) {
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    copyFileSync(path.join(repo, file), path.join(directory, file));
  }
  if (setupChange) {
    const file = path.join(directory, '.github/actions/next-linux-setup/action.yml');
    const setup = parse(readFileSync(file, 'utf8'));
    if (setupChange === 'architecture') setup.runs.steps[0].with.architecture = 'arm64';
    if (setupChange === 'missing install') setup.runs.steps = setup.runs.steps.filter((step: { run?: string }) => step.run !== 'npm ci --prefer-offline');
    writeFileSync(file, stringify(setup));
  }
  symlinkSync(path.join(repo, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
  // The verifier's scheduler is under test. Keep unrelated bundle building and
  // Vitest discovery bounded, while retaining the real plan, selector and audit.
  writeFileSync(path.join(directory, 'scripts/check-server-bundle-size.mjs'), 'process.exit(0);\n');
  writeFileSync(path.join(directory, 'scripts/ci/check-hermetic-shards.mjs'), `
    import { appendFileSync } from 'node:fs';
    const started = Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${discoveryMs});
    appendFileSync(process.env.VERIFY_FIXTURE_RECEIPT, JSON.stringify({ tool: 'discovery', args: [], elapsedMs: Date.now() - started }) + '\\n');
  `);
  mkdirSync(path.join(directory, 'tests'));
  const browserFile = selectedFile;
  writeFileSync(path.join(directory, browserFile), 'base\n');
  writeFileSync(path.join(directory, 'tests/test-classification.json'), JSON.stringify({ resourceOwning: [{ path: browserFile }] }));
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'CI Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('add', 'scripts', '.github', 'tests', 'package.json');
  if (nativeChange && nativeState !== 'untracked') {
    mkdirSync(path.dirname(path.join(directory, nativeChange)), { recursive: true });
    writeFileSync(path.join(directory, nativeChange), 'base native fixture\n');
    git('add', nativeChange);
  }
  git('commit', '-qm', 'fixture base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(path.join(directory, browserFile), 'changed\n');
  if (nestedDependency) {
    const nested = path.join(directory, 'nested');
    mkdirSync(nested);
    writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: 'safe-fixture', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } }));
    writeFileSync(path.join(nested, 'package-lock.json'), JSON.stringify({ name: 'safe-fixture', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'safe-fixture', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } },
        'node_modules/is-number': { version: '7.0.0' } } }));
  }

  if (nativeChange) {
    const file = path.join(directory, nativeChange);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, nativeChange.endsWith('package-lock.json')
      ? JSON.stringify({ lockfileVersion: 3, packages: {} }) : 'native fixture change\n');
    if (nativeState === 'staged' || nativeState === 'committed') git('add', nativeChange);
    if (nativeState === 'committed') git('commit', '-qm', 'fixture native change');
  }

  const receipt = path.join(root, 'browser-receipt.jsonl');
  writeFileSync(receipt, '');
  const result = spawnSync(process.execPath, [path.join(directory, 'scripts/verify-ci.mjs')], {
    cwd: directory, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, CI: '', NODE_ENV: 'development',
      VERIFY_FIXTURE_RECEIPT: receipt, VERIFY_FIXTURE_FAIL: fail,
      DISPLAY: 'fixture-display', WAYLAND_DISPLAY: 'fixture-wayland',
      VERIFY_FIXTURE_BARRIER: parallel ? mkdtempSync(path.join(root, 'parallel-')) : '' },
  });
  const calls = readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...result, calls };
}

describe('local CI verification through its command entry point', () => {
  it('runs the CI commands, environments, classification and all four shards', () => {
    expect(manifest.scripts['verify:ci']).toBe('node scripts/verify-ci.mjs');
    const result = execute();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    for (const name of ['Type Check', 'Lint', 'Hermetic Unit Tests', 'Test Classification',
      'Governance Smoke', 'Security Audit', 'Server Bundle Size', 'Integration Tests (changed files)']) {
      expect(result.stdout).toContain(`PASS ${name}`);
    }
    const shards = result.calls.filter(call => call.args.includes('test:unit'));
    expect(shards.map(call => call.args.at(-1))).toEqual(['--shard=1/4', '--shard=2/4', '--shard=3/4', '--shard=4/4']);
    expect(shards.every(call => call.ci === 'true' && call.nodeEnv === 'test')).toBe(true);
    expect(shards.every(call => call.nodeOptions === undefined)).toBe(true);
    expect(result.calls.some(call => call.args.includes('test:classification:check'))).toBe(true);
    expect(result.calls.some(call => call.args.includes('playwright-core'))).toBe(false);
    const smoke = result.calls.find(call => call.args.includes('scripts/smoke-merge-requires-review.ts'));
    expect(smoke?.nodeOptions).toBe('--conditions=react-server');
    expect(smoke?.dataDir).toBeTruthy();
    const audit = result.calls.find(call => call.tool === 'cargo-audit');
    expect(audit?.args).toContain('src-tauri/Cargo.lock');
    const workflow = parse(readFileSync(workflowPath, 'utf8'));
    const ignores = workflow.jobs.security.steps.find((step: { name?: string }) => step.name === 'Audit Rust dependencies').with.ignore.split(',');
    for (const ignore of ignores) expect(audit.args).toContain(ignore);
  }, 60_000);

  it.each([['lint', 'Lint'], ['audit', 'Security Audit'], ['--shard=2/4', 'Hermetic Unit Tests'],
    ['test:integration', 'Integration Tests (changed files)'], ['typecheck', 'Type Check'],
    ['tests/server-bundle-size-real-path.test.ts', 'Server Bundle Size']])('reports failure and continues the remaining checks after %s fails', (fail, name) => {
    const result = execute(fail);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`FAIL ${name}`);
    expect(result.stdout).toContain('PASS Governance Smoke');
    expect(result.calls.filter(call => call.args.includes('test:unit'))).toHaveLength(4);
  }, 60_000);

  it('overlaps independent checks while isolating test processes and respecting the governance dependency', () => {
    const result = execute('', true);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS Lint');
    expect(result.stdout).toContain('PASS Hermetic Unit Tests');
    expect(result.stdout).toContain('PASS Governance Smoke');
  }, 60_000);

  it.each([0, 16_000])('keeps every check passing after successful %i ms hermetic discovery', discoveryMs => {
    const result = executeFixture('tests/fixture.test.ts', false, { parallel: true, discoveryMs });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    for (const name of ['Type Check', 'Lint', 'Test Classification', 'Hermetic Unit Tests',
      'Server Bundle Size', 'Integration Tests (changed files)', 'Security Audit', 'Governance Smoke']) {
      expect(result.stdout).toContain(`PASS ${name}`);
    }
    expect(result.stdout).not.toContain('[verify:ci] FAIL');
    expect(result.stderr).not.toContain('exceeded its CI timeout');
    const discovery = result.calls.findIndex(call => call.tool === 'discovery');
    expect(discovery).toBeGreaterThanOrEqual(0);
    expect(result.calls[discovery].elapsedMs).toBeGreaterThanOrEqual(discoveryMs);
    const shards = result.calls.filter(call => call.args.includes('test:unit'));
    expect(shards.map(call => call.args.at(-1))).toEqual(['--shard=1/4', '--shard=2/4', '--shard=3/4', '--shard=4/4']);
    expect(result.calls.findIndex(call => call.args.includes('test:unit'))).toBeGreaterThan(discovery);
    expect(result.calls.find(call => call.args.includes('test:integration'))?.args).toContain('tests/fixture.test.ts');
  }, 60_000);

  it.each(['native/o8-next/src/main.rs', 'crates/o8d/src/main.rs', 'package-lock.json', '.cargo/config.toml', 'rust-toolchain.toml'])(
    'runs the native CI cargo commands on a local %s change', nativeChange => {
      const result = executeFixture('tests/fixture.test.ts', false, { nativeChange });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('PASS o8 next Native Tests (Linux)');
      const calls = result.calls.filter(call => call.tool === 'cargo');
      expect(calls.map(call => call.args)).toEqual([
        ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-http', '--bin', 'o8d'],
        ['test', '--locked', '--manifest-path', 'native/o8-next/Cargo.toml', '--', '--test-threads=4'],
      ]);
      for (const call of calls) {
        expect(call.ci).toBe('true');
        expect(call.targetDir).toMatch(/native\/o8-next\/target$/);
        expect(call.cargoHome).toMatch(/\.o8-next-cargo$/);
        expect(call.daemon).toBe(call.targetDir + '/debug/o8d');
      }
      expect(calls[1].display).toBeUndefined();
      expect(calls[1].wayland).toBeUndefined();
    }, 60_000,
  );

  it.each(['committed', 'staged', 'unstaged', 'untracked'])('selects a %s native change against origin/main', nativeState => {
    const result = executeFixture('tests/fixture.test.ts', false, { nativeChange: 'native/o8-next/src/main.rs', nativeState });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.calls.filter(call => call.tool === 'cargo')).toHaveLength(2);
  }, 60_000);

  it('runs native and hermetic work concurrently while retaining the required aggregate', () => {
    const result = executeFixture('tests/fixture.test.ts', false, { nativeChange: 'native/o8-next/src/main.rs', parallel: true });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS o8 next Native Tests (Linux)');
    expect(result.stdout).toContain('PASS Hermetic Unit Tests');
  }, 60_000);

  it('skips native compilation for a TS-only local change while keeping required checks green', () => {
    const result = execute();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('SKIP o8 next Native Tests (Linux): no native inputs changed');
    expect(result.calls.some(call => call.tool === 'cargo')).toBe(false);
    expect(result.stdout).toContain('PASS Hermetic Unit Tests');
  }, 60_000);

  it.each(['build', 'test'])('fails verification when the native cargo %s fails', fail => {
    const result = executeFixture('tests/fixture.test.ts', false, { nativeChange: 'native/o8-next/src/main.rs', fail });
    expect(result.status, result.stderr + result.stdout).toBe(1);
    expect(result.stdout).toContain('FAIL o8 next Native Tests (Linux)');
    expect(result.stdout).toContain('FAIL Hermetic Unit Tests');
  }, 60_000);

  it.each(['darwin', 'win32'])('explicitly classifies the Linux native suite as hosted on %s', platform => {
    const source = `import { readVerificationPlan } from './scripts/lib/verify-ci.mjs';
      const plan = readVerificationPlan(process.cwd(), undefined, { platform: '${platform}', arch: 'x64' });
      console.log(JSON.stringify({ hosted: plan.hostedJobs['o8-next-tests'], ids: plan.checks.map(check => check.id) }));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: repo, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan.hosted).toContain('Linux x64');
    expect(plan.ids).not.toContain('o8-next-tests');
  });

  it.each(['command', 'action', 'condition', 'native tolerance', 'native step tolerance',
    'aggregate tolerance', 'aggregate step tolerance', 'aggregate condition', 'checkout ref',
    'shard tolerance', 'shard step tolerance'])('rejects uncovered native execution changes: %s', change => {
    const workflow = parse(readFileSync(workflowPath, 'utf8'));
    const job = workflow.jobs['o8-next-tests'];
    if (change === 'command') job.steps.push({ run: 'cargo test --required-fixture' });
    if (change === 'action') job.steps.push({ uses: './.github/actions/required-fixture' });
    if (change === 'checkout ref') job.steps[0].with.ref = 'main';
    if (change === 'shard tolerance') workflow.jobs['test-shards']['continue-on-error'] = true;
    if (change === 'shard step tolerance') workflow.jobs['test-shards'].steps.find((step: { run?: string }) => step.run?.startsWith('npm run test:unit'))['continue-on-error'] = true;
    if (change === 'native tolerance') job['continue-on-error'] = true;
    if (change === 'native step tolerance') job.steps.find((step: { run?: string }) => step.run?.includes('cargo test'))['continue-on-error'] = true;
    if (change === 'aggregate tolerance') workflow.jobs.test['continue-on-error'] = true;
    if (change === 'aggregate step tolerance') workflow.jobs.test.steps[0]['continue-on-error'] = true;
    if (change === 'aggregate condition') workflow.jobs.test.if = 'false';
    if (change === 'condition') job.steps.find((step: { run?: string }) => step.run?.includes('cargo test')).if = 'false';
    const result = coverage(workflow);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain('verify:ci');
  });

  it.each(['architecture', 'missing install'])('rejects uncovered native prerequisite changes: %s', setupChange => {
    const result = executeFixture('tests/fixture.test.ts', false, { setupChange });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('verify:ci');
  }, 60_000);

  it('excludes Cargo scratch TypeScript while retaining native source fixtures in the real compiler config', () => {
    const target = path.join(repo, 'native/o8-next/target');
    mkdirSync(target, { recursive: true });
    const scratch = mkdtempSync(path.join(target, 'verify-ci-types-'));
    const file = path.join(scratch, 'copied-fixture.ts');
    writeFileSync(file, 'import missing from "./unavailable-fixture";\n');
    try {
      const result = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--showConfig'], {
        cwd: repo, encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const files = JSON.parse(result.stdout).files.map((entry: string) => path.resolve(repo, entry));
      expect(files).not.toContain(file);
      expect(files).toContain(path.join(repo, 'native/o8-next/src/surfaces/shortcuts/fixtures/grid_host.ts'));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 40_000);

  it.each(['native/o8-next/target', '.o8-next-cargo'])('excludes generated %s files from the real lint command', generated => {
    const directory = path.join(repo, generated);
    mkdirSync(directory, { recursive: true });
    const scratch = mkdtempSync(path.join(directory, 'verify-ci-lint-'));
    const file = path.join(scratch, 'generated.ts');
    writeFileSync(file, 'const = ;\n');
    try {
      const result = spawnSync(process.execPath, ['node_modules/eslint/bin/eslint.js', file], {
        cwd: repo, encoding: 'utf8', timeout: 30_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('ignored');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 40_000);

  it('rejects a newly added CI check before running verification work', () => {
    const workflow = parse(readFileSync(workflowPath, 'utf8'));
    workflow.jobs['required-fixture'] = { name: 'Required Fixture', 'runs-on': 'ubuntu-latest', steps: [{ run: 'npm run fixture' }] };
    const result = coverage(workflow);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required-fixture');
    expect(result.stderr).toContain('verify:ci');
  });

  it('rejects an action without local coverage inside an existing required job', () => {
    const workflow = parse(readFileSync(workflowPath, 'utf8'));
    workflow.jobs.typecheck.steps.push({ uses: './.github/actions/required-fixture' });
    const result = coverage(workflow);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('required-fixture');
  });

  it('covers the conditional browser prerequisite added to the changed integration lane', () => {
    const workflow = parse(readFileSync(workflowPath, 'utf8'));
    workflow.jobs['integration-changed'].steps = workflow.jobs['integration-changed'].steps
      .filter((step: { name?: string }) => step.name !== 'Install touched browser-test prerequisites');
    workflow.jobs['integration-changed'].steps.splice(-1, 0, {
      name: 'Install touched browser-test prerequisites',
      if: "contains(steps.select.outputs.files, 'tests/next-parity-route-ownership-real-path.test.ts') || contains(steps.select.outputs.files, 'tests/review-diff-position-real-path.test.ts') || contains(steps.select.outputs.files, 'tests/sidebar-window-layout-real-path.test.ts')",
      run: 'npx --no-install playwright-core install --with-deps chromium',
    });
    const result = coverage(workflow);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(['tests/next-parity-route-ownership-real-path.test.ts',
    'tests/review-diff-position-real-path.test.ts',
    'tests/sidebar-window-layout-real-path.test.ts',
    'tests/next-parity-route-ownership-real-path.test.ts-extra.test.ts',
    'tests/NEXT-PARITY-ROUTE-OWNERSHIP-REAL-PATH.test.ts'])('runs the CI conditional prerequisite for %s through the verifier entry point', selectedFile => {
    const result = executeFixture(selectedFile);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const calls = result.calls;
    const prerequisite = calls.findIndex(call => call.args.includes('playwright-core'));
    const integration = calls.findIndex(call => call.args.includes('test:integration'));
    expect(prerequisite).toBeGreaterThanOrEqual(0);
    expect(calls[prerequisite].args).toEqual(['--no-install', 'playwright-core', 'install', '--with-deps', 'chromium']);
    expect(integration).toBeGreaterThan(prerequisite);
  }, 60_000);


  it('accepts a safe nested is-number dependency addition through the verifier entry point', () => {
    const result = executeFixture('tests/fixture.test.ts', true);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS Security Audit');
    expect(result.calls.some(call => call.args[0] === 'audit' && call.args.includes('--json'))).toBe(true);
  }, 60_000);

  it.each(['aggregate', 'compound setup', 'step directory', 'step shell', 'job defaults', 'workflow defaults'])('rejects uncovered execution changes: %s', (change) => {
    const workflow = parse(readFileSync(workflowPath, 'utf8'));
    if (change === 'aggregate') workflow.jobs.test.steps.push({ run: 'node scripts/required-fixture.mjs' });
    if (change === 'compound setup') {
      const setup = workflow.jobs.typecheck.steps.find((step: { run?: string }) => step.run === 'npm ci --prefer-offline');
      setup.run += '\nnode scripts/required-fixture.mjs';
    }
    const lint = workflow.jobs.lint.steps.find((step: { run?: string }) => step.run?.startsWith('npm run lint'));
    if (change === 'step directory') lint['working-directory'] = 'fixture';
    if (change === 'step shell') lint.shell = 'sh';
    if (change === 'job defaults') workflow.jobs.lint.defaults = { run: { 'working-directory': 'fixture' } };
    if (change === 'workflow defaults') workflow.defaults = { run: { shell: 'sh' } };
    const result = coverage(workflow);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain('verify:ci');
  });

  it('wires the coverage guard into CI and keeps local audit failures blocking', () => {
    const workflow = parse(readFileSync(workflowPath, 'utf8'));
    expect(workflow.jobs.typecheck.steps.some((step: { run?: string }) => step.run === 'node scripts/ci/check-verify-ci.mjs')).toBe(true);
    const audit = workflow.jobs.security.steps.find((step: { name?: string }) => step.name === 'Audit root dependencies');
    expect(audit['continue-on-error']).not.toBe(true);
  });

  it('uses the CI merge-base selector for committed, staged, unstaged and untracked classified files', () => {
    const directory = path.join(root, 'selection');
    mkdirSync(path.join(directory, 'tests'), { recursive: true });
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'CI Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    const files = ['committed', 'staged', 'unstaged', 'untracked'].map(name => `tests/${name}.test.ts`);
    writeFileSync(path.join(directory, 'tests/test-classification.json'), JSON.stringify({ resourceOwning: files.map(file => ({ path: file })) }));
    for (const file of files.slice(0, 3)) writeFileSync(path.join(directory, file), 'base\n');
    git('add', '.');
    git('commit', '-qm', 'fixture base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(path.join(directory, files[0]), 'committed\n');
    git('add', files[0]);
    git('commit', '-qm', 'fixture committed assertion');
    for (const file of files.slice(1)) writeFileSync(path.join(directory, file), 'changed\n');
    git('add', files[1]);
    const selector = path.join(repo, 'scripts/ci/resource-owning-changed.mjs');
    const selected = spawnSync(process.execPath, [selector, 'origin/main', '--worktree'], { cwd: directory, encoding: 'utf8' });
    expect(selected.status, selected.stderr).toBe(0);
    expect(selected.stdout.trim().split('\n')).toEqual([...files].sort());
    const ci = spawnSync(process.execPath, [selector, 'origin/main', 'HEAD'], { cwd: directory, encoding: 'utf8' });
    expect(ci.status, ci.stderr).toBe(0);
    expect(ci.stdout.trim()).toBe(files[0]);
  });
});
