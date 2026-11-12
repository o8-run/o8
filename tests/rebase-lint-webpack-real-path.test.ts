import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LaneRebaseLintResult } from '@/lib/lane/rebase-lint';

const require = createRequire(import.meta.url);
const roots: string[] = [];
const { webpack } = require('next/dist/compiled/webpack/webpack');
const { defaultConfig } = require('next/dist/server/config-shared');
const { transformSync } = require('next/dist/build/swc');
let runLint: (input: { cwd: string; baseRef: string; actualBranch: string; logPrefix: string }) => Promise<LaneRebaseLintResult>;
let warnings: string[];

function fixture(label: string) {
  const root = mkdtempSync(path.join(tmpdir(), `o8-webpack-lint-${label}-`));
  roots.push(root);
  return root;
}

beforeAll(async () => {
  const root = fixture('bundle');
  const externals: Record<string, string> = {};
  // Only these imports bypass this focused compilation. Each bridge loads the
  // actual source implementation, preserving Git and process confinement.
  for (const request of ['@/lib/data-dir-migration', '@/lib/lane/lane-git', '@/lib/sandbox/run-confined', '@/lib/git/binary', '@/lib/providers/child-process']) {
    const bridge = path.join(root, path.basename(request) + '.cjs');
    const source = path.resolve('src', request.slice(2) + '.ts');
    writeFileSync(bridge, `module.exports = require(${JSON.stringify(require.resolve('tsx/cjs/api'))}).require(${JSON.stringify(source)}, __filename);\n`);
    externals[request] = 'commonjs ' + bridge;
  }
  transformSync('', { jsc: { parser: { syntax: 'ecmascript' } } });
  const compiler = webpack({
    mode: 'production', target: 'node', context: process.cwd(), cache: false, devtool: false,
    entry: path.resolve('src/lib/lane/rebase-lint.ts'),
    externals, externalsPresets: { node: true }, optimization: { minimize: false },
    module: { rules: [{ test: /\.ts$/, use: [{
      loader: require.resolve('next/dist/build/webpack/loaders/next-swc-loader'),
      options: {
        isServer: true, compilerType: 'server', rootDir: process.cwd(),
        appDir: path.resolve('src/app'), hasReactRefresh: false,
        nextConfig: { ...defaultConfig, experimental: { ...defaultConfig.experimental, useCache: false }, cacheComponents: false },
        jsConfig: { compilerOptions: {} }, serverComponents: true,
        serverReferenceHashSalt: 'rebase-lint-boundary', esm: true,
      },
    }] }] },
    output: { path: root, filename: 'lint.cjs', library: { type: 'commonjs2' } },
    infrastructureLogging: { level: 'error' },
  });
  try {
    const stats = await new Promise<{ toJson: (options: object) => { errors?: Array<{ message: string }>; warnings?: Array<{ message: string }> } }>((resolve, reject) => {
      compiler.run((error: Error | null, result: never) => error ? reject(error) : resolve(result));
    });
    const report = stats.toJson({ all: false, errors: true, warnings: true });
    expect(report.errors ?? []).toEqual([]);
    warnings = (report.warnings ?? []).map(item => item.message);
    runLint = require(path.join(root, 'lint.cjs')).runLaneRebaseLint;
  } finally {
    await new Promise<void>((resolve, reject) => compiler.close((error: Error | null) => error ? reject(error) : resolve()));
  }
}, 60_000);

afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function lintRepo(installed: boolean) {
  const root = fixture('repo');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: { lint: 'eslint .' } }));
  writeFileSync(path.join(root, 'eslint.config.mjs'), "export default [{ files: ['**/*.js'], rules: { 'no-debugger': 'error' } }];\n");
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n');
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src', 'changed.js'), 'export const value = 1;\n');
  if (installed) symlinkSync(path.resolve('node_modules'), path.join(root, 'node_modules'), 'junction');
  git('init', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', 'base');
  git('checkout', '-b', 'packet/lint');
  writeFileSync(path.join(root, 'src', 'changed.js'), 'debugger;\nexport const value = 1;\n');
  git('add', '.');
  git('-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', 'change');
  return root;
}

describe('exported lane lint runtime resolution', () => {
  it('executes local ESLint from the emitted module and blocks a real changed-file error', async () => {
    const result = await runLint({ cwd: lintRepo(true), baseRef: 'main', actualBranch: 'packet/lint', logPrefix: 'bundle-test' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.output).toContain('src/changed.js:1:no-debugger');
    expect(warnings.filter(message => message.includes('createRequire'))).toEqual([]);
  }, 60_000);

  it('retains the explicit skip when local ESLint is actually absent', async () => {
    const result = await runLint({ cwd: lintRepo(false), baseRef: 'main', actualBranch: 'packet/lint', logPrefix: 'bundle-test' });
    expect(result).toEqual({ ok: true, skipped: 'no local ESLint installation was found' });
  }, 30_000);
});
