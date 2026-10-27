import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// @ts-expect-error The CI script intentionally has no declaration file.
import * as glibc from '../scripts/ci/check-linux-glibc.mjs';

const { checkLinuxGlibc, compareGlibcVersions, highestGlibcRequirement, DEFAULT_MAX_GLIBC } = glibc;
const root = join(__dirname, '..');

type Step = { name?: string; if?: string; run?: string };
const workflow = parse(readFileSync(join(root, '.github/workflows/port-build.yml'), 'utf8')) as {
  jobs: { build: { strategy: { matrix: { platform: string } }; steps: Step[] } };
};

describe('Linux package glibc baseline', () => {
  it('builds Linux packages on ubuntu-22.04 (glibc 2.35), never ubuntu-latest', () => {
    const matrix = workflow.jobs.build.strategy.matrix.platform;
    expect(matrix).toContain('"ubuntu-22.04"');
    expect(matrix).not.toContain('ubuntu-latest');
  });

  it('fails the build when a shipped binary needs glibc newer than 2.35', () => {
    const gate = workflow.jobs.build.steps.find((step) => step.name === 'Verify Linux glibc baseline');
    expect(gate?.if).toBe("runner.os == 'Linux'");
    expect(gate?.run).toContain('node scripts/ci/check-linux-glibc.mjs --max 2.35');
    expect(gate?.run).toContain("-name '*.deb'");
    expect(gate?.run).toContain("-name '*.AppImage'");
    expect(DEFAULT_MAX_GLIBC).toBe('2.35');
    const steps = workflow.jobs.build.steps;
    const upload = steps.findIndex((step) => (step as { uses?: string }).uses?.startsWith('actions/upload-artifact'));
    expect(steps.indexOf(gate!)).toBeLessThan(upload);
  });

  it('reads the highest GLIBC version reference from objdump -p output', () => {
    const output = `
Version References:
  required from libc.so.6:
    0x09691a75 0x00 05 GLIBC_2.2.5
    0x06969197 0x00 09 GLIBC_2.17
    0x069691b4 0x00 04 GLIBC_2.34
    0x069691b9 0x00 07 GLIBC_2.39
  required from libgcc_s.so.1:
    0x0b792650 0x00 03 GCC_3.0
`;
    expect(highestGlibcRequirement(output)).toBe('2.39');
    expect(highestGlibcRequirement('no version references')).toBeNull();
    expect(compareGlibcVersions('2.4', '2.35')).toBeLessThan(0);
    expect(compareGlibcVersions('2.35', '2.35')).toBe(0);
    expect(compareGlibcVersions('2.38', '2.35')).toBeGreaterThan(0);
  });

  const objdump = spawnSync('objdump', ['--version']).status === 0;
  it.runIf(process.platform === 'linux' && objdump)('scans real ELF files against the ceiling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'o8-glibc-test-'));
    try {
      copyFileSync(process.execPath, join(dir, 'node'));
      const quiet = () => {};
      expect(checkLinuxGlibc([dir], { max: '99.0', log: quiet })).toEqual({ scanned: 1, failures: [] });
      const failed = checkLinuxGlibc([dir], { max: '2.0', log: quiet });
      expect(failed.failures).toHaveLength(1);
      expect(failed.failures[0]).toMatch(/:node needs GLIBC_2\.\d+$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
