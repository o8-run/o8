import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'o8-native-cache-'));
const crate = join(root, 'native/o8-next');
const target = join(crate, 'target');
const cargo = join(root, 'cargo');
const output = join(root, 'outputs');
const script = fileURLToPath(new URL('./native-test-cache.mjs', import.meta.url));
after(() => rmSync(root, { recursive: true, force: true }));
function write(file, text) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
}
for (const file of ['src/main.rs', 'Cargo.toml', 'Cargo.lock', 'vendor/gpui/src/lib.rs', 'tests/terminal.rs']) write(join(crate, file), file);
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
write(join(root, '.cargo/config.toml'), '[build]');
write(join(root, 'docs/spec.md'), 'embedded specification');
write(join(crate, 'src/main.rs'), 'const SPEC: &str = include_str!("../../../docs/spec.md");');
git(['init', '-q']);
git(['add', 'native', 'docs', '.cargo']);
function run(mode, hit = '') {
  rmSync(output, { force: true });
  const result = spawnSync(process.execPath, [script, mode], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output,
      CARGO_HOME: cargo, CARGO_TARGET_DIR: target, O8_NATIVE_CACHE_HIT: hit },
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return existsSync(output) ? Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => {
    const split = line.indexOf('=');
    return [line.slice(0, split), line.slice(split + 1)];
  })) : {};
}

test('source, manifest, vendored and test changes miss the exact key but retain the lockfile fallback', () => {
  const initial = run('key');
  assert.equal(run('key').key, initial.key);
  for (const file of ['src/main.rs', 'Cargo.toml', 'vendor/gpui/src/lib.rs', 'tests/terminal.rs']) {
    const original = readFileSync(join(crate, file), 'utf8');
    write(join(crate, file), `${original} changed`);
    const changed = run('key');
    assert.notEqual(changed.key, initial.key, file);
    assert.equal(changed['restore-key'], initial['restore-key'], file);
    write(join(crate, file), original);
  }
  write(join(root, '.cargo/config.toml'), '[build]\njobs = 2');
  assert.notEqual(run('key').key, initial.key);
  assert.equal(run('key')['restore-key'], initial['restore-key']);
  write(join(root, '.cargo/config.toml'), '[build]');
  write(join(root, 'docs/spec.md'), 'changed embedded specification');
  assert.notEqual(run('key').key, initial.key);
  assert.equal(run('key')['restore-key'], initial['restore-key']);
  write(join(crate, 'Cargo.lock'), 'lock changed');
  assert.notEqual(run('key')['restore-key'], initial['restore-key']);
});

test('only exact hits backdate checkout inputs, leaving cached Cargo dep-info intact', () => {
  const source = join(crate, 'src/main.rs');
  const depInfo = join(target, 'debug/.fingerprint/o8-next-fixture/dep-bin-o8-next');
  write(depInfo, 'compiled');
  const stamp = new Date('2026-01-01T00:00:00Z');
  utimesSync(source, stamp, stamp);
  const before = statSync(source).mtimeMs;
  const cached = statSync(depInfo).mtimeMs;
  run('restore', 'false');
  assert.equal(statSync(source).mtimeMs, before);
  run('restore', 'true');
  assert.ok(statSync(source).mtimeMs < cached);
  assert.ok(statSync(join(crate, 'vendor/gpui/src/lib.rs')).mtimeMs < cached);
  assert.ok(statSync(join(root, 'docs/spec.md')).mtimeMs < cached);
  assert.equal(statSync(depInfo).mtimeMs, cached);
});

test('measurement logs target bytes, prunes incremental objects and keeps both app configurations', () => {
  write(join(target, 'debug/incremental/disposable'), 'unused');
  write(join(target, 'debug/o8-next'), 'ordinary app');
  write(join(target, 'debug/deps/o8_next-test'), 'test app');
  write(join(cargo, 'registry/index/config.json'), '{}');
  const result = run('measure');
  assert.ok(Number(result['target-bytes']) > 0);
  assert.ok(Number(result['registry-bytes']) > 0);
  assert.equal(result.cacheable, 'true');
  assert.equal(existsSync(join(target, 'debug/incremental')), false);
  assert.equal(readFileSync(join(target, 'debug/o8-next'), 'utf8'), 'ordinary app');
  assert.equal(readFileSync(join(target, 'debug/deps/o8_next-test'), 'utf8'), 'test app');
});

test('an oversized target falls back to dependency outputs within the cache budget', () => {
  const registration = join(target, 'pull-request-registration-target/debug/deps/libregistration.rmeta');
  write(registration, 'registration');
  truncateSync(registration, 5 * 1024 ** 3); // Separate budget; no large allocation.
  const registrationOnly = run('measure');
  assert.ok(Number(registrationOnly['registration-bytes']) >= 5 * 1024 ** 3);
  assert.ok(Number(registrationOnly['target-bytes']) < 1024 ** 2);
  assert.equal(registrationOnly.cacheable, 'true');
  const binary = join(target, 'debug/deps/o8_next-test');
  truncateSync(binary, 5 * 1024 ** 3); // Sparse fixture: no large allocation.
  chmodSync(binary, 0o755);
  write(join(target, 'debug/deps/libdependency.rlib'), 'dependency');
  write(join(target, 'debug/build/dependency/output'), 'build result');
  const result = run('measure');
  assert.equal(result.cacheable, 'true');
  assert.equal(existsSync(binary), false);
  assert.equal(existsSync(join(target, 'debug/o8-next')), false);
  assert.equal(readFileSync(join(target, 'debug/deps/libdependency.rlib'), 'utf8'), 'dependency');
  assert.equal(readFileSync(join(target, 'debug/build/dependency/output'), 'utf8'), 'build result');
  assert.ok(Number(result['registration-bytes']) >= 5 * 1024 ** 3);
  assert.equal(statSync(registration).size, 5 * 1024 ** 3);
});

test('the source manifest counts against the 4 GiB snapshot budget', () => {
  const padding = join(cargo, 'registry/cache/padding');
  write(padding, '');
  const measured = run('measure');
  const bytes = [target, join(cargo, 'registry')].reduce((total, directory) => {
    const result = spawnSync('du', ['-sb', directory], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return total + Number(result.stdout.split(/\s/)[0]);
  }, -Number(measured['registration-bytes']));
  const manifestBytes = statSync(join(target, '.o8-native-sources.json')).size;
  // Leave eight bytes before writing the source manifest. A sparse registry
  // entry exercises the real measurement command without a large allocation.
  truncateSync(padding, 4 * 1024 ** 3 - bytes + manifestBytes - 8);
  try {
    const result = run('measure');
    console.log(`[native-cache-proof] manifest=${manifestBytes} budget=${4 * 1024 ** 3} cacheable=${result.cacheable}`);
    assert.equal(result.cacheable, 'false');
  } finally { rmSync(padding); }
});

test('a source-matched checkout reuses the real Cargo test executable', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'o8-native-warm-'));
  const fixtureCrate = join(fixture, 'native/o8-next');
  const fixtureTarget = join(fixtureCrate, 'target');
  const env = { ...process.env, CARGO_HOME: cargo, CARGO_TARGET_DIR: fixtureTarget,
    CARGO_INCREMENTAL: '0', CARGO_PROFILE_DEV_DEBUG: '0', O8_NATIVE_CACHE_HIT: 'true' };
  function execute(command, args) {
    const result = spawnSync(command, args, { cwd: fixture, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  }
  try {
    write(join(fixtureCrate, 'Cargo.toml'), '[package]\nname = "o8-next"\nversion = "0.0.0"\nedition = "2021"\n[workspace]\n[profile.dev]\nopt-level = 1\n');
    const source = join(fixtureCrate, 'src/lib.rs');
    write(source, '#[test] fn smoke() { assert_eq!(2 + 2, 4); }\n');
    const args = ['test', '--locked', '--manifest-path', 'native/o8-next/Cargo.toml', '--no-run', '--message-format=json'];
    execute('cargo', ['generate-lockfile', '--offline', '--manifest-path', 'native/o8-next/Cargo.toml']);
    execute('git', ['init', '-q']);
    execute('git', ['add', 'native/o8-next/Cargo.toml', 'native/o8-next/Cargo.lock', 'native/o8-next/src/lib.rs']);
    const artifact = output => output.split('\n').filter(Boolean).map(line => JSON.parse(line))
      .find(entry => entry.reason === 'compiler-artifact' && entry.profile.test);
    assert.equal(artifact(execute('cargo', args)).fresh, false);
    const key = execute(process.execPath, [script, 'key']);
    const measured = execute(process.execPath, [script, 'measure']);
    assert.match(measured, /cacheable=true/);
    // Model a fresh checkout restoring the same cached target directory.
    const stamp = new Date(Date.now() + 60_000);
    utimesSync(source, stamp, stamp);
    assert.equal(execute(process.execPath, [script, 'key']), key);
    execute(process.execPath, [script, 'restore']);
    const started = Date.now();
    const warm = artifact(execute('cargo', args));
    assert.equal(warm.fresh, true, 'restored test executable must not be recompiled');
    assert.match(execute(warm.executable, ['--exact', 'smoke']), /1 passed/);
    console.log(`[native-cache-proof] warm Cargo+libtest=${Date.now() - started}ms\n${measured}`);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
