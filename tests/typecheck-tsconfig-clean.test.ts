import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('typecheck type generation', () => {
  it('runs the real typegen path without changing tracked tsconfig.json', () => {
    const repoRoot = process.cwd();

    const tsconfigPath = join(repoRoot, 'tsconfig.json');
    const before = readFileSync(tsconfigPath, 'utf8');
    const beforeGitDiff = execFileSync('git', ['diff', '--', 'tsconfig.json'], { cwd: repoRoot, encoding: 'utf8' });

    const result = spawnSync('npm', ['run', 'typecheck', '--', '--typegen-only'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(readFileSync(tsconfigPath, 'utf8')).toBe(before);
    expect(execFileSync('git', ['diff', '--', 'tsconfig.json'], { cwd: repoRoot, encoding: 'utf8' }))
      .toBe(beforeGitDiff);
    expect(existsSync(join(repoRoot, 'next-env.d.ts'))).toBe(true);
    expect(execFileSync('git', ['check-ignore', 'next-env.d.ts'], { cwd: repoRoot, encoding: 'utf8' }).trim())
      .toBe('next-env.d.ts');
    expect(execFileSync('git', ['ls-files', '--', 'next-env.d.ts'], { cwd: repoRoot, encoding: 'utf8' }).trim())
      .toBe('');
  }, 30_000);
});

describe('typecheck checker selection', () => {
  it.each([
    ['tsrs', 0], ['tsrs', 2], ['tsc', 0], ['tsc', 2],
  ] as const)('runs %s for app and CLI and propagates CLI exit %i', (checker, cliStatus) => {
    const root = mkdtempSync(join(tmpdir(), 'o8-typecheck-runner-'));
    try {
      copyFileSync('scripts/typecheck.mjs', join(root, 'typecheck.mjs'));
      copyFileSync('scripts/typecheck-checker.mjs', join(root, 'typecheck-checker.mjs'));
      copyFileSync('scripts/typecheck-fast.mjs', join(root, 'typecheck-fast.mjs'));
      copyFileSync('scripts/typecheck-process.mjs', join(root, 'typecheck-process.mjs'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({
        scripts: { 'typecheck:fast': JSON.parse(readFileSync('package.json', 'utf8')).scripts['typecheck:fast']
          .replace('scripts/', '') },
      }));
      writeFileSync(join(root, 'tsconfig.json'), '{}');
      for (const [name, binary, source] of [
        ['next', 'next', `require('node:fs').writeFileSync('tsconfig.json', '{"changed":true}');`],
        [checker === 'tsrs' ? 'tsrs' : 'typescript', checker, `
          const fs = require('node:fs');
          fs.appendFileSync('calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n');
          if (process.argv.includes('--project')) process.exit(${cliStatus});
        `],
      ]) {
        const packageRoot = join(root, 'node_modules', name);
        const binDir = name === 'next' ? 'dist/bin' : 'bin';
        mkdirSync(join(packageRoot, binDir), { recursive: true });
        writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
          name, version: '1.0.0',
          ...(name === 'tsrs' ? { exports: { './package.json': './package.json' } } : {}),
        }));
        writeFileSync(join(packageRoot, binDir, binary), source);
      }
      if (checker === 'tsrs') {
        // Both libc fixtures keep the test portable across GNU and musl hosts.
        for (const suffix of process.platform === 'linux' ? ['-gnu', '-musl'] : ['']) {
          const nativeRoot = join(root, 'node_modules', '@tsrs', `${process.platform}-${process.arch}${suffix}`);
          mkdirSync(nativeRoot, { recursive: true });
          writeFileSync(join(nativeRoot, 'package.json'), '{}');
        }
      }
      const result = spawnSync(process.execPath, ['typecheck.mjs'], { cwd: root, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(cliStatus);
      expect(readFileSync(join(root, 'tsconfig.json'), 'utf8')).toBe('{}');
      expect(readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)))
        .toEqual([['--noEmit'], ['--noEmit', '--project', 'cli/tsconfig.chat.json']]);
      const notice = `tsrs has no ${process.platform}-${process.arch} build; using tsc 5.8.2\n`;
      expect(result.stderr.split(notice)).toHaveLength(checker === 'tsc' ? 2 : 1);

      rmSync(join(root, 'calls.jsonl'));
      const fast = spawnSync('npm', ['run', 'typecheck:fast', '--', '--project', 'cli/tsconfig.chat.json'], {
        cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
      });
      expect(fast.status, fast.stderr).toBe(cliStatus);
      expect(readFileSync(join(root, 'calls.jsonl'), 'utf8').trim()).toBe(
        JSON.stringify(['--noEmit', '--project', 'cli/tsconfig.chat.json']),
      );
      expect(fast.stderr).toBe(checker === 'tsc' ? notice : '');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('typecheck heap boundary', () => {
  it.each(['typecheck:fast', 'typecheck'])('%s sizes every child and contains heap failures', (command) => {
    const root = mkdtempSync(join(tmpdir(), 'o8-typecheck-heap-'));
    try {
      mkdirSync(join(root, 'scripts'));
      for (const script of ['typecheck.mjs', 'typecheck-fast.mjs', 'typecheck-checker.mjs', 'typecheck-process.mjs']) {
        if (existsSync(join('scripts', script))) copyFileSync(join('scripts', script), join(root, 'scripts', script));
      }
      const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
      writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {
        [command]: scripts[command], 'verify:routes': 'node -e "process.exit(0)"',
      } }));
      writeFileSync(join(root, 'tsconfig.json'), '{}');
      for (const [name, binary, dir] of [['next', 'next', 'dist/bin'], ['typescript', 'tsc', 'bin']]) {
        const packageRoot = join(root, 'node_modules', name);
        mkdirSync(join(packageRoot, dir), { recursive: true });
        writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
        writeFileSync(join(packageRoot, dir, binary), `
          const fs = require('node:fs');
          fs.appendFileSync('heap.jsonl', JSON.stringify({
            args: process.argv.slice(2), heap: require('node:v8').getHeapStatistics().heap_size_limit / 1024 / 1024,
          }) + '\\n');
          if (process.env.FAIL_STAGE === '${name}' &&
              (!process.env.FAIL_CLI || process.argv.includes('--project'))) {
            process.stderr.write('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n');
            process.stderr.write(' 1: native V8 stack fixture\\n');
            process.exit(134);
          }
          if (process.env.TYPE_ERROR && '${name}' === 'typescript') {
            console.error('fixture.ts(1,1): error TS2322: wrong type'); process.exit(2);
          }
        `);
      }
      const run = (extra = {}) => spawnSync('npm', ['run', command], {
        cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=256', ...extra },
      });
      const success = run();
      expect(success.status, success.stderr).toBe(0);
      expect(success.stdout).toContain('[typecheck] heap limit: 8192 MiB');
      const receipts = readFileSync(join(root, 'heap.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(receipts).toHaveLength(command === 'typecheck' ? 3 : 1);
      for (const receipt of receipts) expect(receipt.heap).toBeGreaterThanOrEqual(8192);
      for (const stage of command === 'typecheck' ? ['next', 'typescript', 'cli'] : ['typescript']) {
        rmSync(join(root, 'heap.jsonl'));
        const failure = run({ FAIL_STAGE: stage === 'cli' ? 'typescript' : stage, FAIL_CLI: stage === 'cli' ? '1' : '' });
        expect(failure.status).toBe(1);
        const lines = failure.stderr.trim().split('\n').filter(line => !line.startsWith('tsrs has no '));
        expect(lines).toEqual(['[typecheck] heap exhausted at 8192 MiB; type check failed.']);
        const count = readFileSync(join(root, 'heap.jsonl'), 'utf8').trim().split('\n').length;
        expect(count).toBe(stage === 'next' ? 1 : stage === 'cli' ? 3 : command === 'typecheck' ? 2 : 1);
      }
      const diagnostic = run({ TYPE_ERROR: '1' });
      expect(diagnostic.status).toBe(2);
      expect(diagnostic.stderr).toContain('error TS2322: wrong type');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
