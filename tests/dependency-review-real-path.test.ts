import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.join(process.cwd(), 'scripts/ci/review-dependency-changes.mjs');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'o8-dependency-review-'));
  roots.push(root);
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const lock = (names: string[], directory = '') => {
    const folder = path.join(root, directory);
    mkdirSync(folder, { recursive: true });
    const dependencies = Object.fromEntries(names.map(name => [name, '1.0.0']));
    writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: 'audit-fixture', version: '1.0.0', dependencies }));
    writeFileSync(path.join(folder, 'package-lock.json'), JSON.stringify({ name: 'audit-fixture', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'audit-fixture', version: '1.0.0', dependencies },
        ...Object.fromEntries(names.map(name => [`node_modules/${name}`, { version: '1.0.0' }])) } }));
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'CI Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  lock(['baseline-vulnerable']);
  git('add', '.');
  git('commit', '-qm', 'fixture base');
  const base = git('rev-parse', 'HEAD');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}
const fs = require('node:fs');
if (process.env.AUDIT_FIXTURE_INVALID) { console.log('invalid audit'); process.exit(1); }
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
if (process.env.AUDIT_FIXTURE_SHAPE === 'array') { console.log(JSON.stringify({ auditReportVersion: 2, vulnerabilities: [] })); process.exit(1); }
const vulnerabilities = {};
for (const node of Object.keys(lock.packages).filter(key => key.startsWith('node_modules/'))) {
  const name = node.slice('node_modules/'.length);
  const severity = name.includes('moderate') ? 'moderate' : 'low';
  vulnerabilities[name] = { name, severity, nodes: [process.env.AUDIT_FIXTURE_SHAPE === 'unknown node' ? 'missing/location' : node], via: [{ severity, title: 'fixture advisory' }] };
}
console.log(JSON.stringify({ auditReportVersion: 2, vulnerabilities }));
process.exit(Object.keys(vulnerabilities).length ? 1 : 0);
`);
  chmodSync(path.join(bin, 'npm'), 0o700);
  writeFileSync(path.join(bin, 'cargo-audit'), `#!${process.execPath}
const fs = require('node:fs');
const source = fs.readFileSync(process.argv.at(-1), 'utf8');
const list = [...source.matchAll(/name = "([^"]+)"\\nversion = "([^"]+)"/g)]
  .filter(match => match[1].includes('vulnerable')).map(match => ({ package: { name: match[1], version: match[2] } }));
console.log(JSON.stringify({ vulnerabilities: { list: process.env.AUDIT_FIXTURE_SHAPE === 'native invalid' ? {} : list } }));
process.exit(list.length ? 1 : 0);
`);
  chmodSync(path.join(bin, 'cargo-audit'), 0o700);
  const run = (comparison = base, head = '--worktree', extra: Record<string, string> = {}) => spawnSync(process.execPath, [script, comparison, head], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, DEPENDENCY_REVIEW_FAIL_ON_SEVERITY: 'low', ...extra },
  });
  return { root, git, lock, run, base };
}

describe('dependency additions through the shared CI audit entry point', () => {
  it.each(['low', 'moderate'])('rejects a newly introduced %s vulnerability', severity => {
    const { lock, run } = fixture();
    lock(['baseline-vulnerable', `added-${severity}`]);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain(`added-${severity}@1.0.0`);
    expect(result.stdout + result.stderr).toContain('dependency review failed');
  });

  it('accepts an unchanged vulnerable dependency instead of auditing the entire baseline', () => {
    const { root, lock, run } = fixture();
    lock(['baseline-vulnerable']);
    writeFileSync(path.join(root, 'README.md'), 'unrelated change\n');
    const result = run();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('dependency review passed');
  });

  it('reviews committed changes and nested lockfiles against the requested base', () => {
    const { git, lock, run } = fixture();
    lock(['added-low'], 'nested');
    git('add', 'nested');
    git('commit', '-qm', 'fixture dependency addition');
    const result = run(undefined, 'HEAD');
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('nested/package-lock.json');
    expect(result.stdout + result.stderr).toContain('added-low@1.0.0');
  });

  it('fails closed when the audit response is unavailable', () => {
    const { lock, run } = fixture();
    lock(['added-low']);
    const result = run(undefined, '--worktree', { AUDIT_FIXTURE_INVALID: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('audit');
  });

  it('fails closed when origin comparison history is unavailable', () => {
    const { run } = fixture();
    const result = run('missing-base');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('comparison');
  });

  it.each(['array', 'unknown node'])('fails closed on an incomplete npm report: %s', shape => {
    const { lock, run } = fixture();
    lock(['added-low']);
    const result = run(undefined, '--worktree', { AUDIT_FIXTURE_SHAPE: shape });
    expect(result.status, result.stdout).toBe(1);
    expect(result.stderr).toContain('audit');
  });

  it('rejects vulnerable additions in a nested native lockfile', () => {
    const { root, run } = fixture();
    mkdirSync(path.join(root, 'native'));
    writeFileSync(path.join(root, 'native/Cargo.lock'), 'version = 4\n[[package]]\nname = "added-vulnerable"\nversion = "1.0.0"\n');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('native/Cargo.lock: added-vulnerable@1.0.0');
  });

  it('does not attribute an existing native vulnerability to an unrelated safe addition', () => {
    const { root, git, run } = fixture();
    const file = path.join(root, 'Cargo.lock');
    const baseline = 'version = 4\n[[package]]\nname = "baseline-vulnerable"\nversion = "1.0.0"\n';
    writeFileSync(file, baseline);
    git('add', 'Cargo.lock');
    git('commit', '-qm', 'fixture native baseline');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(file, baseline + '\n[[package]]\nname = "added-safe"\nversion = "1.0.0"\n');
    const result = run(base);
    expect(result.status, result.stderr).toBe(0);
  });

  it('fails closed on an incomplete native audit report', () => {
    const { root, run } = fixture();
    writeFileSync(path.join(root, 'Cargo.lock'), 'version = 4\n[[package]]\nname = "added-vulnerable"\nversion = "1.0.0"\n');
    const result = run(undefined, '--worktree', { AUDIT_FIXTURE_SHAPE: 'native invalid' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('audit response is incomplete');
  });

  it('uses the same shared audit in CI with its low severity threshold', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain('node scripts/ci/review-dependency-changes.mjs "$BASE_REF" "$HEAD_REF"');
    expect(workflow).toContain('DEPENDENCY_REVIEW_FAIL_ON_SEVERITY: low');
  });
});
