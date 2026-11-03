#!/usr/bin/env node
// Keep workspace executables and fingerprints, which dependency-only caches prune.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';

const crate = 'native/o8-next';
const target = path.resolve(process.env.CARGO_TARGET_DIR || `${crate}/target`);
const cargoHome = path.resolve(process.env.CARGO_HOME || '.o8-next-cargo');
function command(name, args) {
  const result = spawnSync(name, args, { encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 });
  if (result.error || result.status !== 0) throw new Error(`${name}: ${result.error?.message || result.stderr}`);
  return result.stdout;
}
function output(name, value) {
  console.log(`[native-cache] ${name}=${value}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
const hash = value => createHash('sha256').update(value).digest('hex');
// All tracked crate inputs include src/**, Cargo.toml, tests, build scripts,
// fixtures and vendored path dependencies. No target artifacts enter the key.
function sources() {
  const tracked = new Set(command('git', ['ls-files', '-z']).split('\0').filter(Boolean));
  const inputs = new Set([...tracked].filter(file => file.startsWith(`${crate}/`)
    || file.startsWith('.cargo/') || /^rust-toolchain(?:\.toml)?$/.test(file)
    || file === 'scripts/ci/native-test-cache.mjs'));
  // Rust embeds a few repository fixtures outside the crate. Their checkout
  // mtimes also invalidate dep-info, and their contents must enter the key.
  for (const file of inputs) {
    if (!file.endsWith('.rs')) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(/\binclude(?:_str|_bytes)?!\(\s*"([^"]+)"/g)) {
      const included = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (tracked.has(included)) inputs.add(included);
    }
  }
  return [...inputs].sort();
}
switch (process.argv[2]) {
  case 'key': {
    const compiler = command('rustc', ['--version', '--verbose']);
    const configuration = [process.platform, process.arch, compiler,
      process.env.CARGO_PROFILE_DEV_DEBUG, process.env.CARGO_INCREMENTAL,
      process.env.RUSTFLAGS, process.env.CARGO_ENCODED_RUSTFLAGS];
    const lock = hash(readFileSync(`${crate}/Cargo.lock`));
    const source = createHash('sha256');
    for (const file of sources()) source.update(file).update('\0').update(readFileSync(file)).update('\0');
    const prefix = `native-tests-v1-${hash(JSON.stringify(configuration))}-${lock}-`;
    output('key', `${prefix}${source.digest('hex')}`);
    output('restore-key', prefix);
    break;
  }
  case 'restore': {
    // A new checkout is newer than cached Cargo dep-info. Only an exact content
    // key may backdate inputs; fallback restores must recompile changed sources.
    if (process.env.O8_NATIVE_CACHE_HIT !== 'true') break;
    const directories = new Set();
    const stamp = new Date('2000-01-01T00:00:00Z');
    for (const file of sources()) {
      utimesSync(file, stamp, stamp);
      for (let dir = path.dirname(file); dir.startsWith(crate); dir = path.dirname(dir)) directories.add(dir);
    }
    for (const dir of directories) utimesSync(dir, stamp, stamp);
    console.log('[native-cache] exact hit: restored source freshness for Cargo');
    break;
  }
  case 'measure': {
    // Incremental objects do not help CARGO_INCREMENTAL=0. Keep .fingerprint,
    // deps, build and the ordinary app so both feature configurations survive.
    rmSync(path.join(target, 'debug/incremental'), { recursive: true, force: true });
    function measure() {
      let total = 0;
      for (const [label, directory] of [['target', target], ['registry', path.join(cargoHome, 'registry')],
        ['git', path.join(cargoHome, 'git')]]) {
        const bytes = existsSync(directory) ? Number(command('du', ['-sb', directory]).split(/\s/)[0]) : 0;
        output(`${label}-bytes`, bytes);
        total += bytes;
      }
      return total;
    }
    const budget = 4 * 1024 ** 3;
    let total = measure();
    if (total > budget) {
      // Match the existing action's dependency-only profile layout if full
      // executables exceed the budget. Cargo rebuilds any removed outputs.
      console.log('[native-cache] oversized target: retaining dependency build/deps/fingerprint outputs');
      for (const entry of readdirSync(target)) {
        if (!['debug', 'CACHEDIR.TAG', '.rustc_info.json'].includes(entry)) {
          rmSync(path.join(target, entry), { recursive: true, force: true });
        }
      }
      const debug = path.join(target, 'debug');
      if (existsSync(debug)) {
        for (const entry of readdirSync(debug)) {
          if (!['deps', 'build', '.fingerprint'].includes(entry)) rmSync(path.join(debug, entry), { recursive: true, force: true });
        }
      }
      const deps = path.join(debug, 'deps');
      if (existsSync(deps)) {
        for (const entry of readdirSync(deps)) {
          const file = path.join(deps, entry);
          // Keep dependency libraries, including executable proc-macro .so files.
          if (!entry.startsWith('lib') && statSync(file).isFile() && (statSync(file).mode & 0o111)) rmSync(file);
        }
      }
      total = measure();
    }
    // One shared snapshot, saved by shard 8. The service evicts older source
    // keys within its repository quota; never upload a snapshot above 4 GiB.
    output('cacheable', total <= budget ? 'true' : 'false');
    if (total > budget) console.log('::warning::Dependency cache exceeds 4 GiB; skip saving this snapshot.');
    break;
  }
  default: throw new Error('usage: native-test-cache.mjs key|restore|measure');
}
