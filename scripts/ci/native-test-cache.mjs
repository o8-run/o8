#!/usr/bin/env node
// Keep workspace executables and fingerprints, which dependency-only caches prune.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const crate = 'native/o8-next';
const target = path.resolve(process.env.CARGO_TARGET_DIR || `${crate}/target`);
const registrationTarget = path.join(target, 'pull-request-registration-target');
const manifestPath = path.join(target, '.o8-native-sources.json');
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
function cacheIdentity() {
  const compiler = command('rustc', ['--version', '--verbose']);
  const configuration = [process.platform, process.arch, compiler,
    process.env.CARGO_PROFILE_DEV_DEBUG, process.env.CARGO_INCREMENTAL,
    process.env.RUSTFLAGS, process.env.CARGO_ENCODED_RUSTFLAGS];
  return { configuration: hash(JSON.stringify(configuration)), lockfile: hash(readFileSync(`${crate}/Cargo.lock`)) };
}
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
    if (!file.endsWith('.rs') || !existsSync(file)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(/\binclude(?:_str|_bytes)?!\(\s*"([^"]+)"/g)) {
      const included = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (tracked.has(included)) inputs.add(included);
    }
  }
  return [...inputs].sort();
}
switch (process.argv[2]) {
  case 'key': {
    const { configuration, lockfile } = cacheIdentity();
    const source = createHash('sha256');
    for (const file of sources()) source.update(file).update('\0').update(readFileSync(file)).update('\0');
    const prefix = `native-tests-v1-${configuration}-${lockfile}-`;
    output('key', `${prefix}${source.digest('hex')}`);
    output('restore-key', prefix);
    output('registration-key', `native-registration-v1-${configuration}-${lockfile}`);
    output('registration-restore-key', `native-registration-v1-${configuration}-`);
    break;
  }
  case 'restore': {
    // A new checkout is newer than cached Cargo dep-info. On fallback restores,
    // only content proven unchanged by the cached manifest may be backdated.
    const exact = process.env.O8_NATIVE_CACHE_HIT === 'true';
    let manifest;
    if (!exact) {
      if (!existsSync(manifestPath)) {
        console.log('[native-cache] no source manifest: leaving checkout freshness unchanged');
        break;
      }
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const identity = cacheIdentity();
      if (manifest.configuration !== identity.configuration || manifest.lockfile !== identity.lockfile) {
        console.log('[native-cache] source manifest configuration or lockfile mismatch: leaving checkout freshness unchanged');
        break;
      }
    }
    const directories = new Set();
    const changedDirectories = new Set();
    const current = new Set(sources());
    const counts = { backdated: 0, changed: 0, new: 0, missing: 0 };
    const stamp = new Date('2000-01-01T00:00:00Z');
    for (const file of new Set([...current, ...Object.keys(manifest?.sources ?? {})])) {
      if (!current.has(file) || !existsSync(file)) {
        counts.missing++;
        continue;
      }
      const unchanged = exact || manifest.sources[file] === hash(readFileSync(file));
      if (unchanged) {
        utimesSync(file, stamp, stamp);
        counts.backdated++;
      } else counts[Object.hasOwn(manifest.sources, file) ? 'changed' : 'new']++;
      for (let dir = path.dirname(file); dir.startsWith(crate); dir = path.dirname(dir)) {
        directories.add(dir);
        if (!unchanged) changedDirectories.add(dir);
      }
    }
    for (const dir of directories) {
      if (!changedDirectories.has(dir)) utimesSync(dir, stamp, stamp);
    }
    if (exact) console.log('[native-cache] exact hit: restored source freshness for Cargo');
    else console.log(`[native-cache] prefix hit: ${Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(' ')}`);
    break;
  }
  case 'measure': {
    // Incremental objects do not help CARGO_INCREMENTAL=0. Keep .fingerprint,
    // deps, build and the ordinary app so both feature configurations survive.
    rmSync(path.join(target, 'debug/incremental'), { recursive: true, force: true });
    // Include the manifest that will actually be uploaded in the snapshot.
    mkdirSync(target, { recursive: true });
    writeFileSync(manifestPath, JSON.stringify({ ...cacheIdentity(),
      sources: Object.fromEntries(sources().map(file => [file, hash(readFileSync(file))])) }));
    function measure() {
      let total = 0;
      // Shard 1 publishes this nested check target under its own cache budget.
      const registrationBytes = existsSync(registrationTarget)
        ? Number(command('du', ['-sb', registrationTarget]).split(/\s/)[0]) : 0;
      output('registration-bytes', registrationBytes);
      for (const [label, directory] of [['target', target], ['registry', path.join(cargoHome, 'registry')],
        ['git', path.join(cargoHome, 'git')]]) {
        const bytes = (existsSync(directory) ? Number(command('du', ['-sb', directory]).split(/\s/)[0]) : 0)
          - (label === 'target' ? registrationBytes : 0);
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
        if (!['debug', 'CACHEDIR.TAG', '.rustc_info.json', 'pull-request-registration-target', '.o8-native-sources.json'].includes(entry)) {
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
