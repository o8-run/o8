import { spawnSync } from 'node:child_process';
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
