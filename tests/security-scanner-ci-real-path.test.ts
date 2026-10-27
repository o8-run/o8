import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { parse } from 'yaml';

const roots: string[] = [];
const id = 'GHSA-aaaa-bbbb-cccc';
const report = { vulnerabilities: { fixture: { via: [{ name: 'fixture', url: `https://github.com/advisories/${id}` }] } } };

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function run(input: unknown, allowlist: unknown = { accepted: [] }) {
  const root = mkdtempSync(join(tmpdir(), 'o8-security-ci-'));
  roots.push(root);
  writeFileSync(join(root, 'report.json'), JSON.stringify(input));
  writeFileSync(join(root, 'allowlist.json'), JSON.stringify(allowlist));
  return spawnSync(process.execPath, [resolve('scripts/ci/security-audit.mjs'), join(root, 'report.json'), join(root, 'allowlist.json')], { encoding: 'utf8' });
}

it('accepts a clean real scanner report', () => {
  const result = run({ vulnerabilities: {} });
  expect(result.status, result.stderr).toBe(0);
});

it('fails an unaccepted advisory', () => {
  const result = run(report);
  expect(result.status).toBe(1);
});

it('accepts only the named package and a current dated exception', () => {
  const exception = { id, package: 'fixture', reason: 'Fixture acceptance.', reviewBy: '2999-01-01' };
  expect(run(report, { accepted: [exception] }).status).toBe(0);
  expect(run(report, { accepted: [{ ...exception, package: 'other' }] }).status).toBe(1);
  expect(run(report, { accepted: [{ ...exception, reviewBy: '2000-01-01' }] }).status).toBe(1);
});

it.each([
  { error: { code: 'E503' } }, {},
  { vulnerabilities: { fixture: { via: [{}] } } },
  { vulnerabilities: { fixture: { via: [] } } },
  { vulnerabilities: { ...report.vulnerabilities, a: { via: ['b'] }, b: { via: ['a'] } } },
])('refuses incomplete scanner evidence: %j', input => {
  expect(run(input).status).toBe(2);
});

it('runs advisory scanning as an optional read-only job without issue creation', () => {
  const workflow = parse(readFileSync('.github/workflows/security-scanners.yml', 'utf8'));
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs.audit['continue-on-error']).toBe(true);
  expect(workflow.jobs.audit.needs).toBeUndefined();
  const commands = workflow.jobs.audit.steps.map((step: { run?: string }) => step.run ?? '').join('\n');
  expect(commands).toContain('npm audit --json');
  expect(commands).toContain('node scripts/ci/security-audit.mjs');
  expect(commands).not.toMatch(/issue (?:create|comment)/);
});

const source = 'const fixture = 1;';
const secretFinding = { File: 'fixture.ts', StartLine: 1, EndLine: 1, RuleID: 'generic-api-key', Secret: 'REDACTED', Match: 'REDACTED' };
const secretException = {
  file: 'fixture.ts', startLine: 1, endLine: 1, rule: 'generic-api-key',
  sourceSha256: createHash('sha256').update(source).digest('hex'),
  reason: 'Synthetic scanner fixture.', reviewBy: '2999-01-01',
};

function runSecrets(input: unknown, exceptions: unknown = [secretException], content = source) {
  const root = mkdtempSync(join(tmpdir(), 'o8-secrets-ci-'));
  roots.push(root);
  writeFileSync(join(root, 'fixture.ts'), content);
  writeFileSync(join(root, 'report.json'), JSON.stringify(input));
  writeFileSync(join(root, 'allowlist.json'), JSON.stringify({ gitleaks: exceptions }));
  return spawnSync(process.execPath, [resolve('scripts/ci/security-secrets.mjs'), 'report.json', 'allowlist.json'], { cwd: root, encoding: 'utf8' });
}

it('accepts only reviewed source content through the secret scanner command', () => {
  const result = runSecrets([secretFinding]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Secret matches: 1; accepted: 1; require review: 0');
  expect(runSecrets([]).status).toBe(0);
});

it('does not accept a replacement at the same reviewed location', () => {
  expect(runSecrets([secretFinding], [secretException], 'const fixture = 2;').status).toBe(1);
  expect(runSecrets([secretFinding], []).status).toBe(1);
});

it.each([
  { ...secretException, rule: 'other-rule' },
  { ...secretException, file: 'other.ts' },
  { ...secretException, startLine: 2, endLine: 2 },
  { ...secretException, reviewBy: '2000-01-01' },
])('requires the exact rule, file, span and current review date: %j', exception => {
  expect(runSecrets([secretFinding], [exception]).status).toBe(1);
});

it.each([{}, null, [{ ...secretFinding, EndLine: 2 }], [{ ...secretFinding, File: '../outside.ts' }]])('refuses incomplete secret evidence: %j', input => {
  expect(runSecrets(input).status).toBe(2);
});

it('never echoes scanner values or source contents', () => {
  const result = runSecrets([{ ...secretFinding, Secret: 'synthetic-private-marker', Match: 'synthetic-private-marker' }]);
  expect(result.status).toBe(0);
  expect(result.stdout + result.stderr).not.toContain('synthetic-private-marker');
  expect(result.stdout + result.stderr).not.toContain(source);
});

it('baselines the thirty reviewed matches and one new test fixture', () => {
  const policy = JSON.parse(readFileSync('scripts/ci/security-allowlist.json', 'utf8'));
  expect(policy.gitleaks).toHaveLength(31);
  const report = policy.gitleaks.map((entry: typeof secretException) => ({
    File: entry.file, StartLine: entry.startLine, EndLine: entry.endLine, RuleID: entry.rule,
  }));
  const root = mkdtempSync(join(tmpdir(), 'o8-reviewed-secrets-'));
  roots.push(root);
  const reportPath = join(root, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report));
  const result = spawnSync(process.execPath, ['scripts/ci/security-secrets.mjs', reportPath], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Secret matches: 31; accepted: 31; require review: 0');
});

it('runs a redacted working-tree secret scan in an independent optional job', () => {
  const workflow = parse(readFileSync('.github/workflows/security-scanners.yml', 'utf8'));
  const job = workflow.jobs.secrets;
  expect(job?.['continue-on-error']).toBe(true);
  expect(job.needs).toBeUndefined();
  const commands = job.steps.map((step: { run?: string }) => step.run ?? '').join('\n');
  expect(commands).toContain('gitleaks dir');
  expect(commands).toContain('--redact=100');
  expect(commands).toContain('sha256sum --check');
  expect(commands).toContain('node scripts/ci/security-secrets.mjs');
  expect(commands).not.toMatch(/issue (?:create|comment)/);
});
