import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyTestSource } from '../scripts/lib/test-classification.mjs';

const classificationScript = fileURLToPath(new URL('../scripts/classify-tests.mjs', import.meta.url));
const vitestPackage = dirname(createRequire(import.meta.url).resolve('vitest/package.json'));

function runClassification(root: string, mode: '--check' | '--write', preload?: string) {
  return spawnSync(process.execPath, [...(preload ? ['--import', pathToFileURL(preload).href] : []), classificationScript, mode], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('test factory classification', () => {
  it('routes real Git, process, APFS, and listener ownership to integration', () => {
    expect(classifyTestSource('tests/lane-real-path.test.ts', 'describe("plain", () => {})'))
      .toContain('real-path');
    expect(classifyTestSource('tests/plain.test.ts', "import { spawn } from 'node:child_process'"))
      .toContain('child-process');
    expect(classifyTestSource('tests/plain.test.ts', "execFileSync('git', ['init'])"))
      .toEqual(expect.arrayContaining(['child-process', 'git-cli']));
    expect(classifyTestSource('tests/plain.test.ts', 'const server = createServer(handler)'))
      .toContain('network-listener');
  });

  it('leaves a pure in-memory assertion in the hermetic unit lane', () => {
    expect(classifyTestSource('src/lib/math.test.ts', 'expect(1 + 1).toBe(2)')).toEqual([]);
  });

  it('classifies the real stdio peer fixture as a child process owner', () => {
    const file = 'src/lib/runtimes/shared/stdio-json-rpc.test.ts';
    expect(classifyTestSource(file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')))
      .toContain('stdio-json-rpc-peer');
  });

  it('writes list-only manifests and rejects missing or stale resource-owning paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-test-classification-'));
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests/hermetic.test.ts'), 'expect(1 + 1).toBe(2);\n');
    writeFileSync(
      join(root, 'tests/resource.test.ts'),
      ['const server = create', 'Server(handler);\n'].join(''),
    );

    try {
      const writeResult = runClassification(root, '--write');
      expect(writeResult.status).toBe(0);
      expect(writeResult.stdout).toContain('[test-classification] 1 hermetic, 1 resource-owning');

      const manifestPath = join(root, 'tests/test-classification.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(manifest).not.toHaveProperty('totalTests');
      expect(manifest).not.toHaveProperty('hermeticTests');
      expect(manifest).not.toHaveProperty('resourceOwningTests');
      expect(manifest.resourceOwning).toEqual([{
        path: 'tests/resource.test.ts',
        reasons: ['network-listener'],
      }]);

      const matchingResult = runClassification(root, '--check');
      expect(matchingResult.status).toBe(0);
      expect(matchingResult.stdout).toContain('manifest matches resource-owning source markers');

      writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, resourceOwning: [] }, null, 2)}\n`);
      const missingResult = runClassification(root, '--check');
      expect(missingResult.status).toBe(1);
      expect(missingResult.stderr).toContain('manifest drifted');

      writeFileSync(manifestPath, `${JSON.stringify({
        ...manifest,
        resourceOwning: [
          ...manifest.resourceOwning,
          { path: 'tests/stale.test.ts', reasons: ['network-listener'] },
        ],
      }, null, 2)}\n`);
      const staleResult = runClassification(root, '--check');
      expect(staleResult.status).toBe(1);
      expect(staleResult.stderr).toContain('manifest drifted');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function datedFixture(testSource: string, contractSource = 'export const contract = { expiresAt: Date.UTC(2030, 0, 9) };', restoreClock = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-dated-fixture-')));
  mkdirSync(join(root, 'tests/fixtures'), { recursive: true });
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(vitestPackage, join(root, 'node_modules/vitest'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(root, 'src/contract.ts'), contractSource);
  writeFileSync(join(root, 'tests/fixtures/check.ts'), `
    import { contract } from '@/contract';
    export function check() {
      const expiry = typeof contract.expiresAt === 'string' ? Date.parse(contract.expiresAt) : contract.expiresAt;
      if (expiry <= Date.now()) throw new Error('expired');
    }
  `);
  writeFileSync(join(root, 'tests/clock.test.ts'), `
    import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
    import { check } from './fixtures/check';
    ${testSource}
    ${restoreClock ? 'afterEach(() => vi.useRealTimers());' : ''}
  `);
  return root;
}

describe('dated fixture PR gate', () => {
  it('rejects a fixture validation masked by a leaking pin in an unrelated suite', () => {
    const root = datedFixture(`
      describe('unrelated suite', () => {
        beforeAll(() => vi.setSystemTime(Date.UTC(2029, 0, 1)));
        it('uses its own clock', () => expect(Date.now()).toBe(Date.UTC(2029, 0, 1)));
      });
      describe('fixture validation', () => {
        it('validates without its own pin', () => check());
      });
      afterAll(() => vi.useRealTimers());
    `, undefined, false);
    try {
      const result = runClassification(root, '--write');
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('[dated-fixtures] tests/clock.test.ts');
      expect(result.stderr).toContain('validates without its own pin');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('requires a fixture clock pin to be restored after the isolated test', () => {
    const root = datedFixture("it('valid', () => { vi.setSystemTime(0); check(); });", undefined, false);
    try {
      const result = runClassification(root, '--write');
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('restore');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not borrow a pin installed while an unrelated describe is collected', () => {
    const root = datedFixture(`
      describe('unrelated suite', () => {
        vi.setSystemTime(Date.UTC(2029, 0, 1));
        it('does not validate a fixture', () => expect(Date.now()).toBeGreaterThan(0));
      });
      describe('fixture validation', () => {
        it('validates without its own pin', () => check());
      });
      afterAll(() => vi.useRealTimers());
    `, undefined, false);
    try {
      const result = runClassification(root, '--write');
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('validates without its own pin');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts legitimate Date.now use and a pin owned and restored by its describe', () => {
    const root = datedFixture(`
      describe('elapsed time', () => {
        it('uses the advancing real clock', () => {
          const start = Date.now();
          expect(Date.now() - start).toBeGreaterThanOrEqual(0);
        });
      });
      describe('fixture validation', () => {
        beforeAll(() => vi.setSystemTime(Date.UTC(2029, 0, 1)));
        afterAll(() => vi.useRealTimers());
        it('uses its own pin', () => check());
      });
    `, undefined, false);
    try {
      const result = runClassification(root, '--write');
      expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['earlier hook', 'import evaluation'])('rejects wall-time validation during %s despite a later clock pin', (stage) => {
    const root = datedFixture(`
      ${stage === 'earlier hook' ? 'beforeEach(() => check());' : ''}
      beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.UTC(2029, 0, 1)); });
      afterEach(() => vi.useRealTimers());
      it('valid', () => check());
    `);
    try {
      if (stage === 'import evaluation') {
        const helper = join(root, 'tests/fixtures/check.ts');
        writeFileSync(helper, readFileSync(helper, 'utf8') + '\ncheck();\n');
      }
      const result = runClassification(root, '--write');
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('[dated-fixtures] tests/clock.test.ts');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('probes past the latest transitive expiry, including a later imported contract', () => {
    const root = datedFixture(`
      import './fixtures/later';
      beforeEach(() => { vi.useFakeTimers({ now: Date.UTC(2029, 0, 1) }); });
      it('valid', () => check());
    `);
    try {
      writeFileSync(join(root, 'tests/fixtures/later.ts'), `
        const contract = { expiresAt: Date.UTC(2040, 0, 1) };
        if (contract.expiresAt <= Date.now()) throw new Error('later contract expired');
      `);
      const result = runClassification(root, '--write');
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('[dated-fixtures] tests/clock.test.ts');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts a clock pinned before imported validation executes', () => {
    const root = datedFixture(`
      vi.hoisted(() => {
        vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.UTC(2029, 0, 1));
      });
      beforeEach(() => vi.setSystemTime(Date.UTC(2029, 0, 1)));
      it('valid', () => check());
    `);
    try {
      const helper = join(root, 'tests/fixtures/check.ts');
      writeFileSync(helper, readFileSync(helper, 'utf8') + '\ncheck();\n');
      const result = runClassification(root, '--write');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('passed with Date after');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('executes the flagged file with both Date.now and new Date past expiry', () => {
    const root = datedFixture(`
      it('observes the probe clock', () => {
        expect(Date.now()).toBeGreaterThan(Date.UTC(2030, 0, 9));
        expect(new Date().getTime()).toBeGreaterThan(Date.UTC(2030, 0, 9));
      });
    `);
    try {
      const result = runClassification(root, '--write');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('passed with Date after');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('isolates parameterized cases even when their test names are identical', () => {
    const root = datedFixture(`
      it.each([1, 2])('same title', () => { vi.setSystemTime(0); check(); });
    `);
    try {
      const result = runClassification(root, '--write');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('2 isolated tests passed');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['transitive fixture', "it('valid', () => check());"],
    ['timers without a pinned Date', "beforeEach(() => vi.useFakeTimers()); it('valid', () => check());"],
    ['timers excluding Date', "beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout'] }); vi.setSystemTime(0); }); it('valid', () => check());"],
    ['wall clock pin', "beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.now()); }); it('valid', () => check());"],
    ['only a sibling pins Date', "it('pinned', () => { vi.useFakeTimers(); vi.setSystemTime(0); check(); }); it('unbounded', () => check());"],
    ['a restored Date-only mock', "it('pinned', () => { vi.setSystemTime(0); check(); }); it('unbounded', () => check());"],
    ['a late pin', "it('valid', () => { check(); vi.useFakeTimers({ now: 0 }); });"],
    ['a conditional pin', "it('valid', () => { if (false) vi.useFakeTimers({ now: 0 }); check(); });"],
    ['a restored wall clock', "beforeEach(() => vi.useFakeTimers({ now: 0 })); it('valid', () => { vi.useRealTimers(); check(); });"],
  ])('rejects %s through the classification entry point', (_name, source) => {
    const root = datedFixture(source);
    try {
      for (const mode of ['--write', '--check'] as const) {
        const result = runClassification(root, mode);
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain('[dated-fixtures] tests/clock.test.ts');
        expect(result.stderr).toContain('pin Date');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    "beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.UTC(2029, 0, 1)); }); it('valid', () => check());",
    "it('valid', () => { vi.useFakeTimers({ now: 0 }); check(); });",
  ])('accepts an explicit fixture clock', (source) => {
    const root = datedFixture(source);
    try {
      expect(runClassification(root, '--write').status).toBe(0);
      expect(runClassification(root, '--check').status).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('accepts a relative expiry without confusing it with a dated contract', () => {
    const root = datedFixture("it('valid', () => check());", 'export const contract = { expiresAt: Date.now() + 60_000 };');
    try { expect(runClassification(root, '--write').status).toBe(0); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    "export const contract = { expiresAt: '2030-01-09T00:00:00Z' };",
    'export const contract = { expiresAt: 1_894_147_200_000 };',
    "export const contract = { expiresAt: new Date('2030-01-09T00:00:00Z').getTime() };",
    'const boundary = Date.UTC(2030, 0, 9); export const contract = { expiresAt: boundary };',
  ])('finds fixed expiry syntax through an imported fixture', (contract) => {
    const root = datedFixture("it('valid', () => check());", contract);
    try {
      const result = runClassification(root, '--write');
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('fixed expiry in src/contract.ts');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    "new URL('./fixtures/token.json', import.meta.url)",
    "join(process.cwd(), 'tests', 'fixtures', 'token.json')",
  ])('follows a JSON fixture loaded from disk: %s', (path) => {
    const root = datedFixture(`
      import { readFileSync } from 'node:fs'; import { join } from 'node:path';
      it('valid', () => {
        const fixture = JSON.parse(readFileSync(${path}, 'utf8'));
        expect(Date.parse(fixture.expiresAt)).toBeGreaterThan(Date.now());
      });
    `, 'export const contract = { expiresAt: Date.now() + 60_000 };');
    try {
      writeFileSync(join(root, 'tests/fixtures/token.json'), '{"expiresAt":"2030-01-09T00:00:00Z"}');
      const result = runClassification(root, '--write');
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('fixed expiry in tests/fixtures/token.json');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('warns at seven days without failing or changing the manifest', () => {
    const root = datedFixture("beforeEach(() => { vi.useFakeTimers({ now: 0 }); }); it('valid', () => check());");
    try {
      writeFileSync(join(root, 'tests/fixtures/token.json'), '{"expires_at":"2030-01-09T00:00:00Z"}');
      const preload = join(root, 'clock.mjs');
      const runAt = (day: number, mode: '--write' | '--check') => {
        writeFileSync(preload, `Date.now = () => Date.UTC(2030, 0, ${day});`);
        return runClassification(root, mode, preload);
      };
      const early = runAt(1, '--write');
      expect(early.status).toBe(0);
      expect(early.stderr).not.toContain('[dated-fixtures] WARNING');
      const manifest = readFileSync(join(root, 'tests/test-classification.json'), 'utf8');
      for (const day of [2, 8]) {
        const warning = runAt(day, '--check');
        expect(warning.status, warning.stderr).toBe(0);
        expect(warning.stderr).toContain('[dated-fixtures] WARNING src/contract.ts:');
        expect(warning.stderr).toContain('[dated-fixtures] WARNING tests/fixtures/token.json:');
        expect(warning.stderr).toContain('2030-01-09');
        expect(readFileSync(join(root, 'tests/test-classification.json'), 'utf8')).toBe(manifest);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
