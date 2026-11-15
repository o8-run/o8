import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const { runLaneRebaseTypecheck } = await import('@/lib/lane/rebase-typecheck');

const created: string[] = [];

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/**
 * A worktree that passes `detectTypecheckSkip` (it has a tsconfig and its
 * dependencies), and a repository install whose compiler behaves however the
 * test needs. The gate runs that compiler with node.
 */
function worktreeWithCompiler(script: string): { cwd: string; installRoot: string } {
  const cwd = mkdtempSync(join(os.tmpdir(), 'o8-merge-gate-typecheck-'));
  const installRoot = mkdtempSync(join(os.tmpdir(), 'o8-merge-gate-install-'));
  created.push(cwd, installRoot);
  writeFileSync(
    join(cwd, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { noEmit: true } }),
    'utf8',
  );
  mkdirSync(join(cwd, 'node_modules', 'typescript'), { recursive: true });
  writeFileSync(join(cwd, 'node_modules', 'typescript', 'package.json'), '{}', 'utf8');
  const bin = join(installRoot, 'node_modules', 'typescript', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'tsc'), script, 'utf8');
  return { cwd, installRoot };
}

const branch = 'inline/96241-docs-only';

describe('merge gate typecheck, environment failure', () => {
  it('does not call a silent non-zero exit a type error', async () => {
    // Nothing on either stream: a timeout kill, or a worktree whose contents
    // were not ready. The merge should continue with the check marked skipped.
    const fixture = worktreeWithCompiler('process.exit(1);\n');

    const result = await runLaneRebaseTypecheck({ ...fixture, actualBranch: branch, logPrefix: 'lane-merge' });

    expect(result.ok).toBe(true);
    expect(result.ok && result.skipped).toMatch(/did not run to completion/);
  });

  it('still fails the merge when the compiler reports a real diagnostic', async () => {
    const fixture = worktreeWithCompiler(
      "console.log(\"src/a.ts(1,1): error TS2304: Cannot find name 'nope'.\");\nprocess.exit(2);\n",
    );

    const result = await runLaneRebaseTypecheck({ ...fixture, actualBranch: branch, logPrefix: 'lane-merge' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.output).toContain('error TS2304');
  });

  it('still fails the merge when the compiler crashes without emitting a diagnostic', async () => {
    // A compiler that dies on the diff's own types writes a stack trace and no
    // `error TS` line. That has to keep blocking the merge and keep carrying
    // its evidence, or a real failure merges with less information than before.
    const fixture = worktreeWithCompiler(
      'console.error("RangeError: Maximum call stack size exceeded");\nprocess.exit(7);\n',
    );

    const result = await runLaneRebaseTypecheck({ ...fixture, actualBranch: branch, logPrefix: 'lane-merge' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.output).toContain('Maximum call stack size exceeded');
  });
});
