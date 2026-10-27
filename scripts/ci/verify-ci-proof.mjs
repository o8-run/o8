#!/usr/bin/env node
// Execute the entire local verifier on a clean checkout or one bounded fault.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const scenario = process.argv[2];
const expected = { clean: null, integration: 'Integration Tests (changed files)',
  dependency: 'Security Audit', bundle: 'Server Bundle Size' };
if (!Object.hasOwn(expected, scenario)) throw new Error('expected clean, integration, dependency or bundle');
if (scenario === 'integration') {
  const file = 'tests/verify-ci-real-path.test.ts';
  writeFileSync(file, readFileSync(file, 'utf8') + "\nit('rejects the injected integration assertion', () => { expect(false).toBe(true); });\n");
}
if (scenario === 'dependency') {
  // This addition has a low-severity advisory, below the root audit's high gate.
  const added = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--save-dev', 'cookie@0.6.0'], { stdio: 'inherit' });
  if (added.status !== 0) throw new Error('could not prepare vulnerable dependency injection');
}
if (scenario === 'bundle') {
  const file = 'tests/server-bundle-size-real-path.test.ts';
  const source = readFileSync(file, 'utf8');
  const original = "rmSync(join(root, 'node_modules'), { recursive: true, force: true });\n    writeFileSync(join(outDir, 'native-addon-runtime.cjs'), 'exports.prepareNativeAddons = () => {};');";
  if (!source.includes(original)) throw new Error('bundle injection target changed');
  writeFileSync(file, source.replace(original, "rmSync(join(root, 'node_modules'), { recursive: true, force: true });"));
}
const started = Date.now();
const result = spawnSync('npm', ['run', 'verify:ci'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
const seconds = Math.round((Date.now() - started) / 1000);
const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const confirmed = scenario === 'clean' ? result.status === 0
  : result.status === 1 && output.includes(`[verify:ci] FAIL ${expected[scenario]}`);
console.log(`[verify:ci proof] ${scenario}: exit ${result.status}; ${Math.floor(seconds / 60)}m${seconds % 60}s; ${confirmed ? 'PASS' : 'FAIL'}`);
process.exitCode = confirmed ? 0 : 1;
