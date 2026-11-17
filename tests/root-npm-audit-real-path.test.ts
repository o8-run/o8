import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(path.join(tmpdir(), 'root-audit-test-'));
const fixture = JSON.parse(readFileSync('tests/fixtures/npm-audit/2026-11-17.json', 'utf8'));
const entries = [{ id: 'GHSA-fc5q-39xc-vjpf', package: 'picomatch', reason: 'No patched release', expires: '2099-12-01' }];
const npm = path.join(root, 'npm');
writeFileSync(npm, `#!/usr/bin/env node
process.stdout.write(require('node:fs').readFileSync(process.env.AUDIT_FIXTURE));
process.exit(Number(process.env.AUDIT_STATUS ?? 1));
`);
chmodSync(npm, 0o755);
afterAll(() => rmSync(root, { recursive: true, force: true }));
function run(report = fixture, list = entries, status = 1) {
  writeFileSync(path.join(root, 'audit.json'), JSON.stringify(report));
  writeFileSync(path.join(root, 'exceptions.json'), JSON.stringify(list));
  return spawnSync(process.execPath, ['scripts/ci/audit-root-dependencies.mjs'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`,
      NPM_AUDIT_EXCEPTIONS: path.join(root, 'exceptions.json'), AUDIT_FIXTURE: path.join(root, 'audit.json'), AUDIT_STATUS: String(status) },
  });
}
describe('root npm audit CLI', () => {
  it('passes the recorded report with only the listed high advisory', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('npm audit passed: 0 blocking high/critical findings');
  });
  it.each(['high', 'critical'])('rejects a mixed finding with an unlisted %s advisory', severity => {
    const report = structuredClone(fixture);
    report.vulnerabilities.picomatch.via.push({ source: 9999999, name: 'picomatch', dependency: 'picomatch',
      title: 'Unlisted fixture advisory', url: 'https://github.com/advisories/GHSA-2345-6789-cfgh', severity, range: '*' });
    const result = run(report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GHSA-2345-6789-cfgh');
  });
  it('rejects an expired entry and names it', () => {
    const result = run(fixture, [{ ...entries[0], expires: '2000-01-01' }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GHSA-fc5q-39xc-vjpf (picomatch) expired');
  });
  it('rejects a stale entry and asks for removal', () => {
    const result = run(fixture, [{ ...entries[0], id: 'GHSA-2345-6789-cfgh' }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('GHSA-2345-6789-cfgh (picomatch) no longer appears; remove this entry');
  });
  it.each([{ error: { code: 'EFAIL' } }, { auditReportVersion: 2 }, { ...fixture, vulnerabilities: { broken: { severity: 'high', via: ['missing'] } } }])(
    'fails closed on invalid or unresolved audit data', report => {
      expect(run(report).status).toBe(1);
    });
  it('fails closed on an npm execution failure', () => {
    expect(run(fixture, entries, 2).status).toBe(1);
  });
});
