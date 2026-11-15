import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureReleaseBuildCache,
  collectReleaseBuildCacheIdentity,
  finalizeReleaseBuildCacheReceipt,
  releaseBuildCacheInternals,
  resolveReleaseBuildCacheRoot,
  restoreReleaseBuildCache,
  writeReleaseBuildCachePhaseReceipt,
  type ReleaseBuildCacheIdentity,
} from '../scripts/lib/release-build-cache.mjs';

import { promoteExactChild, writeExactChildFile } from '../src/lib/workspace/exact-parent-operation';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-release-cache-repo-'));
  const cacheRoot = mkdtempSync(join(tmpdir(), 'o8-release-cache-store-'));
  roots.push(root, cacheRoot);
  mkdirSync(join(root, '.next', 'cache', 'webpack'), { recursive: true });
  writeFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'compiled-source-a');
  return { root, cacheRoot };
}

function identityFixture() {
  const { root } = fixture();
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{\n  "name": "o8",\n  "version": "0.1.0",\n  "dependencies": { "example": "1.0.0" }\n}\n');
  writeFileSync(join(root, 'package-lock.json'), '{\n  "name": "o8",\n  "version": "0.1.0",\n  "lockfileVersion": 3,\n  "packages": {\n    "": { "name": "o8", "version": "0.1.0" },\n    "node_modules/example": { "version": "1.0.0" }\n  }\n}\n');
  writeFileSync(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "o8"\nversion = "0.1.0"\n\n[dependencies]\nexample = "1.0.0"\n');
  writeFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'version = 4\n\n[[package]]\nname = "o8"\nversion = "0.1.0"\ndependencies = ["example"]\n\n[[package]]\nname = "example"\nversion = "1.0.0"\n');
  writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), '{\n  "productName": "o8",\n  "version": "0.1.0",\n  "identifier": "com.o8.app"\n}\n');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'tests@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Release Cache Tests'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root });
  return root;
}

function commitFixtureChange(root: string) {
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'change'], { cwd: root });
}

function identity(source: string): ReleaseBuildCacheIdentity {
  return {
    phase: 'web',
    compatibility: { phase: 'web', lock: 'lock-a', toolchain: 'node-a' },
    compatibilitySha256: 'compatibility-a',
    source: { head: source, tree: `tree-${source}`, worktreeClean: true },
    sourceSha256: `source-${source}`,
    entrySha256: `entry-${source}`,
  };
}

function nativeIdentity(source: string): ReleaseBuildCacheIdentity {
  return {
    ...identity(source),
    phase: 'native',
    compatibility: { phase: 'native', lock: 'cargo-lock-a', toolchain: 'rust-a' },
  };
}

describe('shared release build cache', { timeout: 120_000 }, () => {
  it('persists staging identity and completed cleanup through the real capture entry point', async () => {
    const { root, cacheRoot } = fixture();
    const captured = await captureReleaseBuildCache(root, 'web', { cacheRoot, identity: identity('a'), runId: 'staging-success' });
    expect(captured, JSON.stringify(captured)).toMatchObject({ status: 'captured' });
    const directory = join(cacheRoot, 'runs/staging-success/staging');
    const records = readdirSync(directory).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')));
    expect(records.some(record => record.state === 'bound' && record.staging.inode > 0)).toBe(true);
    expect(records.some(record => record.state === 'cleaned')).toBe(true);
    const final = await finalizeReleaseBuildCacheReceipt(cacheRoot, 'staging-success', {
      outcome: 'PASS', source: { head: 'a' }, buildDurationMs: 1,
    }, { projectRoot: root });
    expect(final.receipt.staging).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'cleaned' })]));
    expect(existsSync(directory)).toBe(false);
  });

  it('keeps a receipt for a capture with thousands of compatibility inputs and hits on the next run', async () => {
    const { root, cacheRoot } = fixture();
    const inputs = Array.from({ length: 2_500 }, (_, index) => ({
      path: `src-tauri/crates/component-${index}/src/module-${index}.rs`,
      sha256: `${index}`.padStart(64, '0'),
    }));
    const large: ReleaseBuildCacheIdentity = {
      ...identity('a'),
      compatibility: { ...identity('a').compatibility, inputs },
    };
    expect(JSON.stringify(large).length).toBeGreaterThan(128 * 1024);
    expect(await captureReleaseBuildCache(root, 'web', { cacheRoot, identity: large, runId: 'large-capture' }))
      .toMatchObject({ status: 'captured', reason: 'verified' });
    const final = await finalizeReleaseBuildCacheReceipt(cacheRoot, 'large-capture', {
      outcome: 'PASS', source: { head: 'a' }, buildDurationMs: 1,
    }, { projectRoot: root });
    expect(final.receipt.staging).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'capture', state: 'cleaned', sourceSha256: 'source-a' }),
    ]));
    expect(existsSync(final.receiptPath)).toBe(true);
    expect(existsSync(join(cacheRoot, 'runs/large-capture'))).toBe(false);

    rmSync(join(root, '.next/cache'), { recursive: true, force: true });
    expect(await restoreReleaseBuildCache(root, 'web', { cacheRoot, identity: large, runId: 'large-restore' }))
      .toMatchObject({ status: 'hit_exact', reason: 'verified' });
    const restoreReceipt = await finalizeReleaseBuildCacheReceipt(cacheRoot, 'large-restore', {
      outcome: 'PASS', source: { head: 'a' }, buildDurationMs: 1,
    }, { projectRoot: root });
    expect(restoreReceipt.receipt.staging).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'restore', state: 'cleaned' }),
    ]));
    expect(readFileSync(join(root, '.next/cache/webpack/entry.bin'), 'utf8')).toBe('compiled-source-a');
  });

  it.each([
    ['empty', '', 0],
    ['over the Linux single-argument cap', `${JSON.stringify({ inputs: 'x'.repeat(200 * 1024) })}\n`, 128 * 1024],
    ['over the macOS total argument limit', `${JSON.stringify({ inputs: 'é'.repeat(1024 * 1024) })}\n`, 2 * 1024 * 1024],
  ])('writes %s exact child file contents through stdin', async (_label, contents, floor) => {
    const { cacheRoot } = fixture();
    const parent = realpathSync(cacheRoot);
    const stat = lstatSync(parent);
    expect(Buffer.byteLength(contents)).toBeGreaterThanOrEqual(floor);
    await writeExactChildFile(parent, { canonicalPath: parent, device: stat.dev, inode: stat.ino },
      join(parent, 'written.json'), contents, 0o600);
    expect(readFileSync(join(parent, 'written.json'), 'utf8')).toBe(contents);
    expect(lstatSync(join(parent, 'written.json')).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['oversized', (record: Record<string, unknown>) => `${JSON.stringify({ ...record, padding: 'x'.repeat(200 * 1024) })}\n`, 'exceeds its bound'],
    ['corrupt', () => '{"schema":', 'JSON'],
  ])('refuses a %s staging journal record when finalizing', async (_mode, contents, message) => {
    const { root, cacheRoot } = fixture();
    await captureReleaseBuildCache(root, 'web', { cacheRoot, identity: identity('a'), runId: 'bad-journal' });
    const directory = join(cacheRoot, 'runs/bad-journal/staging');
    const [first] = readdirSync(directory).sort();
    const record = JSON.parse(readFileSync(join(directory, first), 'utf8'));
    writeFileSync(join(directory, 'zz-injected.json'), contents(record), { mode: 0o600 });
    await expect(finalizeReleaseBuildCacheReceipt(cacheRoot, 'bad-journal', {
      outcome: 'PASS', source: { head: 'a' }, buildDurationMs: 1,
    }, { projectRoot: root })).rejects.toThrow(message);
    expect(existsSync(join(directory, first))).toBe(true);
    expect(existsSync(join(cacheRoot, 'receipts/bad-journal.json'))).toBe(false);
  });

  it('retains unknown run content when completed staging is finalized', async () => {
    const { root, cacheRoot } = fixture();
    await captureReleaseBuildCache(root, 'web', { cacheRoot, identity: identity('a'), runId: 'unknown-content' });
    const run = join(cacheRoot, 'runs/unknown-content');
    mkdirSync(join(run, 'unclaimed'));
    writeFileSync(join(run, 'unclaimed/keep'), 'unclaimed bytes');
    const final = await finalizeReleaseBuildCacheReceipt(cacheRoot, 'unknown-content', {
      outcome: 'PASS', source: { head: 'a' }, buildDurationMs: 1,
    }, { projectRoot: root });
    expect(final.receipt.retention).toMatchObject({ reason: 'unknown_run_content' });
    expect(readFileSync(join(run, 'unclaimed/keep'), 'utf8')).toBe('unclaimed bytes');
    expect(existsSync(join(run, 'staging'))).toBe(true);
  });

  it('preserves an occupied restore destination instead of forcing a hit', async () => {
    const { root, cacheRoot } = fixture();
    await captureReleaseBuildCache(root, 'web', { cacheRoot, identity: identity('a') });
    writeFileSync(join(root, '.next/cache/webpack/entry.bin'), 'current consumer');
    const before = readdirSync(cacheRoot).sort();
    const runs = readdirSync(join(cacheRoot, 'runs')).sort();
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await restoreReleaseBuildCache(root, 'web', { cacheRoot, identity: identity('a') });
      expect(result.status).toBe('miss');
      expect(result.reason).toContain('occupied');
    }
    expect(readdirSync(cacheRoot).sort()).toEqual(before);
    expect(readdirSync(join(cacheRoot, 'runs')).sort()).toEqual(runs);
    expect(readFileSync(join(root, '.next/cache/webpack/entry.bin'), 'utf8')).toBe('current consumer');
  });

  it.each(['source-parent', 'destination-parent', 'source-child', 'occupied', 'symlink'])(
    'refuses %s identity changes at the exact promotion boundary', async (mode) => {
      const { root } = fixture();
      const base = realpathSync(root);
      const from = join(base, 'from');
      const to = join(base, 'to');
      mkdirSync(from); mkdirSync(to);
      const source = join(from, 'source');
      const destination = join(to, 'destination');
      mkdirSync(source);
      writeFileSync(join(source, 'original'), 'original bytes');
      const capture = (path: string) => ({ canonicalPath: path, device: lstatSync(path).dev, inode: lstatSync(path).ino });
      const parents = [capture(from), capture(to)];
      const child = capture(source);
      if (mode === 'source-parent' || mode === 'destination-parent' || mode === 'source-child') {
        const replaced = mode === 'source-parent' ? from : mode === 'destination-parent' ? to : source;
        renameSync(replaced, replaced + '.original');
        mkdirSync(replaced);
        writeFileSync(join(replaced, 'keep'), 'replacement bytes');
      } else if (mode === 'occupied') mkdirSync(destination);
      else symlinkSync(source, destination);
      await expect(promoteExactChild(parents[0], parents[1], source, destination, child, 'directory')).rejects.toThrow();
      const original = mode === 'source-parent' ? join(from + '.original', 'source/original')
        : mode === 'source-child' ? join(source + '.original', 'original') : join(source, 'original');
      expect(readFileSync(original, 'utf8')).toBe('original bytes');
      if (mode === 'occupied' || mode === 'symlink') expect(lstatSync(destination)).toBeTruthy();
    });

  it.each(['tar-failure', 'staging-replaced', 'parent-replaced', 'owner-interrupted'])(
    'retains original staging evidence after %s through actual capture and tar', async (mode) => {
      const { root, cacheRoot } = fixture();
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const runId = 'interrupted';
      const journal = join(cacheRoot, 'runs', runId, 'staging');
      const wrapper = join(bin, 'tar');
      writeFileSync(wrapper, `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
if (!args.includes('-cf')) process.exit(cp.spawnSync('/usr/bin/tar', args, { stdio: 'inherit' }).status ?? 1);
const journal = ${JSON.stringify(journal)};
const records = fs.readdirSync(journal).map(name => JSON.parse(fs.readFileSync(journal + '/' + name, 'utf8')));
const bound = records.find(row => row.state === 'populating');
if (!bound || bound.staging.inode !== fs.lstatSync(process.cwd()).ino || !bound.owner.identity.startId) process.exit(79);
const mode = ${JSON.stringify(mode)};
if (mode === 'tar-failure') process.exit(77);
if (mode === 'owner-interrupted') { process.kill(bound.owner.pid, 'SIGKILL'); process.exit(0); }
const result = cp.spawnSync('/usr/bin/tar', args, { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const replaced = mode === 'staging-replaced' ? process.cwd() : bound.destinations[0].parent.canonicalPath;
fs.renameSync(replaced, replaced + '.original');
fs.mkdirSync(replaced);
fs.writeFileSync(replaced + '/keep.txt', 'replacement must survive');
`);
      chmodSync(wrapper, 0o700);
      const script = `import { captureReleaseBuildCache } from ${JSON.stringify(new URL('../scripts/lib/release-build-cache.mjs', import.meta.url).href)};
const result = await captureReleaseBuildCache(${JSON.stringify(root)}, 'web', ${JSON.stringify({ cacheRoot, runId, identity: identity('a') })});
console.log(JSON.stringify(result));`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 90_000,
        env: { ...process.env, PATH: bin + ':' + process.env.PATH },
      });
      if (mode === 'owner-interrupted') expect(child.signal).toBe('SIGKILL');
      else {
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout.trim())).toMatchObject({ status: 'miss' });
      }
      const records = readdirSync(journal).map(name => JSON.parse(readFileSync(join(journal, name), 'utf8')));
      const bound = records.find(row => row.state === 'bound');
      expect(bound.staging.inode).toBeGreaterThan(0);
      expect(existsSync(bound.stagingPath)).toBe(true);
      if (mode === 'staging-replaced' || mode === 'parent-replaced') {
        const replaced = mode === 'staging-replaced' ? bound.stagingPath
          : join(cacheRoot, 'entries/web/compatibility-a');
        expect(readFileSync(join(replaced, 'keep.txt'), 'utf8')).toBe('replacement must survive');
        expect(existsSync(replaced + '.original')).toBe(true);
      }
      const original = readdirSync(journal).map(name => [name, readFileSync(join(journal, name), 'utf8')]);
      const final = await finalizeReleaseBuildCacheReceipt(cacheRoot, runId, {
        outcome: 'FAIL', source: { head: 'a' }, buildDurationMs: 1,
      }, { projectRoot: root });
      expect(final.receipt.staging).toEqual(expect.arrayContaining([expect.objectContaining({
        state: mode === 'owner-interrupted' ? 'populating' : 'held',
      })]));
      for (const [name, contents] of original) expect(readFileSync(join(journal, name), 'utf8')).toBe(contents);
    });

  it('rejects native output from a deleted producer checkout before replacing destination files', async () => {
    const { root: producer, cacheRoot } = fixture();
    const { root: destination } = fixture();
    const target = 'src-tauri/target/release';
    const permission = 'build/tauri-fixture/out/permissions/default.json';
    mkdirSync(join(producer, target, 'build/tauri-fixture/out/permissions'), { recursive: true });
    writeFileSync(join(producer, target, permission), '{}');
    writeFileSync(join(producer, target, 'build/tauri-fixture/output'), join(producer, target, permission));
    expect(await captureReleaseBuildCache(producer, 'native', { cacheRoot, identity: nativeIdentity('a') }))
      .toMatchObject({ status: 'captured' });
    mkdirSync(join(destination, target), { recursive: true });
    writeFileSync(join(destination, target, 'keep.bin'), 'destination output');
    rmSync(producer, { recursive: true, force: true });
    expect(await restoreReleaseBuildCache(destination, 'native', { cacheRoot, identity: nativeIdentity('b') }))
      .toMatchObject({ status: 'miss', reason: 'native_checkout_mismatch' });
    expect(readFileSync(join(destination, target, 'keep.bin'), 'utf8')).toBe('destination output');
    expect(existsSync(join(destination, target, permission))).toBe(false);
    expect(readdirSync(cacheRoot).some((name) => name.startsWith('.restore-'))).toBe(false);
  });

  it('rejects legacy native entries without checkout proof while preserving cross-checkout web reuse', async () => {
    const { root, cacheRoot } = fixture();
    const { root: destination } = fixture();
    mkdirSync(join(root, 'src-tauri/target/release'), { recursive: true });
    writeFileSync(join(root, 'src-tauri/target/release/artifact.bin'), 'native compiler output');
    await captureReleaseBuildCache(root, 'native', { cacheRoot, identity: nativeIdentity('a') });
    const manifestPath = join(cacheRoot, 'entries/native/compatibility-a/entry-a.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(JSON.stringify(manifest)).not.toContain(root);
    delete manifest.nativeCheckoutSha256;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(await restoreReleaseBuildCache(root, 'native', { cacheRoot, identity: nativeIdentity('a') }))
      .toMatchObject({ status: 'miss', reason: 'native_checkout_unverified' });
    await captureReleaseBuildCache(root, 'web', { cacheRoot, identity: identity('a') });
    rmSync(join(destination, '.next/cache'), { recursive: true, force: true });
    expect(await restoreReleaseBuildCache(destination, 'web', { cacheRoot, identity: identity('b') }))
      .toMatchObject({ status: 'hit_compatible', reason: 'verified' });
    expect(readFileSync(join(destination, '.next/cache/webpack/entry.bin'), 'utf8')).toBe('compiled-source-a');
  });

  it('uses a configured external root only while its mount marker identity matches', async () => {
    const { root } = fixture();
    const volumeRoot = mkdtempSync(join(tmpdir(), 'o8-release-cache-volume-'));
    roots.push(volumeRoot);
    const cacheRoot = join(volumeRoot, 'cache');
    const marker = join(volumeRoot, '.o8-release-cache-volume');
    const localRoot = join(root, 'local-fallback');
    const warnings: string[] = [];
    const env = {
      NODE_ENV: 'test' as const,
      O8_RELEASE_BUILD_CACHE_DIR: cacheRoot,
      O8_RELEASE_BUILD_CACHE_EXTERNAL_ROOT: volumeRoot,
      O8_RELEASE_BUILD_CACHE_VOLUME_ID: 'archive-a',
      O8_RELEASE_BUILD_CACHE_LOCAL_DIR: localRoot,
    };

    expect(resolveReleaseBuildCacheRoot(env, { warn: (line) => warnings.push(line) })).toBe(localRoot);
    expect(existsSync(cacheRoot)).toBe(false);
    expect(warnings).toHaveLength(1);

    writeFileSync(marker, 'archive-a\n');
    expect(resolveReleaseBuildCacheRoot(env)).toBe(cacheRoot);
    expect(await captureReleaseBuildCache(root, 'web', { env, identity: identity('a') }))
      .toMatchObject({ status: 'captured' });

    writeFileSync(marker, 'archive-b\n');
    expect(resolveReleaseBuildCacheRoot(env, { warn: () => {} })).toBe(localRoot);
    expect(await captureReleaseBuildCache(root, 'web', { env, identity: identity('b') }))
      .toMatchObject({ status: 'captured' });
    expect(existsSync(join(cacheRoot, 'entries', 'web', 'compatibility-a', 'entry-b.tar'))).toBe(false);
    expect(existsSync(join(localRoot, 'entries', 'web', 'compatibility-a', 'entry-b.tar'))).toBe(true);
  });

  it('rejects a symlinked external-volume marker', () => {
    const { root } = fixture();
    const volumeRoot = mkdtempSync(join(tmpdir(), 'o8-release-cache-volume-'));
    roots.push(volumeRoot);
    const identityFile = join(root, 'identity');
    writeFileSync(identityFile, 'archive-a\n');
    symlinkSync(identityFile, join(volumeRoot, '.o8-release-cache-volume'));

    expect(resolveReleaseBuildCacheRoot({
      NODE_ENV: 'test' as const,
      O8_RELEASE_BUILD_CACHE_DIR: join(volumeRoot, 'cache'),
      O8_RELEASE_BUILD_CACHE_EXTERNAL_ROOT: volumeRoot,
      O8_RELEASE_BUILD_CACHE_VOLUME_ID: 'archive-a',
      O8_RELEASE_BUILD_CACHE_LOCAL_DIR: join(root, 'fallback'),
    }, { warn: () => {} })).toBe(join(root, 'fallback'));
    expect(existsSync(join(volumeRoot, 'cache'))).toBe(false);
  });

  it('prunes oldest cache entries to a deterministic byte budget without touching receipts', async () => {
    const { root, cacheRoot } = fixture();
    const entries = join(cacheRoot, 'entries', 'web');
    const oldEntry = join(entries, 'old', 'old.tar');
    const tiedEntry = join(entries, 'tied', 'tied.tar');
    const newEntry = join(entries, 'new', 'new.tar');
    const receipt = join(cacheRoot, 'receipts', 'keep.json');
    for (const path of [oldEntry, tiedEntry, newEntry, receipt]) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, '12345');
    }
    utimesSync(oldEntry, 1, 1);
    utimesSync(tiedEntry, 2, 2);
    utimesSync(newEntry, 2, 2);

    const result = releaseBuildCacheInternals.pruneCacheToBudget(cacheRoot, 5, root);
    expect(result).toMatchObject({ removedBytes: 10, remainingBytes: 5 });
    expect(existsSync(oldEntry)).toBe(false);
    expect(existsSync(newEntry)).toBe(false);
    expect(existsSync(tiedEntry)).toBe(true);
    expect(readFileSync(receipt, 'utf8')).toBe('12345');
  });

  it('enforces the configured budget through capture', async () => {
    const { root, cacheRoot } = fixture();
    const receipt = join(cacheRoot, 'receipts', 'keep.json');
    mkdirSync(join(cacheRoot, 'receipts'), { recursive: true });
    writeFileSync(receipt, 'keep');

    expect(await captureReleaseBuildCache(root, 'web', {
      env: {
        NODE_ENV: 'test' as const,
        O8_RELEASE_BUILD_CACHE_DIR: cacheRoot,
        O8_RELEASE_BUILD_CACHE_MAX_BYTES: '0',
      },
      identity: identity('budget'),
    })).toMatchObject({ status: 'captured' });
    expect(readdirSync(join(cacheRoot, 'entries', 'web'))).toEqual([]);
    expect(readFileSync(receipt, 'utf8')).toBe('keep');
  });

  it('refuses budget pruning when entries escape the cache root through a symlink', () => {
    const { root, cacheRoot } = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'o8-release-cache-outside-'));
    roots.push(outside);
    const marker = join(outside, 'must-survive');
    writeFileSync(marker, 'safe');
    mkdirSync(join(cacheRoot, 'entries'), { recursive: true });
    symlinkSync(outside, join(cacheRoot, 'entries', 'escape'), 'dir');

    expect(() => releaseBuildCacheInternals.pruneCacheToBudget(cacheRoot, 0, root)).toThrow('symbolic link');
    expect(readFileSync(marker, 'utf8')).toBe('safe');
  });

  it('refuses budget pruning when the entries root is a symlink', () => {
    const { root, cacheRoot } = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'o8-release-cache-outside-'));
    roots.push(outside);
    const marker = join(outside, 'must-survive');
    writeFileSync(marker, 'safe');
    mkdirSync(cacheRoot, { recursive: true });
    symlinkSync(outside, join(cacheRoot, 'entries'), 'dir');

    expect(() => releaseBuildCacheInternals.pruneCacheToBudget(cacheRoot, 0, root))
      .toThrow('entries root outside the cache root');
    expect(readFileSync(marker, 'utf8')).toBe('safe');
  });

  it('hashes local production environment files without recording their values', () => {
    const { root } = fixture();
    writeFileSync(join(root, '.env.local'), 'NEXT_PUBLIC_CACHE_CANARY=secret-one\n');
    const first = releaseBuildCacheInternals.collectWebEnvironmentFiles(root);
    writeFileSync(join(root, '.env.local'), 'NEXT_PUBLIC_CACHE_CANARY=secret-two\n');
    const second = releaseBuildCacheInternals.collectWebEnvironmentFiles(root);

    expect(first.find((entry) => entry.path === '.env.local')?.sha256)
      .not.toBe(second.find((entry) => entry.path === '.env.local')?.sha256);
    expect(JSON.stringify(first)).not.toContain('secret-one');
  });

  it('changes compatibility when release options or hashed web environment change', () => {
    const root = process.cwd();
    const nativeA = collectReleaseBuildCacheIdentity(root, 'native', {
      buildOptions: { cargoTauriArgs: ['--no-bundle'] },
    });
    const nativeB = collectReleaseBuildCacheIdentity(root, 'native', {
      buildOptions: { cargoTauriArgs: ['--no-bundle', '--', '--features', 'dev-mcp-plugin'] },
    });
    expect(nativeA.compatibilitySha256).not.toBe(nativeB.compatibilitySha256);

    const webA = collectReleaseBuildCacheIdentity(root, 'web', {
      env: { ...process.env, NEXT_PUBLIC_CACHE_CANARY: 'one' },
    });
    const webB = collectReleaseBuildCacheIdentity(root, 'web', {
      env: { ...process.env, NEXT_PUBLIC_CACHE_CANARY: 'two' },
    });
    expect(webA.compatibilitySha256).not.toBe(webB.compatibilitySha256);
  });

  it('invalidates recipes when extracted staging execution changes', () => {
    const root = identityFixture();
    const helper = join(root, 'scripts/lib/release-build-cache-staging.mjs');
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    writeFileSync(helper, 'export const protocol = 1;');
    const before = collectReleaseBuildCacheIdentity(root, 'web');
    writeFileSync(helper, 'export const protocol = 2;');
    const after = collectReleaseBuildCacheIdentity(root, 'web');
    expect(after.compatibilitySha256).not.toBe(before.compatibilitySha256);
  });

  it('keeps compatibility across synchronized o8 version changes while source identity changes', () => {
    const root = identityFixture();
    const webBefore = collectReleaseBuildCacheIdentity(root, 'web');
    const nativeBefore = collectReleaseBuildCacheIdentity(root, 'native');

    for (const path of ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json']) {
      const absolute = join(root, path);
      writeFileSync(absolute, readFileSync(absolute, 'utf8').replaceAll('0.1.0', '0.1.1'));
    }
    commitFixtureChange(root);

    const webAfter = collectReleaseBuildCacheIdentity(root, 'web');
    const nativeAfter = collectReleaseBuildCacheIdentity(root, 'native');
    expect(webAfter.compatibilitySha256).toBe(webBefore.compatibilitySha256);
    expect(nativeAfter.compatibilitySha256).toBe(nativeBefore.compatibilitySha256);
    expect(webAfter.sourceSha256).not.toBe(webBefore.sourceSha256);
    expect(nativeAfter.sourceSha256).not.toBe(nativeBefore.sourceSha256);
    expect(webAfter.entrySha256).not.toBe(webBefore.entrySha256);
    expect(nativeAfter.entrySha256).not.toBe(nativeBefore.entrySha256);
  });

  it('changes native compatibility when a Cargo.lock dependency version changes', () => {
    const root = identityFixture();
    const before = collectReleaseBuildCacheIdentity(root, 'native');
    const cargoLock = join(root, 'src-tauri', 'Cargo.lock');
    writeFileSync(cargoLock, readFileSync(cargoLock, 'utf8').replace('name = "example"\nversion = "1.0.0"', 'name = "example"\nversion = "2.0.0"'));
    commitFixtureChange(root);

    expect(collectReleaseBuildCacheIdentity(root, 'native').compatibilitySha256)
      .not.toBe(before.compatibilitySha256);
  });

  it('changes compatibility when non-version manifest data or Cargo features change', () => {
    const manifestRoot = identityFixture();
    const manifestBefore = collectReleaseBuildCacheIdentity(manifestRoot, 'native');
    const tauriConfig = join(manifestRoot, 'src-tauri', 'tauri.conf.json');
    writeFileSync(tauriConfig, readFileSync(tauriConfig, 'utf8').replace('com.o8.app', 'com.o8.changed'));
    commitFixtureChange(manifestRoot);
    expect(collectReleaseBuildCacheIdentity(manifestRoot, 'native').compatibilitySha256)
      .not.toBe(manifestBefore.compatibilitySha256);

    const featureRoot = identityFixture();
    const featureBefore = collectReleaseBuildCacheIdentity(featureRoot, 'native');
    const cargoToml = join(featureRoot, 'src-tauri', 'Cargo.toml');
    writeFileSync(cargoToml, `${readFileSync(cargoToml, 'utf8')}\n[features]\ncache-test = []\n`);
    commitFixtureChange(featureRoot);
    expect(collectReleaseBuildCacheIdentity(featureRoot, 'native').compatibilitySha256)
      .not.toBe(featureBefore.compatibilitySha256);
  });

  it('restores a compatible entry across changed source and finalizes generated runs', async () => {
    const { root, cacheRoot } = fixture();
    const captured = await captureReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('a'),
      buildDurationMs: 42_000,
    });
    expect(captured).toMatchObject({ status: 'captured', reason: 'verified' });

    rmSync(join(root, '.next/cache'), { recursive: true, force: true });
    const restored = await restoreReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('b'),
    });
    expect(readdirSync(join(cacheRoot, 'runs'))).toEqual([]);
    expect(readdirSync(join(cacheRoot, 'receipts'))).toHaveLength(2);
    expect(restored).toMatchObject({
      status: 'hit_compatible',
      reason: 'verified',
      producerSourceSha256: 'source-a',
      estimatedSavedMs: 42_000,
    });
    expect(readFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'utf8'))
      .toBe('compiled-source-a');
  });

  it('restores and prunes normal compiler output without touching project node_modules', async () => {
    const { root, cacheRoot } = fixture();
    const nativeModuleRoot = join(root, 'node_modules', 'better-sqlite3');
    const nativeModuleMarker = join(nativeModuleRoot, 'binding.node');
    mkdirSync(nativeModuleRoot, { recursive: true });
    writeFileSync(nativeModuleMarker, 'must-survive');

    expect(await captureReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('a'),
    })).toMatchObject({ status: 'captured' });
    writeFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'compiled-source-b');
    expect(await captureReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('b'),
    })).toMatchObject({ status: 'captured' });

    const entryDirectory = join(cacheRoot, 'entries', 'web', 'compatibility-a');
    expect(readdirSync(entryDirectory).sort()).toEqual(['entry-b.json', 'entry-b.tar']);
    rmSync(join(root, '.next/cache'), { recursive: true, force: true });
    expect(await restoreReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('c'),
    })).toMatchObject({ status: 'hit_compatible', producerSourceSha256: 'source-b' });
    expect(readFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'utf8'))
      .toBe('compiled-source-b');
    expect(readFileSync(nativeModuleMarker, 'utf8')).toBe('must-survive');
  });

  it('refuses cache mutations inside project node_modules without removing anything', async () => {
    const { root } = fixture();
    const nativeModuleRoot = join(root, 'node_modules', 'better-sqlite3');
    const nativeModuleMarker = join(nativeModuleRoot, 'binding.node');
    const unsafeCacheRoot = join(nativeModuleRoot, 'release-cache');
    mkdirSync(nativeModuleRoot, { recursive: true });
    writeFileSync(nativeModuleMarker, 'must-survive');

    await expect(captureReleaseBuildCache(root, 'web', {
      cacheRoot: unsafeCacheRoot,
      identity: identity('a'),
    })).rejects.toThrow(join(root, 'node_modules', 'better-sqlite3'));
    expect(readFileSync(nativeModuleMarker, 'utf8')).toBe('must-survive');
    expect(existsSync(unsafeCacheRoot)).toBe(false);
  });

  it('refuses a restore destination redirected into project node_modules', async () => {
    const { root, cacheRoot } = fixture();
    expect(await captureReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('a'),
    })).toMatchObject({ status: 'captured' });

    rmSync(join(root, '.next'), { recursive: true, force: true });
    const redirectedDestination = join(root, 'node_modules', 'cache');
    mkdirSync(redirectedDestination, { recursive: true });
    const destinationMarker = join(redirectedDestination, 'must-survive.txt');
    writeFileSync(destinationMarker, 'must-survive');
    symlinkSync(join(root, 'node_modules'), join(root, '.next'), 'dir');

    await expect(restoreReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('b'),
    })).rejects.toThrow(join(root, '.next', 'cache'));
    expect(readFileSync(destinationMarker, 'utf8')).toBe('must-survive');
  });

  it('refuses project node_modules symlinked outside the checkout', async () => {
    const { root } = fixture();
    const externalNodeModules = mkdtempSync(join(tmpdir(), 'o8-release-cache-node-modules-'));
    roots.push(externalNodeModules);
    const nativeModuleRoot = join(externalNodeModules, 'better-sqlite3');
    const nativeModuleMarker = join(nativeModuleRoot, 'binding.node');
    mkdirSync(nativeModuleRoot, { recursive: true });
    writeFileSync(nativeModuleMarker, 'must-survive');
    symlinkSync(externalNodeModules, join(root, 'node_modules'), 'dir');

    await expect(captureReleaseBuildCache(root, 'web', {
      cacheRoot: join(root, 'node_modules', 'better-sqlite3', 'release-cache'),
      identity: identity('a'),
    })).rejects.toThrow(join(root, 'node_modules', 'better-sqlite3'));
    expect(readFileSync(nativeModuleMarker, 'utf8')).toBe('must-survive');
  });

  it('rejects a corrupt cache without touching the cold-build destination', async () => {
    const { root, cacheRoot } = fixture();
    await captureReleaseBuildCache(root, 'web', { cacheRoot, identity: identity('a') });
    const entryDir = join(cacheRoot, 'entries', 'web', 'compatibility-a');
    const archive = readdirSync(entryDir).find((name) => name.endsWith('.tar'));
    if (!archive) throw new Error('expected captured archive');
    writeFileSync(join(entryDir, archive), 'corrupt');
    writeFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'cold-destination-preserved');

    const restored = await restoreReleaseBuildCache(root, 'web', {
      cacheRoot,
      identity: identity('b'),
    });
    expect(restored).toMatchObject({ status: 'miss', reason: 'archive_size_mismatch' });
    expect(readFileSync(join(root, '.next', 'cache', 'webpack', 'entry.bin'), 'utf8'))
      .toBe('cold-destination-preserved');
  });

  it('never restores native bundles or exported server output as compiler cache', async () => {
    const { root, cacheRoot } = fixture();
    mkdirSync(join(root, 'src-tauri', 'target', 'release', 'deps'), { recursive: true });
    mkdirSync(join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos'), { recursive: true });
    mkdirSync(join(root, 'src-tauri', 'target', 'release', 'server'), { recursive: true });
    writeFileSync(join(root, 'src-tauri', 'target', 'release', 'deps', 'compiled.rlib'), 'compiler-intermediate');
    writeFileSync(join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'signed-app'), 'final-bundle');
    writeFileSync(join(root, 'src-tauri', 'target', 'release', 'server', 'server.js'), 'exported-server');

    expect(await captureReleaseBuildCache(root, 'native', {
      cacheRoot,
      identity: nativeIdentity('a'),
    })).toMatchObject({ status: 'captured' });
    rmSync(join(root, 'src-tauri', 'target', 'release'), { recursive: true, force: true });
    expect(await restoreReleaseBuildCache(root, 'native', {
      cacheRoot,
      identity: nativeIdentity('b'),
    })).toMatchObject({ status: 'hit_compatible' });

    expect(readFileSync(join(root, 'src-tauri', 'target', 'release', 'deps', 'compiled.rlib'), 'utf8'))
      .toBe('compiler-intermediate');
    expect(() => readFileSync(join(root, 'src-tauri', 'target', 'release', 'bundle', 'macos', 'signed-app')))
      .toThrow();
    expect(() => readFileSync(join(root, 'src-tauri', 'target', 'release', 'server', 'server.js')))
      .toThrow();
  });

  it('caches both native slices for a universal Tauri target without caching release bundles', async () => {
    const { root, cacheRoot } = fixture();
    const buildOptions = {
      cargoTauriArgs: ['--target', 'universal-apple-darwin', '--', '--features', 'dev-mcp-plugin'],
    };
    const triples = ['x86_64-apple-darwin', 'aarch64-apple-darwin', 'universal-apple-darwin'];
    for (const triple of triples) {
      const release = join(root, 'src-tauri', 'target', triple, 'release');
      mkdirSync(join(release, 'deps'), { recursive: true });
      mkdirSync(join(release, 'bundle', 'macos'), { recursive: true });
      writeFileSync(join(release, 'deps', `${triple}.rlib`), `compiler-${triple}`);
      writeFileSync(join(release, 'bundle', 'macos', 'o8.app'), `bundle-${triple}`);
    }

    expect(await captureReleaseBuildCache(root, 'native', {
      cacheRoot,
      identity: nativeIdentity('universal-a'),
      buildOptions,
    })).toMatchObject({ status: 'captured' });
    for (const triple of triples) {
      rmSync(join(root, 'src-tauri', 'target', triple), { recursive: true, force: true });
    }
    expect(await restoreReleaseBuildCache(root, 'native', {
      cacheRoot,
      identity: nativeIdentity('universal-b'),
      buildOptions,
    })).toMatchObject({ status: 'hit_compatible' });

    for (const triple of triples) {
      const release = join(root, 'src-tauri', 'target', triple, 'release');
      expect(readFileSync(join(release, 'deps', `${triple}.rlib`), 'utf8')).toBe(`compiler-${triple}`);
      expect(existsSync(join(release, 'bundle'))).toBe(false);
    }
  });

  it('ignores AppleDouble metadata when finalizing aggregate release cache receipts', async () => {
    const { root, cacheRoot } = fixture();
    const runId = 'run-appledouble';

    writeReleaseBuildCachePhaseReceipt(cacheRoot, runId, {
      phase: 'web',
      restore: {
        phase: 'web',
        status: 'hit_exact',
        reason: 'verified',
        archiveBytes: 1024,
        estimatedSavedMs: 10_000,
        durationMs: 5,
      },
      buildDurationMs: 50,
    });
    writeReleaseBuildCachePhaseReceipt(cacheRoot, runId, {
      phase: 'speech',
      restore: {
        phase: 'speech',
        status: 'miss',
        reason: 'entry_missing',
        durationMs: 3,
      },
      buildDurationMs: 75,
    });
    writeReleaseBuildCachePhaseReceipt(cacheRoot, runId, {
      phase: 'native',
      restore: {
        phase: 'native',
        status: 'hit_compatible',
        reason: 'verified',
        archiveBytes: 2048,
        estimatedSavedMs: 20_000,
        durationMs: 8,
      },
      buildDurationMs: 100,
    });

    const runDir = join(cacheRoot, 'runs', runId);
    writeFileSync(
      join(runDir, '._native.json'),
      Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00, 0xff, 0xfe]),
    );
    writeFileSync(
      join(runDir, '._web.json'),
      Buffer.from([0x00, 0x05, 0x16, 0x07, 0x62, 0x61, 0x64]),
    );
    writeFileSync(
      join(runDir, 'noise.json'),
      '{"phase":"noise","restore":{"status":"hit_exact","archiveBytes":999,"estimatedSavedMs":1}}\n',
    );

    expect(releaseBuildCacheInternals.isReleaseBuildCachePhaseReceiptName('native.json')).toBe(true);
    expect(releaseBuildCacheInternals.isReleaseBuildCachePhaseReceiptName('._native.json')).toBe(false);
    expect(releaseBuildCacheInternals.isReleaseBuildCacheJsonCandidate('entry-a.json')).toBe(true);
    expect(releaseBuildCacheInternals.isReleaseBuildCacheJsonCandidate('._entry-a.json')).toBe(false);

    const finalized = await finalizeReleaseBuildCacheReceipt(
      cacheRoot,
      runId,
      {
        outcome: 'PASS',
        source: { head: 'head-appledouble' },
        buildDurationMs: 225,
      },
      { projectRoot: root },
    );

    expect(finalized.receipt.phases).toEqual(expect.objectContaining({
      web: expect.objectContaining({ phase: 'web' }),
      speech: expect.objectContaining({ phase: 'speech' }),
      native: expect.objectContaining({ phase: 'native' }),
    }));
    expect(finalized.receipt.phases).not.toHaveProperty('noise');
    expect(finalized.receipt.totals).toEqual({
      archiveBytesRestored: 3072,
      estimatedSavedMs: 30_000,
      hits: 2,
      misses: 1,
    });
    expect(JSON.stringify(finalized.receipt)).not.toContain('noise');
    expect(existsSync(runDir)).toBe(true);
    expect(finalized.receipt.retention).toMatchObject({ reason: 'unknown_run_content', entryCount: 3 });
  });

  it('bypasses dirty source and records phase totals without local paths', async () => {
    const { root, cacheRoot } = fixture();
    const dirty = identity('dirty');
    dirty.source.worktreeClean = false;
    expect(await restoreReleaseBuildCache(root, 'web', { cacheRoot, identity: dirty }))
      .toMatchObject({ status: 'bypass', reason: 'dirty_worktree' });
    expect(await captureReleaseBuildCache(root, 'web', { cacheRoot, identity: dirty }))
      .toMatchObject({ status: 'bypass', reason: 'dirty_worktree' });

    writeReleaseBuildCachePhaseReceipt(cacheRoot, 'run-a', {
      phase: 'web',
      restore: {
        phase: 'web',
        status: 'hit_compatible',
        reason: 'verified',
        archiveBytes: 4096,
        estimatedSavedMs: 42_000,
        durationMs: 20,
      },
      buildDurationMs: 100,
    });
    const finalized = await finalizeReleaseBuildCacheReceipt(cacheRoot, 'run-a', {
      outcome: 'PASS',
      source: { head: 'head-b' },
      buildDurationMs: 200,
    });
    expect(finalized.receipt).toMatchObject({
      schema: 'o8/release-build-cache-receipt/v1',
      totals: { archiveBytesRestored: 4096, estimatedSavedMs: 42_000, hits: 1, misses: 0 },
    });
    expect(JSON.stringify(finalized.receipt)).not.toContain(root);
    expect(JSON.stringify(finalized.receipt)).not.toContain(cacheRoot);
  });
});
