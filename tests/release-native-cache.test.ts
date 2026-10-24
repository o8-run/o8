import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureReleaseBuildCache, collectReleaseBuildCacheIdentity, restoreReleaseBuildCache } from '../scripts/lib/release-build-cache.mjs';

const source = process.cwd();
const roots: string[] = [];
const buildOptions = { cargoTauriArgs: ['--target', 'universal-apple-darwin'], nativeArtifact: true };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function commit(root: string) {
  for (const args of [['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture']]) {
    execFileSync('git', args, { cwd: root });
  }
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'o8-native-cache-'));
  roots.push(base);
  const root = join(base, 'repo');
  const cacheRoot = join(base, 'cache');
  mkdirSync(root); mkdirSync(cacheRoot);
  put(root, '.gitignore', 'src-tauri/target/\nsrc-tauri/helpers/speech_recognizer\nsrc-tauri/helpers/speech_recognizer-*\n.fixture/\nout/\n.next/\nnode_modules/\nsrc-tauri/sidecars/speech-local/.build/\nsrc-tauri/helpers/speech-local*\no8.release.json\n');
  put(root, 'package.json', '{"name":"o8","version":"0.1.0"}');
  put(root, 'src-tauri/Cargo.toml', '[package]\nname = "o8"\nversion = "0.1.0"\n');
  put(root, 'src-tauri/Cargo.lock', 'version = 4\n[[package]]\nname = "o8"\nversion = "0.1.0"\n');
  put(root, 'src-tauri/tauri.conf.json', '{"version":"0.1.0"}');
  put(root, 'src-tauri/src/lib.rs', '// native source\n');
  put(root, 'src-tauri/helpers/speech_recognizer.swift', '// native helper\n');
  put(root, 'src-tauri/sidecars/speech-local/Sources/main.swift', '// speech source\n');
  put(root, 'crates/local/src/lib.rs', '// path dependency\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  commit(root);
  const env = { ...process.env, O8_RELEASE_BUILD_CACHE_DIR: cacheRoot,
    O8_RELEASE_CARGO_TARGET_DIR: join(base, 'release-target'), O8_RELEASE_CARGO_TARGET_MAX_BYTES: '10485760' };
  return { base, root, cacheRoot, env };
}

function compilerFixture() {
  const f = fixture();
  const bin = join(f.base, 'bin');
  mkdirSync(bin);
  const cargo = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-vV')) { console.log('fixture toolchain 1'); process.exit(0); }
const root = process.env.O8_FIXTURE_ROOT;
const event = row => fs.appendFileSync(path.join(root, '.fixture/events'), JSON.stringify(row) + '\\n');
const value = (name, values = args) => values.find(a => a.startsWith(name + '='))?.slice(name.length + 1) || values[values.indexOf(name) + 1];
function compile(values) {
  if (process.env.O8_FIXTURE_CHANGE_DURING_COMPILE) {
    fs.writeFileSync(path.join(root, 'src-tauri/src/lib.rs'), '// source B during compilation');
    if (process.env.O8_FIXTURE_CHANGE_DURING_COMPILE === 'committed') {
      cp.execFileSync('git', ['add', 'src-tauri/src/lib.rs'], { cwd: root });
      cp.execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--allow-empty', '-m', 'compile mutation'], { cwd: root });
    }
  }
  const target = value('--target', values);
  const targetDir = process.env.CARGO_TARGET_DIR || path.join(root, 'src-tauri/target');
  const release = path.join(targetDir, target || '', values.includes('--release') ? 'release' : 'debug');
  const dependency = path.join(release, 'deps/fixture.rlib');
  const dependencyWarm = fs.existsSync(dependency);
  fs.mkdirSync(release, { recursive: true });
  fs.mkdirSync(path.dirname(dependency), { recursive: true }); fs.writeFileSync(dependency, 'compiled dependency');
  let embedded = '';
  const frontend = JSON.parse(process.env.TAURI_CONFIG || '{}').build?.frontendDist;
  if (frontend) {
    const directory = path.resolve(root, 'src-tauri', frontend);
    embedded = fs.readdirSync(directory).sort().map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('');
  }
  const changedSource = fs.readFileSync(path.join(root, 'src-tauri/src/lib.rs'), 'utf8').includes('source B during compilation')
    ? 'source B during compilation' : '';
  fs.writeFileSync(path.join(release, 'o8'), 'compiled native executable' + (process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '') + embedded + changedSource);
  const helper = path.join(release, 'speech_recognizer');
  if (!fs.existsSync(helper)) fs.writeFileSync(helper, 'native helper' + (process.env.MACOSX_DEPLOYMENT_TARGET || ''));
  fs.mkdirSync(path.join(root, 'src-tauri/helpers'), { recursive: true });
  for (const suffix of ['-' + target, '-universal-apple-darwin'])
    fs.copyFileSync(helper, path.join(root, 'src-tauri/helpers/speech_recognizer' + suffix));
  event({ phase: 'compile', target, targetDir, dependencyWarm });
}
if (args[0] === 'tauri' && args[1] === 'build') {
  event({ phase: 'prebuild' });
  if (process.env.O8_FIXTURE_FRONTEND_DURING_PREBUILD)
    fs.writeFileSync(path.join(root, 'frontend/app.js'), 'frontend B from prebuild');
  const configArgument = args.includes('--config') ? value('--config') : args.find(a => a.startsWith('--config='))?.slice(9);
  if (configArgument) process.env.TAURI_CONFIG = configArgument.startsWith('{')
    ? configArgument : fs.readFileSync(path.resolve(root, configArgument), 'utf8');
  const runner = args.includes('--runner') ? value('--runner') : null;
  for (const target of ['x86_64-apple-darwin', 'aarch64-apple-darwin']) {
    const values = ['build', ...(args.includes('--debug') ? [] : ['--release']), '--target', target];
    if (runner) {
      const result = cp.spawnSync(runner, values, { cwd: path.join(root, 'src-tauri'), env: process.env, stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status || 1);
    } else compile(values);
  }
  const universal = path.join(root, 'src-tauri/target/universal-apple-darwin/release');
  fs.mkdirSync(universal, { recursive: true });
  fs.writeFileSync(path.join(universal, 'o8'), 'universal native executable');
  event({ phase: 'bundle', version: JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'))).version });
} else if (args[0] === 'build') compile(args);
else if (args[0] === 'clean') {
  const release = path.join(process.env.CARGO_TARGET_DIR, value('--target') || '', 'release');
  fs.rmSync(path.join(release, 'o8'), { force: true });
}
else throw new Error('Unexpected Cargo invocation');
`;
  for (const name of ['cargo', 'rustc', 'swift', 'xcrun']) {
    put(bin, name, cargo); chmodSync(join(bin, name), 0o700);
  }
  mkdirSync(join(f.root, '.fixture'));
  const env = { ...f.env, O8_FIXTURE_ROOT: f.root, PATH: bin + ':' + process.env.PATH };
  const run = (extra: Partial<NodeJS.ProcessEnv> = {}, args = buildOptions.cargoTauriArgs) => {
    const result = spawnSync(process.execPath, [join(source, 'scripts/tauri-build.mjs'), ...args], {
      cwd: f.root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 90_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  const events = () => readFileSync(join(f.root, '.fixture/events'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { ...f, env, run, events };
}

describe('native release cache real entry points', { timeout: 120_000 }, () => {
  it.each(['dirty', 'committed'])('refuses capture when source becomes %s during compilation', kind => {
    const f = compilerFixture();
    const original = readFileSync(join(f.root, 'src-tauri/src/lib.rs'), 'utf8');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim();
    const output = f.run({ O8_FIXTURE_CHANGE_DURING_COMPILE: kind });
    expect(output).toContain('native capture=bypass reason=source_changed_during_build');
    expect(readFileSync(join(f.root, 'src-tauri/target/x86_64-apple-darwin/release/o8'), 'utf8')).toContain('source B during compilation');
    expect(readdirSync(f.cacheRoot)).not.toContain('entries');
    execFileSync('git', ['switch', '--detach', head], { cwd: f.root, stdio: 'pipe' });
    put(f.root, 'src-tauri/src/lib.rs', original);
    rmSync(join(f.root, 'src-tauri/target'), { recursive: true, force: true });
    expect(f.run()).toContain('native restore=miss');
    expect(f.events().filter(row => row.phase === 'compile')).toHaveLength(4);
    expect(readFileSync(join(f.root, 'src-tauri/target/x86_64-apple-darwin/release/o8'), 'utf8')).not.toContain('source B during compilation');
  });

  it.each(['index.html', 'app.js'])('rebuilds when a custom frontendDist changes %s under an unchanged config', name => {
    const f = compilerFixture();
    put(f.root, 'frontend/index.html', '<html>frontend A</html>');
    put(f.root, 'frontend/app.js', 'frontend A');
    put(f.root, 'src-tauri/custom.json', '{"build":{"frontendDist":"../frontend"}}');
    commit(f.root);
    const args = [...buildOptions.cargoTauriArgs, '--config', 'src-tauri/custom.json'];
    f.run({}, args);
    put(f.root, 'frontend/' + name, 'frontend B'); commit(f.root);
    rmSync(join(f.root, 'src-tauri/target'), { recursive: true, force: true });
    expect(f.run({}, args)).toContain('native restore=miss');
    expect(f.events().filter(row => row.phase === 'compile')).toHaveLength(4);
    expect(readFileSync(join(f.root, 'src-tauri/target/x86_64-apple-darwin/release/o8'), 'utf8')).toContain('frontend B');
  });

  it('revalidates a restored executable after prebuild regenerates ignored frontend assets', () => {
    const f = compilerFixture();
    put(f.root, '.gitignore', readFileSync(join(f.root, '.gitignore'), 'utf8') + 'frontend/\n');
    put(f.root, 'frontend/app.js', 'frontend A');
    put(f.root, 'src-tauri/custom.json', '{"build":{"frontendDist":"../frontend"}}'); commit(f.root);
    const args = [...buildOptions.cargoTauriArgs, '--config', 'src-tauri/custom.json'];
    f.run({}, args);
    const output = f.run({ O8_FIXTURE_FRONTEND_DURING_PREBUILD: '1' }, args);
    expect(readFileSync(join(f.root, 'src-tauri/target/x86_64-apple-darwin/release/o8'), 'utf8')).toContain('frontend B from prebuild');
    expect(f.events().filter(row => row.phase === 'compile')).toHaveLength(4);
    expect(output).toContain('native capture=bypass reason=source_changed_during_build');
  });

  it('hashes scheme-looking frontend file-array entries as local files', async () => {
    const f = fixture();
    put(f.root, '.gitignore', readFileSync(join(f.root, '.gitignore'), 'utf8') + 'src-tauri/asset:page.html\n');
    put(f.root, 'src-tauri/asset:page.html', 'frontend A');
    put(f.root, 'src-tauri/custom.json', '{"build":{"frontendDist":["asset:page.html"]}}'); commit(f.root);
    const options = { env: f.env, buildOptions: { ...buildOptions,
      cargoTauriArgs: [...buildOptions.cargoTauriArgs, '--config', 'src-tauri/custom.json'] } };
    put(f.root, 'src-tauri/target/.release-native-artifact/o8', 'native A');
    expect(await captureReleaseBuildCache(f.root, 'native', options)).toMatchObject({ status: 'captured' });
    put(f.root, 'src-tauri/asset:page.html', 'frontend B');
    rmSync(join(f.root, 'src-tauri/target'), { recursive: true, force: true });
    expect(await restoreReleaseBuildCache(f.root, 'native', options)).toMatchObject({ status: 'miss' });
  });

  it('restores unchanged native code after a web-only commit and skips both native compiles', () => {
    const f = compilerFixture();
    f.run();
    const repeated = f.run();
    expect(f.events().filter(row => row.phase === 'compile')).toHaveLength(2);
    expect(repeated).toContain('native restore=hit_exact');
    put(f.root, 'src/web.ts', '// web-only change\n'); commit(f.root);
    rmSync(join(f.root, 'src-tauri/target'), { recursive: true, force: true });
    const output = f.run();
    expect(output).toContain('native restore=hit_compatible');
    expect(f.events().filter(row => row.phase === 'compile')).toHaveLength(2);
    expect(f.events().filter(row => row.phase === 'prebuild')).toHaveLength(3);
    expect(f.events().filter(row => row.phase === 'bundle').map(row => row.version)).toEqual(['0.1.0', '0.1.0', '0.1.0']);
  });

  it('rebuilds a version-only change while the native runtime still embeds the version', () => {
    const f = compilerFixture(); f.run();
    for (const path of ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json']) {
      put(f.root, path, readFileSync(join(f.root, path), 'utf8').replaceAll('0.1.0', '0.1.1'));
    }
    commit(f.root);
    rmSync(join(f.root, 'src-tauri/target'), { recursive: true, force: true });
    const output = f.run();
    expect(output).toContain('native restore=miss');
    expect(f.events().filter(row => row.phase === 'compile')).toHaveLength(4);
    expect(f.events().filter(row => row.phase === 'prebuild')).toHaveLength(2);
    expect(f.events().filter(row => row.phase === 'bundle').map(row => row.version)).toEqual(['0.1.0', '0.1.1']);
  });

  it('uses a persistent release target across fresh checkouts and keeps development builds separate', () => {
    const f = compilerFixture();
    f.run();
    const first = f.events().filter(row => row.phase === 'compile');
    expect(first.map(row => realpathSync(row.targetDir))).toEqual([realpathSync(f.env.O8_RELEASE_CARGO_TARGET_DIR), realpathSync(f.env.O8_RELEASE_CARGO_TARGET_DIR)]);
    expect(first.map(row => row.dependencyWarm)).toEqual([false, false]);
    const second = join(f.base, 'fresh');
    execFileSync('git', ['clone', '--quiet', f.root, second]);
    mkdirSync(join(second, '.fixture'));
    put(second, 'src-tauri/src/lib.rs', '// changed native source\n'); commit(second);
    const result = spawnSync(process.execPath, [join(source, 'scripts/tauri-build.mjs'), ...buildOptions.cargoTauriArgs], {
      cwd: second, env: { ...f.env, O8_FIXTURE_ROOT: second }, encoding: 'utf8', timeout: 90_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const rows = readFileSync(join(second, '.fixture/events'), 'utf8').trim().split('\n').map(row => JSON.parse(row));
    expect(rows.filter(row => row.phase === 'compile').every(row => realpathSync(row.targetDir) === realpathSync(f.env.O8_RELEASE_CARGO_TARGET_DIR))).toBe(true);
    expect(rows.filter(row => row.phase === 'compile').map(row => row.dependencyWarm)).toEqual([true, true]);
    f.run({}, ['--debug', ...buildOptions.cargoTauriArgs]);
    expect(f.events().filter(row => row.phase === 'compile').slice(-2).every(row => realpathSync(row.targetDir) === realpathSync(join(f.root, 'src-tauri/target')))).toBe(true);
  });

  it.each(['corrupt', 'mismatched'])('refuses a %s native artifact and recompiles', mode => {
    const f = compilerFixture(); f.run();
    const directory = join(f.cacheRoot, 'entries/native');
    const compatibility = readdirSync(directory)[0];
    const manifestPath = join(directory, compatibility, readdirSync(join(directory, compatibility)).find(name => name.endsWith('.json'))!);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (mode === 'corrupt') writeFileSync(join(dirname(manifestPath), manifest.archive.name), 'damaged');
    else { manifest.targets = ['wrong/target']; writeFileSync(manifestPath, JSON.stringify(manifest)); }
    rmSync(join(f.root, 'src-tauri/target'), { recursive: true, force: true });
    expect(f.run()).toContain('native restore=miss');
    expect(f.events().filter(row => row.phase === 'compile')).toHaveLength(4);
    rmSync(join(f.root, 'src-tauri/target'), { recursive: true, force: true });
    expect(f.run()).toContain('native restore=hit_exact');
    expect(f.events().filter(row => row.phase === 'compile')).toHaveLength(4);
  });

  it('bounds the persistent release target after compilation without deleting the staged executable', () => {
    const f = compilerFixture();
    expect(f.run({ O8_RELEASE_CARGO_TARGET_MAX_BYTES: '0' })).toContain('Cargo target pruned');
    expect(readdirSync(f.env.O8_RELEASE_CARGO_TARGET_DIR)).toEqual(['.o8-release-cargo-target']);
    expect(readFileSync(join(f.root, 'src-tauri/target/x86_64-apple-darwin/release/o8'), 'utf8')).toBe('compiled native executable');
  });

  it('rebuilds generated native helpers after a compiler environment change', () => {
    const f = compilerFixture(); f.run();
    f.run({ MACOSX_DEPLOYMENT_TARGET: '12.0' });
    expect(readFileSync(join(f.root, 'src-tauri/helpers/speech_recognizer-universal-apple-darwin'), 'utf8')).toBe('native helper12.0');
  });

  it('passes the same resolved public client configuration to Cargo that the cache hashes', () => {
    const f = compilerFixture();
    put(f.root, 'o8.release.json', '{"clerkPublishableKey":"fixture-client"}');
    f.run({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: '' });
    expect(readFileSync(join(f.root, 'src-tauri/target/x86_64-apple-darwin/release/o8'), 'utf8')).toBe('compiled native executablefixture-client');
  });

  it.each(['checkout', 'development', 'unowned'])('refuses a persistent target using %s output', kind => {
    const f = compilerFixture();
    const target = kind === 'checkout' ? join(f.root, 'src-tauri/target') : join(f.base, 'other-output');
    put(target, 'keep', 'unrelated output');
    const result = spawnSync(process.execPath, [join(source, 'scripts/tauri-build.mjs'), ...buildOptions.cargoTauriArgs], {
      cwd: f.root, env: { ...f.env, O8_RELEASE_CARGO_TARGET_DIR: target,
        ...(kind === 'development' ? { CARGO_TARGET_DIR: target } : {}) }, encoding: 'utf8', timeout: 90_000,
    });
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('unrelated output');
  });

  it.each(['src-tauri/src/lib.rs', 'src-tauri/helpers/speech_recognizer.swift', 'crates/local/src/lib.rs',
    'src-tauri/Cargo.lock', 'src-tauri/capabilities/default.json', '.cargo/config.toml', 'rust-toolchain.toml'])(
    'misses after changing native input %s', async path => {
      const f = fixture();
      put(f.root, 'src-tauri/target/.release-native-artifact/o8', 'native artifact');
      const before = collectReleaseBuildCacheIdentity(f.root, 'native', { env: f.env, buildOptions });
      expect(await captureReleaseBuildCache(f.root, 'native', { env: f.env, buildOptions, identity: before })).toMatchObject({ status: 'captured' });
      put(f.root, path, path.endsWith('Cargo.lock') ? 'changed dependency lock' : '// changed input\n'); commit(f.root);
      rmSync(join(f.root, 'src-tauri/target'), { recursive: true, force: true });
      expect(await restoreReleaseBuildCache(f.root, 'native', { env: f.env, buildOptions })).toMatchObject({ status: 'miss', reason: 'entry_missing' });
    });

  it.each(['RUSTFLAGS', 'MACOSX_DEPLOYMENT_TARGET', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'SENTRY_DSN', 'CARGO_PROFILE_RELEASE_LTO'])(
    'misses after changing build-time environment %s without recording the value', async key => {
      const f = fixture();
      put(f.root, 'src-tauri/target/.release-native-artifact/o8', 'native artifact');
      const before = collectReleaseBuildCacheIdentity(f.root, 'native', { env: f.env, buildOptions });
      expect(await captureReleaseBuildCache(f.root, 'native', { env: f.env, buildOptions, identity: before })).toMatchObject({ status: 'captured' });
      const env = { ...f.env, [key]: 'fixture-changed-build-setting' };
      const after = collectReleaseBuildCacheIdentity(f.root, 'native', { env, buildOptions });
      expect(JSON.stringify(after.compatibility)).not.toContain('fixture-changed-build-setting');
      rmSync(join(f.root, 'src-tauri/target'), { recursive: true, force: true });
      expect(await restoreReleaseBuildCache(f.root, 'native', { env, buildOptions })).toMatchObject({ status: 'miss' });
    });

  it('restores a portable native artifact in a different clean checkout', async () => {
    const f = fixture();
    put(f.root, 'src-tauri/target/.release-native-artifact/o8', 'native artifact');
    expect(await captureReleaseBuildCache(f.root, 'native', { env: f.env, buildOptions })).toMatchObject({ status: 'captured' });
    const second = join(f.base, 'fresh');
    execFileSync('git', ['clone', '--quiet', f.root, second]);
    expect(await restoreReleaseBuildCache(second, 'native', { env: f.env, buildOptions })).toMatchObject({ status: 'hit_exact' });
    expect(readFileSync(join(second, 'src-tauri/target/.release-native-artifact/o8'), 'utf8')).toBe('native artifact');
  });

  it('skips unchanged speech compilation through prebuild and rebuilds changed speech sources', () => {
    const f = fixture();
    put(f.root, 'scripts/build-speech-local.mjs', `
      import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
      mkdirSync('src-tauri/sidecars/speech-local/.build', { recursive: true });
      mkdirSync('src-tauri/helpers', { recursive: true });
      writeFileSync('src-tauri/sidecars/speech-local/.build/proof', 'speech compiler state');
      for (const suffix of ['', '-aarch64-apple-darwin', '-x86_64-apple-darwin', '-universal-apple-darwin'])
        writeFileSync('src-tauri/helpers/speech-local' + suffix, 'speech executable');
      appendFileSync('.fixture/speech-calls', 'compile\\n');
    `);
    for (const name of ['build-pi-write.mjs', 'bust-stale-patch-cache.mjs', 'packaged-server-smoke.mjs'])
      put(f.root, 'scripts/' + name, 'process.exit(0);');
    put(f.root, 'scripts/tauri-export.mjs', `
      import { mkdirSync, writeFileSync } from 'node:fs';
      mkdirSync('out', { recursive: true }); writeFileSync('out/server.js', 'export');
    `);
    put(f.root, 'node_modules/next/dist/bin/next', `
      const fs = require('node:fs'); fs.mkdirSync('.next/cache', { recursive: true });
      fs.writeFileSync('.next/cache/proof', 'web compiler state');
    `);
    mkdirSync(join(f.root, '.fixture')); commit(f.root);
    const script = `
      import { spawnSync } from 'node:child_process';
      import { runPrebuild } from ${JSON.stringify(new URL('../scripts/lib/prebuild-continuation.mjs', import.meta.url).href)};
      await runPrebuild({ canReuse: false, runBuild: operation => operation(async (command, args, env) => {
        const result = spawnSync(command, args, { env, stdio: 'inherit' });
        if (result.error) throw result.error; return result.status ?? 1;
      }) });
    `;
    const run = () => {
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: f.root, env: f.env, encoding: 'utf8', timeout: 90_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result.stdout;
    };
    run();
    for (const path of ['src-tauri/sidecars/speech-local/.build', '.next', 'out',
      ...['', '-aarch64-apple-darwin', '-x86_64-apple-darwin', '-universal-apple-darwin'].map(suffix => 'src-tauri/helpers/speech-local' + suffix)])
      rmSync(join(f.root, path), { recursive: true, force: true });
    expect(run()).toContain('speech restore=hit_exact');
    expect(readFileSync(join(f.root, '.fixture/speech-calls'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(join(f.root, 'src-tauri/helpers/speech-local-universal-apple-darwin'), 'utf8')).toBe('speech executable');
    expect(run()).toContain('speech restore=hit_exact');
    expect(readFileSync(join(f.root, '.fixture/speech-calls'), 'utf8').trim().split('\n')).toHaveLength(1);
    put(f.root, 'src-tauri/sidecars/speech-local/Sources/main.swift', '// changed speech source\n'); commit(f.root);
    expect(run()).toContain('speech restore=miss');
    expect(readFileSync(join(f.root, '.fixture/speech-calls'), 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
