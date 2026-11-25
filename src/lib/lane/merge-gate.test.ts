import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runMergeGate } from './merge-gate';
import type { Lane } from './types';

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'o8-merge-gate-repo-'));
  tempDirs.push(repoPath);
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'test@o8.dev']);
  git(repoPath, ['config', 'user.name', 'o8 test']);
  writeFileSync(join(repoPath, 'safe.ts'), [
    'export function first() { return 1; }',
    'export function second() { return 2; }',
    'export function third() { return 3; }',
    'export function fourth() { return 4; }',
    'export function fifth() { return 5; }',
    'export function sixth() { return 6; }',
    'export function seventh() { return 7; }',
    'export function eighth() { return 8; }',
    'export function ninth() { return 9; }',
    'export function tenth() { return 10; }',
    '',
  ].join('\n'));
  git(repoPath, ['add', 'safe.ts']);
  git(repoPath, ['commit', '-q', '-m', 'base']);
  return repoPath;
}

function initExtractionRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'o8-merge-gate-extraction-'));
  tempDirs.push(repoPath);
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'test@o8.dev']);
  git(repoPath, ['config', 'user.name', 'o8 test']);
  const routeLines = [
    'export function keepRouteHandler() { return "kept"; }',
    ...Array.from({ length: 60 }, (_, index) => `export function retained${index}() { return ${index}; }`),
    ...Array.from({ length: 60 }, (_, index) => `export function extracted${index}() { return ${index}; }`),
    '',
  ];
  writeFileSync(join(repoPath, 'route.ts'), routeLines.join('\n'));
  git(repoPath, ['add', 'route.ts']);
  git(repoPath, ['commit', '-q', '-m', 'base']);
  return repoPath;
}

function commitAll(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function initOriginFixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-merge-gate-origin-'));
  tempDirs.push(root);
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const packet = join(root, 'packet');
  const upstream = join(root, 'upstream');

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, seed], { stdio: 'pipe' });
  git(seed, ['checkout', '-b', 'main']);
  git(seed, ['config', 'user.email', 'test@o8.dev']);
  git(seed, ['config', 'user.name', 'o8 test']);
  writeFileSync(join(seed, 'safe.ts'), 'export const base = 1;\n');
  commitAll(seed, 'base');
  git(seed, ['push', '-u', 'origin', 'main']);

  execFileSync('git', ['clone', origin, packet], { stdio: 'pipe' });
  git(packet, ['checkout', 'main']);
  git(packet, ['config', 'user.email', 'test@o8.dev']);
  git(packet, ['config', 'user.name', 'o8 test']);

  execFileSync('git', ['clone', origin, upstream], { stdio: 'pipe' });
  git(upstream, ['checkout', 'main']);
  git(upstream, ['config', 'user.email', 'test@o8.dev']);
  git(upstream, ['config', 'user.name', 'o8 test']);

  return { packet, upstream };
}

function laneFixture(repoPath: string): Lane {
  return {
    id: 'lane-merge-gate-test',
    projectId: null,
    label: 'merge gate test',
    repoPath,
    worktreePath: repoPath,
    branch: 'feature/merge-gate-test',
    baseBranch: 'main',
    runtime: 'codex',
    sessionKey: 'codex:merge-gate-test',
    packetId: 'pkt-merge-gate-test',
    prNumber: null,
    status: 'reviewing',
    ownership: 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastEventAt: null,
    lastEventLabel: null,
  };
}

describe('merge gate governance invariants', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('downgrades approved budget overruns while keeping security blocks hard-blocking', async () => {
    const repoPath = initRepo();
    git(repoPath, ['checkout', '-q', '-b', 'feature/merge-gate-test']);
    writeFileSync(join(repoPath, 'safe.ts'), [
      'export function first() { return 1; }',
      'export function second() { return 2; }',
      'export function third() { return 3; }',
      'export function fourth() { return 4; }',
      'export function fifth() { return 5; }',
      'export function sixth() { return 6; }',
      'export function seventh() { return 7; }',
      'export function eighth() { return 8; }',
      'export function ninth() { return 9; }',
      'export function tenth() { return 10; }',
      'export const extra1 = 1;',
      'export const extra2 = 2;',
      'export const extra3 = 3;',
      'export const extra4 = 4;',
      'export const extra5 = 5;',
      'export const extra6 = 6;',
      'export const extra7 = 7;',
      'export const injected = eval("2 + 2");',
      '',
    ].join('\n'));
    git(repoPath, ['add', 'safe.ts']);
    git(repoPath, ['commit', '-q', '-m', 'feat: risky diff']);

    const result = await runMergeGate(laneFixture(repoPath), undefined, true);

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'budget',
        severity: 'warn',
        label: 'Add budget exceeded',
        file: 'safe.ts',
      }),
      expect.objectContaining({
        category: 'security',
        severity: 'block',
        label: 'eval() — code injection risk',
        file: 'safe.ts',
      }),
    ]));
  }, 20_000);

  it('passes an oversized extract-to-new-module relocation through the real merge gate', async () => {
    const repoPath = initExtractionRepo();
    git(repoPath, ['checkout', '-q', '-b', 'feature/merge-gate-test']);
    const extractedLines = Array.from(
      { length: 60 },
      (_, index) => `export function extracted${index}() { return ${index}; }`,
    );
    const retainedLines = Array.from(
      { length: 60 },
      (_, index) => `export function retained${index}() { return ${index}; }`,
    );
    writeFileSync(join(repoPath, 'route.ts'), [
      'export function keepRouteHandler() { return "kept"; }',
      ...retainedLines,
      '',
    ].join('\n'));
    writeFileSync(join(repoPath, 'extracted.ts'), `${extractedLines.join('\n')}\n`);
    commitAll(repoPath, 'refactor: extract route helpers');
    expect(git(repoPath, ['diff', '--numstat', 'main...HEAD'])).toContain('0\t60\troute.ts');

    const result = await runMergeGate(laneFixture(repoPath));

    expect(result.passed).toBe(true);
    expect(result.violations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'budget' }),
    ]));
  }, 20_000);

  it('still blocks a genuine oversized deletion with no relocated module', async () => {
    const repoPath = initExtractionRepo();
    git(repoPath, ['checkout', '-q', '-b', 'feature/merge-gate-test']);
    const retainedLines = Array.from(
      { length: 60 },
      (_, index) => `export function retained${index}() { return ${index}; }`,
    );
    writeFileSync(join(repoPath, 'route.ts'), [
      'export function keepRouteHandler() { return "kept"; }',
      ...retainedLines,
      '',
    ].join('\n'));
    commitAll(repoPath, 'refactor: remove route helpers');

    const result = await runMergeGate(laneFixture(repoPath));

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'budget',
        severity: 'block',
        label: 'Delete budget exceeded',
        file: 'route.ts',
      }),
    ]));
  }, 20_000);

  it('adds an integrity block when self-review claims passed:true despite blocking violations', async () => {
    const repoPath = initRepo();
    git(repoPath, ['checkout', '-q', '-b', 'feature/merge-gate-test']);
    writeFileSync(join(repoPath, 'safe.ts'), [
      'export function first() { return 1; }',
      'export const injected = eval("2 + 2");',
      '',
    ].join('\n'));
    git(repoPath, ['add', 'safe.ts']);
    git(repoPath, ['commit', '-q', '-m', 'feat: unsafe self review']);

    const result = await runMergeGate(laneFixture(repoPath), {
      passed: true,
      confidence: 'high',
      summary: 'looks good',
      issuesFound: [],
    }, false);

    expect(result.passed).toBe(false);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'security',
        severity: 'block',
      }),
      expect.objectContaining({
        category: 'integrity',
        severity: 'block',
        label: 'Self-review integrity failure',
      }),
    ]));
  }, 20_000);

  it('diffs against refreshed origin merge-base instead of frozen local main', async () => {
    const { packet, upstream } = initOriginFixture();
    writeFileSync(join(upstream, 'upstream-risk.ts'), 'export const kill = () => process.exit(1);\n');
    const upstreamSha = commitAll(upstream, 'feat: upstream risk');
    git(upstream, ['push', 'origin', 'main']);

    git(packet, ['fetch', 'origin', 'main', '--quiet']);
    git(packet, ['checkout', '-q', '-b', 'feature/merge-gate-test', 'origin/main']);
    writeFileSync(join(packet, 'packet.ts'), 'export const packet = 1;\n');
    commitAll(packet, 'feat: packet change');
    git(packet, ['update-ref', 'refs/heads/main', 'HEAD~2']);

    const result = await runMergeGate(laneFixture(packet), undefined, false);

    expect(result.passed).toBe(true);
    expect(result.diffBase).toEqual(expect.objectContaining({
      fetchedRemoteBase: true,
      usedFallback: false,
      comparisonRef: 'origin/main',
      mergeBase: upstreamSha,
    }));
    expect(result.violations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'security',
        file: 'upstream-risk.ts',
      }),
    ]));
  }, 20_000);

  it('still blocks security patterns added by the packet itself', async () => {
    const { packet, upstream } = initOriginFixture();
    writeFileSync(join(upstream, 'upstream-safe.ts'), 'export const upstream = 1;\n');
    commitAll(upstream, 'feat: upstream safe');
    git(upstream, ['push', 'origin', 'main']);

    git(packet, ['fetch', 'origin', 'main', '--quiet']);
    git(packet, ['checkout', '-q', '-b', 'feature/merge-gate-test', 'origin/main']);
    writeFileSync(join(packet, 'packet-risk.ts'), 'export const kill = () => process.exit(1);\n');
    commitAll(packet, 'feat: packet risk');
    git(packet, ['update-ref', 'refs/heads/main', 'HEAD~2']);

    const result = await runMergeGate(laneFixture(packet), undefined, false);

    expect(result.passed).toBe(false);
    expect(result.diffBase).toEqual(expect.objectContaining({
      fetchedRemoteBase: true,
      usedFallback: false,
      comparisonRef: 'origin/main',
    }));
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'security',
        severity: 'block',
        label: 'process.exit() — agent must not kill the process',
        file: 'packet-risk.ts',
      }),
    ]));
  }, 20_000);

  it('allows the exact reviewed CLI flush wrapper through the real Git gate', async () => {
    const repoPath = initRepo();
    git(repoPath, ['checkout', '-q', '-b', 'feature/merge-gate-test']);
    mkdirSync(join(repoPath, 'cli/src'), { recursive: true });
    const wrapper = readFileSync(join(process.cwd(), 'cli/src/exit.ts'), 'utf8');
    writeFileSync(join(repoPath, 'cli/src/exit.ts'), wrapper);
    commitAll(repoPath, 'fix: flush CLI output before termination');

    const result = await runMergeGate(laneFixture(repoPath));
    expect(result.passed).toBe(true);
    expect(result.violations.filter((violation) => violation.category === 'security')).toEqual([]);
  }, 20_000);

  it.each(['modified', 'duplicated', 'other-file', 'dirty-worktree'] as const)(
    'keeps unreviewed termination blocked: %s',
    async (kind) => {
      const repoPath = initRepo();
      git(repoPath, ['checkout', '-q', '-b', 'feature/merge-gate-test']);
      mkdirSync(join(repoPath, 'cli/src'), { recursive: true });
      const wrapper = readFileSync(join(process.cwd(), 'cli/src/exit.ts'), 'utf8');
      const modified = wrapper.replace('FLUSH_TIMEOUT_MS = 10_000', 'FLUSH_TIMEOUT_MS = 0');
      const file = kind === 'other-file' ? 'cli/src/other-exit.ts' : 'cli/src/exit.ts';
      // Keep an approved copy present too, so an allowed file cannot exempt
      // another file's termination calls.
      writeFileSync(join(repoPath, 'cli/src/exit.ts'), wrapper);
      writeFileSync(join(repoPath, file), kind === 'duplicated'
        ? wrapper + wrapper : kind === 'other-file' ? wrapper : modified);
      commitAll(repoPath, 'test: unreviewed termination candidate');
      if (kind === 'dirty-worktree') {
        // Only the candidate commit can qualify, not a safe unstaged copy.
        writeFileSync(join(repoPath, file), wrapper);
      }

      const result = await runMergeGate(laneFixture(repoPath));
      expect(result.passed).toBe(false);
      expect(result.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ category: 'security', severity: 'block', file }),
      ]));
    },
    20_000,
  );
});
