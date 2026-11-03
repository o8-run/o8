import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('../classify-tests.mjs', import.meta.url));

test('classification checks Git sources without walking and falls back outside Git', () => {
  const directory = mkdtempSync(join(tmpdir(), 'o8-classification-git-'));
  const run = (...args) => spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8' });
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  try {
    mkdirSync(join(directory, 'tests'));
    writeFileSync(join(directory, 'tests/resource.test.ts'), 'createServer();\n');
    // The same sources must produce the same manifest with or without Git.
    assert.equal(run(script, '--write').status, 0);
    git('init', '-q');
    git('add', 'tests/resource.test.ts');
    const preload = join(directory, 'no-walk.mjs');
    writeFileSync(preload, `import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      fs.readdirSync = () => { throw new Error('unexpected directory walk'); };
      syncBuiltinESMExports();\n`);
    const check = () => run('--import', preload, script, '--check-manifest');
    const matching = check();
    assert.equal(matching.status, 0, matching.stderr);
    writeFileSync(join(directory, '.gitignore'), 'tests/new.test.ts\n');
    writeFileSync(join(directory, 'tests/new.test.ts'), 'createServer();\n');
    assert.match(check().stderr, /manifest drifted/);
    rmSync(join(directory, 'tests/new.test.ts'));
    writeFileSync(join(directory, 'tests/resource.test.ts'), 'expect(true).toBe(true);\n');
    assert.match(check().stderr, /manifest drifted/);
    rmSync(join(directory, 'tests/resource.test.ts'));
    assert.match(check().stderr, /manifest drifted/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
