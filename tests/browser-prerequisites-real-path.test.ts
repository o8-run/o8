import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('selects browser prerequisites for a new test from its own declaration before dependencies are installed', () => {
  const source = process.cwd();
  const root = mkdtempSync(path.join(tmpdir(), 'o8-browser-selection-'));
  const run = (command: string, args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) => {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...extra } });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    return result;
  };
  try {
    for (const file of ['scripts/ci/resource-owning-changed.mjs', 'scripts/lib/test-classification.mjs']) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      copyFileSync(path.join(source, file), path.join(root, file));
    }
    mkdirSync(path.join(root, 'tests'));
    writeFileSync(path.join(root, 'tests/new-layout.test.ts'), "import { chromium } from 'playwright-core';\n");
    writeFileSync(path.join(root, 'tests/ordinary-real-path.test.ts'), 'expect(true).toBe(true);\n');
    run(process.execPath, [path.join(source, 'scripts/classify-tests.mjs'), '--write']);
    run('git', ['init', '-q', '-b', 'main']);
    run('git', ['config', 'user.name', 'CI Fixture']);
    run('git', ['config', 'user.email', 'fixture@example.invalid']);
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'fixture base']);
    run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const output = path.join(root, 'selection.txt');
    const select = () => {
      writeFileSync(output, '');
      run(process.execPath, ['scripts/ci/resource-owning-changed.mjs', 'origin/main', '--worktree'], { GITHUB_OUTPUT: output });
      return readFileSync(output, 'utf8');
    };
    expect(select()).toContain('browser=false\n');
    writeFileSync(path.join(root, 'tests/ordinary-real-path.test.ts'), 'expect(false).toBe(false);\n');
    expect(select()).toContain('browser=false\n');
    writeFileSync(path.join(root, 'tests/new-layout.test.ts'), "import { chromium } from 'playwright-core';\n// touched\n");
    const selected = select();
    expect(selected).toContain('count=2\n');
    expect(selected).toContain('browser=true\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
