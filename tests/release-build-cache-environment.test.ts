import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const writerOptions = 'gzip:compression-level=9';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-cache-environment-'));
  roots.push(root);
  const project = join(root, 'project');
  const cache = join(root, 'cache');
  const bin = join(root, 'bin');
  mkdirSync(join(project, '.next/cache/webpack'), { recursive: true });
  mkdirSync(cache);
  mkdirSync(bin);
  writeFileSync(join(project, '.next/cache/webpack/entry.bin'), 'compiled source');
  return { root, project, cache, bin };
}

describe('release cache archive environment', { timeout: 120_000 }, () => {
  it.skipIf(process.platform !== 'darwin')('reproduces the updater option failure with actual macOS tar', () => {
    const { root, project } = fixture();
    const child = spawnSync('/usr/bin/tar', ['-cf', join(root, 'raw.tar'), '-C', project, '.next/cache'], {
      env: { ...process.env, TAR_WRITER_OPTIONS: writerOptions },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).not.toBe(0);
    expect(child.stderr).toMatch(/Unknown module name: .*gzip/);
  });

  it('captures and restores through real processes without changing the caller updater options', () => {
    const { root, project, cache, bin } = fixture();
    const trace = join(root, 'tar.jsonl');
    const wrapper = join(bin, 'tar');
    writeFileSync(wrapper, `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ args,
  writer: process.env.TAR_WRITER_OPTIONS ?? null,
  credentials: [process.env.OPENAI_API_KEY, process.env.APPLE_ID_PASSWORD, process.env.O8_MASTER_KEY, process.env.O8_CHILD_CREDENTIAL_POLICY, process.env.NODE_OPTIONS].map(value => value ?? null),
  marker: process.env.O8_CACHE_TEST_MARKER ?? null }) + '\\n');
const child = cp.spawnSync('/usr/bin/tar', args, { stdio: 'inherit' });
process.exit(child.status ?? 1);
`);
    chmodSync(wrapper, 0o700);
    const moduleUrl = new URL('../scripts/lib/release-build-cache.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { captureReleaseBuildCache, restoreReleaseBuildCache } from ${JSON.stringify(moduleUrl)};
import { readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const project = ${JSON.stringify(project)};
const cacheRoot = ${JSON.stringify(cache)};
const identity = source => ({ phase: 'web', compatibility: { phase: 'web', toolchain: 'fixture' },
  compatibilitySha256: 'compatible', source: { head: source, tree: source, worktreeClean: true },
  sourceSha256: source, entrySha256: source });
const captured = await captureReleaseBuildCache(project, 'web', { cacheRoot, identity: identity('a') });
let restored, archiveHeader, contents, updater;
if (captured.status === 'captured') {
  archiveHeader = [...readFileSync(cacheRoot + '/entries/web/compatible/a.tar').subarray(0, 2)];
  rmSync(project + '/.next/cache', { recursive: true });
  restored = await restoreReleaseBuildCache(project, 'web', { cacheRoot, identity: identity('b') });
  if (restored.status === 'hit_compatible') {
    contents = readFileSync(project + '/.next/cache/webpack/entry.bin', 'utf8');
    const archive = ${JSON.stringify(join(root, 'updater.tar.gz'))};
    const result = spawnSync('/usr/bin/tar', ['-czf', archive, '-C', project, '.next/cache']);
    updater = { exit: result.status, header: result.status === 0 ? [...readFileSync(archive).subarray(0, 2)] : [] };
  }
}
console.log(JSON.stringify({ captured, restored, archiveHeader, contents, updater,
  writer: process.env.TAR_WRITER_OPTIONS }));
`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TAR_WRITER_OPTIONS: writerOptions,
        O8_CACHE_TEST_MARKER: 'preserved', OPENAI_API_KEY: 'fixture-provider-secret',
        APPLE_ID_PASSWORD: 'fixture-signing-secret', O8_MASTER_KEY: 'fixture-master-secret',
        O8_CHILD_CREDENTIAL_POLICY: undefined },
      encoding: 'utf8',
      timeout: 90_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
    expect(result.captured, JSON.stringify(result)).toMatchObject({ status: 'captured', reason: 'verified' });
    expect(result.restored).toMatchObject({ status: 'hit_compatible', reason: 'verified' });
    expect(result.contents).toBe('compiled source');
    expect(result.archiveHeader).not.toEqual([0x1f, 0x8b]);
    expect(result.writer).toBe(writerOptions);
    expect(result.updater).toEqual({ exit: 0, header: [0x1f, 0x8b] });
    const calls = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    for (const operation of ['-cf', '-xf']) {
      expect(calls.filter(call => call.args.includes(operation))).toEqual([
        expect.objectContaining({ writer: null, marker: null, credentials: [null, null, null, null, null] }),
      ]);
    }
  });
});
