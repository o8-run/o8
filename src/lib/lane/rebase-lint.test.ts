import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getDataDir } from '@/lib/data-dir-migration';
import { piWriteHelperPath } from '@/lib/pi/sdk/scripts';

import { runLaneRebaseLint } from './rebase-lint';

const tempDirs: string[] = [];

// Linux confines ESLint only through the built supervisor. A checkout that has
// not built it still lints, unconfined, and the receipt says so.
const linuxSupervisorMissing = process.platform === 'linux' && (() => {
  try { piWriteHelperPath(); return false; } catch { return true; }
})();
const CLEAN_LINT = linuxSupervisorMissing ? { ok: true, unconfined: true } : { ok: true };

function makeDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `o8-rebase-lint-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): void {
  git(cwd, ['add', '-A']);
  git(cwd, [
    '-c', 'user.name=o8-test',
    '-c', 'user.email=o8@example.test',
    'commit',
    '-m',
    message,
  ]);
}

function writePackage(cwd: string, lintScript = 'eslint .'): void {
  writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
    private: true,
    scripts: lintScript ? { lint: lintScript } : {},
    devDependencies: { eslint: '^9.39.5' },
  }));
}

function initLintRepo(label: string): string {
  const repo = makeDir(label);
  git(repo, ['init', '-b', 'main']);
  writePackage(repo);
  // No trailing slash: the ignore must also match the node_modules link below.
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
  writeFileSync(path.join(repo, 'eslint.config.mjs'), [
    'export default [{',
    "  files: ['**/*.js'],",
    "  rules: { 'no-console': 'warn', 'no-unused-vars': 'warn' },",
    '}];',
    '',
  ].join('\n'));
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(repo, 'node_modules'), 'junction');
  return repo;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A packet that changes `src/packet.js` to log to the console, on a base whose
// config warns on console use.
function packetWithConsoleLog(repo: string, branch: string): void {
  writeFileSync(path.join(repo, 'src', 'packet.js'), 'export const value = 1;\n');
  commitAll(repo, 'base');
  git(repo, ['checkout', '-b', branch]);
  writeFileSync(path.join(repo, 'src', 'packet.js'), 'export const value = 1;\nconsole.log(value);\n');
}

// An ESLint plugin module whose one rule reports the contents of `secretPath`.
function leakingPlugin(secretPath: string): string {
  return [
    "import { readFileSync } from 'node:fs';",
    `const secret = readFileSync(${JSON.stringify(secretPath)}, 'utf8').trim();`,
    'export const plugin = { rules: { leak: { create: (context) => ({',
    '  Program(node) { context.report({ node, message: secret }); },',
    '}) } } };',
    "export const rules = { 'leak/leak': 'error' };",
    '',
  ].join('\n');
}

function outsideSecret(): string {
  const file = path.join(makeDir('outside'), 'secret.txt');
  writeFileSync(file, 'fixture-outside-secret\n');
  return file;
}

describe('runLaneRebaseLint', () => {
  it('lints the packet with the base config, never a config the packet changes', async () => {
    const repo = initLintRepo('packet-config');
    packetWithConsoleLog(repo, 'packet/config');
    writeFileSync(path.join(repo, 'eslint.config.mjs'), [
      leakingPlugin(outsideSecret()),
      "export default [{ files: ['**/*.js'], plugins: { leak: plugin }, rules }];",
      '',
    ].join('\n'));
    commitAll(repo, 'packet changes the lint config');

    const result = await runLaneRebaseLint({
      cwd: repo, baseRef: 'main', actualBranch: 'packet/config', logPrefix: 'test',
    });
    expect(JSON.stringify(result)).not.toContain('fixture-outside-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.output).toContain('src/packet.js:2:no-console');
  }, 20_000);

  it('never loads a packet version of a module the base config imports', async () => {
    const repo = initLintRepo('packet-module');
    writeFileSync(path.join(repo, 'lint-rules.mjs'), "export const plugin = {};\nexport const rules = { 'no-console': 'warn' };\n");
    writeFileSync(path.join(repo, 'eslint.config.mjs'), [
      "import { plugin, rules } from './lint-rules.mjs';",
      "export default [{ files: ['**/*.js'], plugins: { leak: plugin }, rules }];",
      '',
    ].join('\n'));
    packetWithConsoleLog(repo, 'packet/module');
    writeFileSync(path.join(repo, 'lint-rules.mjs'), leakingPlugin(outsideSecret()));
    commitAll(repo, 'packet changes an imported module');

    const result = await runLaneRebaseLint({
      cwd: repo, baseRef: 'main', actualBranch: 'packet/module', logPrefix: 'test',
    });
    expect(JSON.stringify(result)).not.toContain('fixture-outside-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.output).toContain('src/packet.js:2:no-console');
  }, 20_000);

  it("uses the repository's ESLint install, never one in the packet checkout", async () => {
    const repo = initLintRepo('packet-install');
    packetWithConsoleLog(repo, 'packet/install');
    commitAll(repo, 'packet change');
    git(repo, ['checkout', 'main']);
    const lane = path.join(makeDir('lane'), 'checkout');
    git(repo, ['worktree', 'add', lane, 'packet/install']);
    // The packet checkout's own ESLint reports the secret from the CLI and the API alike.
    const fake = path.join(lane, 'node_modules', 'eslint');
    mkdirSync(path.join(fake, 'bin'), { recursive: true });
    const secret = outsideSecret();
    const leak = `const secret = require('node:fs').readFileSync(${JSON.stringify(secret)}, 'utf8').trim();\n`
      + "const results = (file) => [{ filePath: file, messages: [{ ruleId: 'leak', severity: 2, message: secret, line: 1 }] }];\n";
    writeFileSync(path.join(fake, 'package.json'), JSON.stringify({ name: 'eslint', version: '9.0.0', main: 'api.js' }));
    writeFileSync(path.join(fake, 'api.js'), `${leak}exports.ESLint = class { async lintText(_text, { filePath }) { return results(filePath); } };\n`);
    writeFileSync(path.join(fake, 'bin', 'eslint.js'), `${leak}process.stdout.write(JSON.stringify(results(process.argv.at(-1))));\n`);

    const result = await runLaneRebaseLint({
      cwd: lane, installRoot: repo, baseRef: 'main', actualBranch: 'packet/install', logPrefix: 'test',
    });
    expect(JSON.stringify(result)).not.toContain('fixture-outside-secret');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.output).toContain('src/packet.js:2:no-console');
  }, 20_000);

  it('finds the base in a merge clone where it exists only as the origin ref', async () => {
    const repo = initLintRepo('origin-base');
    packetWithConsoleLog(repo, 'packet/origin');
    commitAll(repo, 'packet change');
    // The operator's checkout is on another branch, so a clone of it has no local main.
    git(repo, ['checkout', '-b', 'operator/wip', 'main']);
    const clone = path.join(makeDir('clone'), 'checkout');
    git(repo, ['clone', '--shared', '--quiet', repo, clone]);
    git(clone, ['checkout', '--detach', 'origin/packet/origin']);
    expect(() => git(clone, ['rev-parse', '--verify', 'refs/heads/main'])).toThrow();

    const result = await runLaneRebaseLint({
      cwd: clone, installRoot: repo, baseRef: 'main', actualBranch: 'packet/origin', logPrefix: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.output).toContain('src/packet.js:2:no-console');
  }, 20_000);

  it('lints in a private checkout in the data directory, never the shared temp dir', async () => {
    const repo = initLintRepo('checkout-place');
    // A base rule that reports where ESLint runs.
    writeFileSync(path.join(repo, 'eslint.config.mjs'), [
      "const where = { rules: { cwd: { create: (context) => ({ Program(node) { context.report({ node, message: `cwd=${process.cwd()}` }); } }) } } };",
      "export default [{ files: ['**/*.js'], plugins: { where }, rules: { 'where/cwd': 'error' } }];",
      '',
    ].join('\n'));
    packetWithConsoleLog(repo, 'packet/place');
    commitAll(repo, 'packet change');

    const result = await runLaneRebaseLint({
      cwd: repo, baseRef: 'main', actualBranch: 'packet/place', logPrefix: 'test',
    });
    expect(result.ok).toBe(false);
    const checkouts = path.join(realpathSync(getDataDir()), 'lint-checkouts');
    if (!result.ok) expect(result.output).toContain(`where/cwd cwd=${checkouts}${path.sep}base-`);
  }, 20_000);

  it('loads only the base root config, never one in a parent directory', async () => {
    const checkouts = path.join(getDataDir(), 'lint-checkouts');
    mkdirSync(checkouts, { recursive: true });
    const planted = path.join(checkouts, 'eslint.config.mjs');
    writeFileSync(planted, [
      leakingPlugin(outsideSecret()),
      "export default [{ files: ['**/*.js'], plugins: { leak: plugin }, rules }];",
      '',
    ].join('\n'));
    try {
      // The base configures ESLint only through package.json.
      const repo = makeDir('package-config');
      git(repo, ['init', '-b', 'main']);
      writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
        private: true,
        scripts: { lint: 'eslint .' },
        eslintConfig: { parserOptions: { ecmaVersion: 2022, sourceType: 'module' }, rules: { 'no-console': 'warn' } },
      }));
      writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
      symlinkSync(path.join(process.cwd(), 'node_modules'), path.join(repo, 'node_modules'), 'junction');
      mkdirSync(path.join(repo, 'src'), { recursive: true });
      packetWithConsoleLog(repo, 'packet/package-config');
      commitAll(repo, 'packet change');

      const result = await runLaneRebaseLint({
        cwd: repo, baseRef: 'main', actualBranch: 'packet/package-config', logPrefix: 'test',
      });
      expect(JSON.stringify(result)).not.toContain('fixture-outside-secret');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.output).toContain('src/packet.js:2:no-console');
    } finally {
      rmSync(planted, { force: true });
    }
  }, 20_000);

  it('skips when the base revision has no lint script or ESLint config', async () => {
    const noScript = makeDir('no-script');
    git(noScript, ['init', '-b', 'main']);
    writePackage(noScript, '');
    writeFileSync(path.join(noScript, 'eslint.config.mjs'), 'export default [];\n');
    writeFileSync(path.join(noScript, 'base.txt'), 'base\n');
    commitAll(noScript, 'base');
    git(noScript, ['checkout', '-b', 'packet/no-script']);
    writeFileSync(path.join(noScript, 'packet.js'), 'export const value = 1;\n');
    commitAll(noScript, 'packet');
    await expect(runLaneRebaseLint({
      cwd: noScript,
      baseRef: 'main',
      actualBranch: 'packet/no-script',
      logPrefix: 'test',
    })).resolves.toEqual({ ok: true, skipped: 'package.json has no lint script' });

    // A packet that adds its own config still gets no lint: the base has none to run.
    const noConfig = makeDir('no-config');
    git(noConfig, ['init', '-b', 'main']);
    writePackage(noConfig);
    writeFileSync(path.join(noConfig, 'base.txt'), 'base\n');
    commitAll(noConfig, 'base');
    git(noConfig, ['checkout', '-b', 'packet/no-config']);
    writeFileSync(path.join(noConfig, 'eslint.config.mjs'), 'export default [];\n');
    writeFileSync(path.join(noConfig, 'packet.js'), 'export const value = 1;\n');
    commitAll(noConfig, 'packet');
    await expect(runLaneRebaseLint({
      cwd: noConfig,
      baseRef: 'main',
      actualBranch: 'packet/no-config',
      logPrefix: 'test',
    })).resolves.toEqual({ ok: true, skipped: 'no ESLint config was found' });
  });

  it('allows a changed file whose warning count does not increase and blocks a new warning', async () => {
    const repo = initLintRepo('warning-diff');
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'console.log("base");\n');
    commitAll(repo, 'base');
    git(repo, ['checkout', '-b', 'packet/warnings']);
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'console.log("base");\nexport const value = 1;\n');
    commitAll(repo, 'keep warning count');

    await expect(runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/warnings',
      logPrefix: 'test',
    })).resolves.toEqual(CLEAN_LINT);

    writeFileSync(
      path.join(repo, 'src', 'packet.js'),
      'console.log("base");\nconsole.log("new");\nexport const value = 1;\n',
    );
    commitAll(repo, 'add warning');

    const result = await runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/warnings',
      logPrefix: 'test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.output).toContain('src/packet.js:2:no-console');
  }, 20_000);

  it('blocks a new warning identity when a different base warning was fixed', async () => {
    const repo = initLintRepo('warning-swap');
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'console.log("base");\n');
    commitAll(repo, 'base warning');
    git(repo, ['checkout', '-b', 'packet/warning-swap']);
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'const replacement = 1;\nexport const value = 1;\n');
    commitAll(repo, 'swap warning');

    const result = await runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/warning-swap',
      logPrefix: 'test',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.output).toContain('src/packet.js:1:no-unused-vars');
      expect(result.output).not.toContain('no-console');
    }
  }, 20_000);

  it('allows an unchanged warning identity after its line shifts', async () => {
    const repo = initLintRepo('warning-shift');
    writeFileSync(path.join(repo, 'src', 'packet.js'), 'console.log("base");\n');
    commitAll(repo, 'base warning');
    git(repo, ['checkout', '-b', 'packet/warning-shift']);
    writeFileSync(
      path.join(repo, 'src', 'packet.js'),
      'export const value = 1;\n\nconsole.log("base");\n',
    );
    commitAll(repo, 'shift warning');

    await expect(runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/warning-shift',
      logPrefix: 'test',
    })).resolves.toEqual(CLEAN_LINT);
  }, 20_000);

  it('turns the hard timeout into a skipped receipt', async () => {
    const repo = makeDir('timeout');
    git(repo, ['init', '-b', 'main']);
    writePackage(repo);
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    writeFileSync(path.join(repo, 'eslint.config.mjs'), 'export default [];\n');
    mkdirSync(path.join(repo, 'node_modules', 'eslint', 'bin'), { recursive: true });
    writeFileSync(path.join(repo, 'node_modules', 'eslint', 'package.json'), JSON.stringify({
      name: 'eslint',
      version: '9.0.0',
      main: 'api.js',
    }));
    writeFileSync(
      path.join(repo, 'node_modules', 'eslint', 'api.js'),
      'exports.ESLint = class { lintText() { return new Promise(() => setTimeout(() => {}, 10_000)); } };\n'
        + 'exports.loadESLint = async () => exports.ESLint;\n',
    );
    const eslintScript = path.join(repo, 'node_modules', 'eslint', 'bin', 'eslint.js');
    writeFileSync(eslintScript, '#!/usr/bin/env node\nsetTimeout(() => {}, 10_000);\n');
    chmodSync(eslintScript, 0o755);
    writeFileSync(path.join(repo, 'base.txt'), 'base\n');
    commitAll(repo, 'base');
    git(repo, ['checkout', '-b', 'packet/timeout']);
    writeFileSync(path.join(repo, 'packet.js'), 'export const value = 1;\n');
    commitAll(repo, 'packet');

    const result = await runLaneRebaseLint({
      cwd: repo,
      baseRef: 'main',
      actualBranch: 'packet/timeout',
      logPrefix: 'test',
      timeoutMs: 100,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skipped).toContain('timeout');
  });
});
