import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyAgainstBaseline, loadRedBaseline } from '../scripts/lib/red-baseline.mjs';

const baseline = new Set(['tests/known-red-real-path.test.ts', 'tests/fixed-real-path.test.ts']);

describe('integration gate red baseline', () => {
  it('reports a red baseline file as baseline red, not new red', () => {
    const outcome = classifyAgainstBaseline([{ file: 'tests/known-red-real-path.test.ts', failed: true }], baseline);
    expect(outcome.baselineRed).toEqual(['tests/known-red-real-path.test.ts']);
    expect(outcome.newRed).toEqual([]);
  });

  it('reports a red file outside the baseline as new red', () => {
    const outcome = classifyAgainstBaseline([
      { file: 'tests/known-red-real-path.test.ts', failed: true },
      { file: 'tests/new-break-real-path.test.ts', failed: true },
    ], baseline);
    expect(outcome.newRed).toEqual(['tests/new-break-real-path.test.ts']);
  });

  it('reports a baseline file that now passes', () => {
    const outcome = classifyAgainstBaseline([
      { file: 'tests/fixed-real-path.test.ts', failed: false },
      { file: 'tests/always-green-real-path.test.ts', failed: false },
    ], baseline);
    expect(outcome.nowGreen).toEqual(['tests/fixed-real-path.test.ts']);
    expect(outcome.green).toHaveLength(2);
    expect(outcome.ran).toBe(2);
  });

  it('stays strict when the baseline file is missing', () => {
    const missing = loadRedBaseline(join(__dirname, 'no-such-baseline.json'));
    expect(missing).toBeNull();
    const outcome = classifyAgainstBaseline([{ file: 'tests/known-red-real-path.test.ts', failed: true }], missing);
    expect(outcome.newRed).toEqual(['tests/known-red-real-path.test.ts']);
    expect(loadRedBaseline(undefined)).toBeNull();
  });

  it('reads the list as committed at the base, so a change cannot exempt itself', () => {
    const repo = mkdtempSync(join(tmpdir(), 'o8-red-baseline-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
      const list = (paths: string[]) => JSON.stringify({ files: paths.map((path) => ({ path })) });
      git('init', '-q');
      mkdirSync(join(repo, 'tests'));
      writeFileSync(join(repo, 'tests/quarantine.json'), list(['tests/known-red-real-path.test.ts']));
      git('add', '.');
      git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'base');
      // The change under test adds its own broken file to the list.
      writeFileSync(join(repo, 'tests/quarantine.json'), list(['tests/known-red-real-path.test.ts', 'tests/new-break-real-path.test.ts']));
      const committed = loadRedBaseline('tests/quarantine.json', 'HEAD', repo);
      expect([...(committed ?? [])]).toEqual(['tests/known-red-real-path.test.ts']);
      const outcome = classifyAgainstBaseline([
        { file: 'tests/known-red-real-path.test.ts', failed: true },
        { file: 'tests/new-break-real-path.test.ts', failed: true },
      ], committed);
      expect(outcome.baselineRed).toEqual(['tests/known-red-real-path.test.ts']);
      expect(outcome.newRed).toEqual(['tests/new-break-real-path.test.ts']);
      expect(loadRedBaseline('tests/quarantine.json', 'no-such-ref', repo)).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('loads the recorded Linux baseline, which lists only resource-owning files', async () => {
    const recorded = loadRedBaseline(join(__dirname, 'integration-linux-baseline.json'));
    expect(recorded?.size).toBe(0);
    expect(recorded?.has('tests/execution-carrier-real-path.test.ts')).toBe(false);
    const { default: classification } = await import('./test-classification.json');
    const owning = new Set(classification.resourceOwning.map((entry: { path: string }) => entry.path));
    expect([...(recorded ?? [])].filter((path) => !owning.has(path))).toEqual([]);
  });
});
