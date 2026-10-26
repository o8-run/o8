import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

const repo = process.cwd();
const root = mkdtempSync(path.join(tmpdir(), 'o8-verify-ci-'));
const workflowPath = path.join(repo, '.github/workflows/ci.yml');
const runner = path.join(repo, 'scripts/verify-ci.mjs');
const guard = path.join(repo, 'scripts/ci/check-verify-ci.mjs');
const manifest = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const bin = path.join(root, 'bin');
mkdirSync(bin);
for (const name of ['npm', 'npx', 'cargo-audit']) {
  const file = path.join(bin, name);
  writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('${manifest.packageManager.split('@')[1]}'); process.exit(0); }
fs.appendFileSync(process.env.VERIFY_FIXTURE_RECEIPT, JSON.stringify({
  tool: '${name}', args, ci: process.env.CI, nodeEnv: process.env.NODE_ENV,
  nodeOptions: process.env.NODE_OPTIONS, dataDir: process.env.CORTEX_IDE_DATA_DIR,
}) + '\\n');
console.log('fixture command completed');
process.exit(process.env.VERIFY_FIXTURE_FAIL && (args.includes(process.env.VERIFY_FIXTURE_FAIL)
  || ('${name}' === 'cargo-audit' && process.env.VERIFY_FIXTURE_FAIL === 'audit')) ? 7 : 0);
`);
  chmodSync(file, 0o700);
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

function execute(fail = '') {
  const receipt = path.join(root, `receipt-${(fail || 'pass').replace(/[^a-zA-Z0-9-]/g, '_')}.jsonl`);
  writeFileSync(receipt, '');
  const result = spawnSync(process.execPath, [runner], {
    cwd: repo, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, CI: '', NODE_ENV: 'development',
      VERIFY_FIXTURE_RECEIPT: receipt, VERIFY_FIXTURE_FAIL: fail },
  });
  const calls = readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { ...result, calls };
}

function coverage(workflow: object) {
  const fixture = path.join(root, 'ci.yml');
  writeFileSync(fixture, stringify(workflow));
  return spawnSync(process.execPath, [guard, '--workflow', fixture], { cwd: repo, encoding: 'utf8' });
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
    ['test:integration', 'Integration Tests (changed files)']])('reports failure and continues the remaining checks after %s fails', (fail, name) => {
    const result = execute(fail);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`FAIL ${name}`);
    expect(result.stdout).toContain('PASS Governance Smoke');
    expect(result.calls.filter(call => call.args.includes('test:unit'))).toHaveLength(4);
  }, 60_000);

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
