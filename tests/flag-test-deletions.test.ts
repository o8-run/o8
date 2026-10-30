import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OVERRIDE_LABEL,
  countAssertions,
  findTestRemovals,
  isTestFile,
  parseNameStatus,
  summarize,
  verdict,
} from '../scripts/ci/flag-test-deletions.mjs';

function nameStatus(...records: string[][]): string {
  return records.map((record) => `${record.join('\0')}\0`).join('');
}

function sides(base: Record<string, string>, head: Record<string, string>) {
  return [(file: string) => base[file] ?? null, (file: string) => head[file] ?? null] as const;
}

const twoChecks = "it('a', () => { expect(a).toBe(1); assert.equal(b, 2); });\n";
const oneCheck = "it('a', () => { expect(a).toBe(1); });\n";

describe('flag-test-deletions', () => {
  it('recognizes TypeScript, JavaScript and Rust test files only', () => {
    expect(['src/a.test.ts', 'tests/b.spec.tsx', 'cli/c.test.mjs', 'native/x_tests.rs'].every(isTestFile)).toBe(true);
    expect(['src/a.ts', 'docs/test.md', 'node_modules/p/a.test.js', 'src/testing.ts'].some(isTestFile)).toBe(false);
  });

  it('counts expect, assert and Rust assert macros but not commented-out checks', () => {
    const source = [
      'expect(a).toBe(1);',
      'expectTypeOf(b).toEqualTypeOf<string>();',
      'assert(c);',
      'assert.deepEqual(d, e);',
      'assert_eq!(f, g);',
      '// expect(commented).toBe(true);',
      '/* assert(block); */',
      "const url = 'http://example.test'; expect(url).toBeTruthy();",
    ].join('\n');
    expect(countAssertions(source)).toBe(6);
    expect(countAssertions(null)).toBe(0);
  });

  it('parses renames and copies with both paths', () => {
    expect(parseNameStatus(nameStatus(['M', 'a.test.ts'], ['R090', 'old.test.ts', 'new.test.ts'], ['D', 'gone.test.ts']))).toEqual([
      { status: 'M', from: 'a.test.ts', to: 'a.test.ts' },
      { status: 'R', from: 'old.test.ts', to: 'new.test.ts' },
      { status: 'D', from: 'gone.test.ts', to: 'gone.test.ts' },
    ]);
  });

  it('flags a deleted test file and fails without the override label', () => {
    const records = parseNameStatus(nameStatus(['D', 'tests/state.test.ts'], ['M', 'src/state.ts']));
    const result = findTestRemovals(records, ...sides({ 'tests/state.test.ts': twoChecks }, {}));
    expect(result.deleted).toEqual([{ file: 'tests/state.test.ts', assertions: 2 }]);
    expect(verdict(result, [])).toEqual({ flagged: true, overridden: false, failed: true });
    expect(verdict(result, [OVERRIDE_LABEL])).toEqual({ flagged: true, overridden: true, failed: false });
    expect(verdict(result, ['needs-review'])).toMatchObject({ failed: true });
  });

  it('flags a net assertion removal and names the weakened file', () => {
    const records = parseNameStatus(nameStatus(['M', 'src/lane/gate.test.ts']));
    const result = findTestRemovals(records, ...sides({ 'src/lane/gate.test.ts': twoChecks }, { 'src/lane/gate.test.ts': oneCheck }));
    expect(result).toMatchObject({ netAssertions: -1, weakened: [{ file: 'src/lane/gate.test.ts', before: 2, after: 1 }] });
    expect(verdict(result, []).failed).toBe(true);
    expect(summarize(result, verdict(result, []))).toContain('net assertions in changed test files: 2 -> 1 (-1)');
  });

  it('passes when assertions move between test files or a test is renamed', () => {
    const records = parseNameStatus(nameStatus(
      ['M', 'a.test.ts'],
      ['A', 'b.test.ts'],
      ['R100', 'old.test.ts', 'new.test.ts'],
    ));
    const result = findTestRemovals(records, ...sides(
      { 'a.test.ts': twoChecks, 'old.test.ts': oneCheck },
      { 'a.test.ts': oneCheck, 'b.test.ts': oneCheck, 'new.test.ts': oneCheck },
    ));
    expect(result.deleted).toEqual([]);
    expect(result.netAssertions).toBe(0);
    expect(verdict(result, [])).toEqual({ flagged: false, overridden: false, failed: false });
  });

  it('treats renaming a test to a non-test path as a deletion', () => {
    const records = parseNameStatus(nameStatus(['R095', 'tests/merge.test.ts', 'tests/merge.fixture.ts']));
    const result = findTestRemovals(records, ...sides({ 'tests/merge.test.ts': oneCheck }, {}));
    expect(result.deleted).toEqual([{ file: 'tests/merge.test.ts', assertions: 1 }]);
  });

  it('ignores non-test changes entirely', () => {
    const records = parseNameStatus(nameStatus(['D', 'src/old.ts'], ['M', 'README.md']));
    const result = findTestRemovals(records, () => { throw new Error('read'); }, () => { throw new Error('read'); });
    expect(result).toEqual({ deleted: [], weakened: [], before: 0, after: 0, netAssertions: 0 });
  });
});

describe('flag-test-deletions CLI', () => {
  let repo = '';
  afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

  function run(args: string[], env: Record<string, string> = {}) {
    try {
      const stdout = execFileSync(process.execPath, [join(process.cwd(), 'scripts/ci/flag-test-deletions.mjs'), ...args], {
        cwd: repo, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GITHUB_EVENT_PATH: '', GITHUB_STEP_SUMMARY: '', ...env },
      });
      return { code: 0, output: stdout };
    } catch (error) {
      const failure = error as { status: number; stderr: string };
      return { code: failure.status, output: failure.stderr };
    }
  }

  it('fails a branch that deletes a test and passes once the override label is present', () => {
    repo = mkdtempSync(join(tmpdir(), 'o8-test-deletions-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'ci@example.test');
    git('config', 'user.name', 'CI');
    mkdirSync(join(repo, 'tests'));
    writeFileSync(join(repo, 'tests/state.test.ts'), twoChecks);
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'agent');
    git('rm', '-q', 'tests/state.test.ts');
    git('commit', '-qm', 'delete');

    const blocked = run(['main', 'agent'], { TEST_DELETION_LABELS: '' });
    expect(blocked.code).toBe(1);
    expect(blocked.output).toContain('deleted test file: tests/state.test.ts (2 assertions)');

    const accepted = run(['main', 'agent'], { TEST_DELETION_LABELS: `size/S, ${OVERRIDE_LABEL}` });
    expect(accepted.code).toBe(0);
    expect(accepted.output).toContain(`override: a maintainer applied '${OVERRIDE_LABEL}'`);
  });
});
