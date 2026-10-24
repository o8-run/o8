import { execFile } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupPostshipOutputs,
  POSTSHIP_GENERATED_DIRS,
  POSTSHIP_PRESERVED_DIRS,
} from '../scripts/postship-cleanup.mjs';
import {
  verifyReleaseArtifactManifest,
  writeReleaseArtifactManifest,
} from '../scripts/lib/release-artifacts.mjs';

const nativeDirs = POSTSHIP_GENERATED_DIRS.filter(candidate => candidate !== '.next');
const cleanupRoots: string[] = [];
const runFile = promisify(execFile);
const cleanupScript = fileURLToPath(new URL('../scripts/postship-cleanup.mjs', import.meta.url));

async function makeRepoRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'o8-postship-cleanup-'));
  cleanupRoots.push(root);
  await writeFile(path.join(root, 'package.json'), '{"name":"o8"}\n', 'utf8');
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeSymbolFixture() {
  const root = await makeRepoRoot();
  const symbols = await makeRepoRoot();
  const tools = path.join(root, 'tools');
  await mkdir(tools);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'o8', version: '0.1.999' }));
  await writeFile(path.join(tools, 'dwarfdump'), `#!/usr/bin/env node
const fs = require('node:fs');
const p = process.argv.at(-1);
const data = JSON.parse(fs.readFileSync(fs.statSync(p).isDirectory() ? p + '/Contents/Resources/DWARF/o8' : p));
for (const entry of Array.isArray(data) ? data : [data]) console.log('UUID: ' + entry.uuid + ' (' + entry.cpu + ') ' + p);
`, { mode: 0o700 });
  const fixtures = [
    ['aarch64-apple-darwin', 'arm64', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'],
    ['x86_64-apple-darwin', 'x86_64', 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB'],
  ];
  async function restore() {
    for (const [triple, cpu, uuid] of fixtures) {
      const release = path.join(root, 'src-tauri/target', triple, 'release');
      const dwarf = path.join(release, 'deps/symbols.dSYM/Contents/Resources/DWARF');
      await mkdir(dwarf, { recursive: true });
      const contents = JSON.stringify({ uuid, cpu, symbols: `private source lines for ${cpu}` });
      await writeFile(path.join(dwarf, 'o8'), contents);
      await symlink('deps/symbols.dSYM', path.join(release, 'o8.dSYM'));
      await writeFile(path.join(release, 'o8'), contents);
    }
    const universal = path.join(root, 'src-tauri/target/universal-apple-darwin/release');
    await mkdir(universal, { recursive: true });
    await writeFile(path.join(universal, 'o8'), JSON.stringify(fixtures.map(([, cpu, uuid]) => ({ cpu, uuid }))));
  }
  await restore();
  const env = { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH}`, O8_RELEASE_SYMBOLS_DIR: symbols };
  return { root, symbols, fixtures, env, restore };
}

async function retainedDwarf(symbols: string, cpu: string, uuid: string) {
  const directory = path.join(symbols, '0.1.999', cpu, uuid);
  const [digest] = await readdir(directory);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  return path.join(directory, digest, 'o8.dSYM/Contents/Resources/DWARF/o8');
}

describe('postship generated-output cleanup', () => {
  it('retains both CPU dSYMs privately through the cleanup CLI before deleting the build tree', async () => {
    const { root, symbols, fixtures, env } = await makeSymbolFixture();
    const { stdout } = await runFile(process.execPath, [cleanupScript], { cwd: root, env });
    expect(stdout).toContain('refused=0');
    await expect(lstat(path.join(root, 'src-tauri/target'))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const [, cpu, uuid] of fixtures) {
      const retained = await retainedDwarf(symbols, cpu, uuid);
      expect(JSON.parse(await readFile(retained, 'utf8'))).toMatchObject({ cpu, uuid });
      expect((await lstat(retained)).mode & 0o777).toBe(0o600);
    }
    expect((await lstat(symbols)).mode & 0o777).toBe(0o700);
    await runFile(process.execPath, [cleanupScript], { cwd: root, env });
    for (const [, cpu, uuid] of fixtures) {
      await expect(readFile(await retainedDwarf(symbols, cpu, uuid))).resolves.toBeDefined();
    }
  });

  it.each(['file', 'inside-checkout', 'symlink', 'filesystem-root'])('preserves the last build symbols when the retention root is %s', async (kind) => {
    const f = await makeSymbolFixture();
    let destination = path.join(f.symbols, 'not-a-directory');
    if (kind === 'filesystem-root') destination = path.parse(f.root).root;
    if (kind === 'file') await writeFile(destination, 'held');
    if (kind === 'inside-checkout') destination = path.join(f.root, 'src-tauri/target/symbols');
    if (kind === 'symlink') await symlink(f.symbols, destination);
    const { stdout } = await runFile(process.execPath, [cleanupScript, '--best-effort'], {
      cwd: f.root, env: { ...f.env, O8_RELEASE_SYMBOLS_DIR: destination },
    });
    expect(stdout).toContain('refused=1');
    for (const [triple, cpu] of f.fixtures) {
      const original = path.join(f.root, 'src-tauri/target', triple, 'release/o8.dSYM/Contents/Resources/DWARF/o8');
      expect(JSON.parse(await readFile(original, 'utf8'))).toMatchObject({ cpu });
    }
  });

  it('preserves build symbols if an existing retained copy is corrupt instead of overwriting it', async () => {
    const f = await makeSymbolFixture();
    await runFile(process.execPath, [cleanupScript], { cwd: f.root, env: f.env });
    const retained = await retainedDwarf(f.symbols, f.fixtures[0][1], f.fixtures[0][2]);
    await writeFile(retained, 'corrupt retained artifact');
    await f.restore();
    const { stdout } = await runFile(process.execPath, [cleanupScript, '--best-effort'], { cwd: f.root, env: f.env });
    expect(stdout).toContain('refused=1');
    expect(await readFile(retained, 'utf8')).toBe('corrupt retained artifact');
    expect(JSON.parse(await readFile(path.join(f.root, 'src-tauri/target/aarch64-apple-darwin/release/o8.dSYM/Contents/Resources/DWARF/o8'), 'utf8'))).toMatchObject({ cpu: 'arm64' });
  });

  it('keeps mismatched executable and symbol UUIDs for recovery', async () => {
    const f = await makeSymbolFixture();
    await writeFile(path.join(f.root, 'src-tauri/target/aarch64-apple-darwin/release/o8'), JSON.stringify({ cpu: 'arm64', uuid: f.fixtures[1][2] }));
    const { stdout } = await runFile(process.execPath, [cleanupScript, '--best-effort'], { cwd: f.root, env: f.env });
    expect(stdout).toContain('refused=1');
    await expect(lstat(path.join(f.root, 'src-tauri/target/aarch64-apple-darwin/release/o8.dSYM'))).resolves.toBeDefined();
  });

  it('preserves unknown web output instead of inventing successful lifecycle ownership', async () => {
    const root = await makeRepoRoot();
    await mkdir(path.join(root, '.next'));
    await writeFile(path.join(root, '.next', 'unknown'), 'preserve');
    expect((await cleanupPostshipOutputs(root)).refused).toEqual([
      { path: '.next', reason: 'Postship output has unknown lifecycle ownership.' },
    ]);
    expect(await readFile(path.join(root, '.next', 'unknown'), 'utf8')).toBe('preserve');
  });
  it('removes only the exact generated release directories', async () => {
    const root = await makeRepoRoot();
    for (const relativePath of nativeDirs) {
      await mkdir(path.join(root, relativePath), { recursive: true });
      await writeFile(path.join(root, relativePath, 'generated.bin'), 'generated', 'utf8');
    }
    for (const relativePath of POSTSHIP_PRESERVED_DIRS) {
      await mkdir(path.join(root, relativePath), { recursive: true });
      await writeFile(path.join(root, relativePath, 'verified.bin'), 'verified', 'utf8');
    }
    await mkdir(path.join(root, 'src-tauri', 'keep-me'), { recursive: true });
    await writeFile(path.join(root, 'src-tauri', 'keep-me', 'source.txt'), 'keep', 'utf8');

    const result = await cleanupPostshipOutputs(root);

    expect(result).toEqual({ removed: nativeDirs, skipped: ['.next'], refused: [] });
    for (const relativePath of POSTSHIP_PRESERVED_DIRS) {
      await expect(readFile(path.join(root, relativePath, 'verified.bin'), 'utf8')).resolves.toBe('verified');
    }
    await expect(readFile(path.join(root, 'src-tauri', 'keep-me', 'source.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('keeps the verified release artifact reusable after cleanup', async () => {
    const root = await makeRepoRoot();
    for (const relativePath of nativeDirs) {
      await mkdir(path.join(root, relativePath), { recursive: true });
      await writeFile(path.join(root, relativePath, 'generated.bin'), 'generated', 'utf8');
    }
    await mkdir(path.join(root, 'out', 'frontend'), { recursive: true });
    await mkdir(path.join(root, 'src-tauri', 'helpers'), { recursive: true });
    await writeFile(path.join(root, 'out', 'frontend', 'index.html'), '<h1>verified</h1>', 'utf8');
    for (const name of [
      'speech-local',
      'speech-local-aarch64-apple-darwin',
      'speech-local-x86_64-apple-darwin',
    ]) {
      await writeFile(path.join(root, 'src-tauri', 'helpers', name), `binary-${name}`, 'utf8');
    }
    const recipe = { recipeSha256: 'recipe-a', head: 'head-a', version: '0.1.999' };
    writeReleaseArtifactManifest(root, recipe);
    await symlink('../../out/frontend', path.join(root, 'src-tauri/target', 'release-assets'));

    const result = await cleanupPostshipOutputs(root);

    expect(result).toEqual({ removed: nativeDirs, skipped: ['.next'], refused: [] });
    expect(verifyReleaseArtifactManifest(root, recipe)).toMatchObject({ reusable: true });
  });

  it.each(nativeDirs)('cleans internal links in %s and preserves donors on repeated cleanup', async (relativePath) => {
    const root = await makeRepoRoot();
    const donor = path.join(root, 'node_modules', 'dependency');
    const generated = path.join(root, relativePath);
    const dev = path.join(generated, 'dev');
    await mkdir(donor, { recursive: true });
    await writeFile(path.join(donor, 'valuable.txt'), 'dependency bytes', 'utf8');
    // Traversing the donor would encounter this external link and refuse cleanup.
    await symlink(tmpdir(), path.join(donor, 'external-link'));
    await mkdir(dev, { recursive: true });
    await symlink(path.relative(dev, donor), path.join(dev, 'relative-directory'));
    await symlink(donor, path.join(dev, 'absolute-directory'));
    await symlink(path.join(donor, 'valuable.txt'), path.join(dev, 'absolute-file'));
    await symlink('relative-directory', path.join(dev, 'internal-chain'));
    await symlink('relative-directory/../dependency/valuable.txt', path.join(dev, 'internal-parent'));

    expect(await cleanupPostshipOutputs(root)).toEqual({
      removed: [relativePath],
      skipped: POSTSHIP_GENERATED_DIRS.filter((candidate) => candidate !== relativePath),
      refused: [],
    });
    await expect(lstat(generated)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await cleanupPostshipOutputs(root)).toEqual({ removed: [], skipped: POSTSHIP_GENERATED_DIRS, refused: [] });
    await expect(readFile(path.join(donor, 'valuable.txt'), 'utf8')).resolves.toBe('dependency bytes');
    expect((await lstat(path.join(donor, 'external-link'))).isSymbolicLink()).toBe(true);
  });

  it('cleans internal links through the production CLI', async () => {
    const root = await makeRepoRoot();
    await mkdir(path.join(root, 'out'));
    await writeFile(path.join(root, 'out', 'valuable.txt'), 'release bytes', 'utf8');
    await mkdir(path.join(root, 'src-tauri/target', 'dev'), { recursive: true });
    await symlink('../../../out', path.join(root, 'src-tauri/target', 'dev', 'release-assets'));

    const { stdout } = await runFile(process.execPath, [cleanupScript, '--best-effort'], { cwd: root });

    expect(stdout).toContain(`removed=1 skipped=${POSTSHIP_GENERATED_DIRS.length - 1} refused=0`);
    await expect(lstat(path.join(root, 'src-tauri/target'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(root, 'out', 'valuable.txt'), 'utf8')).resolves.toBe('release bytes');
  });

  it('refuses a top-level generated link even when its destination is internal', async () => {
    const root = await makeRepoRoot();
    await mkdir(path.join(root, 'donor'));
    await writeFile(path.join(root, 'donor', 'valuable.txt'), 'keep', 'utf8');
    await symlink('donor', path.join(root, '.next'));

    expect((await cleanupPostshipOutputs(root)).refused).toEqual([
      { path: '.next', reason: 'Postship output has unknown lifecycle ownership.' },
    ]);
    expect((await lstat(path.join(root, '.next'))).isSymbolicLink()).toBe(true);
    await expect(readFile(path.join(root, 'donor', 'valuable.txt'), 'utf8')).resolves.toBe('keep');
  });

  it.each(['missing', 'cycle', 'not-directory'])('refuses an uncertain %s nested link before removing entries', async (kind) => {
    const root = await makeRepoRoot();
    const dev = path.join(root, 'src-tauri/target', 'dev');
    await mkdir(dev, { recursive: true });
    await writeFile(path.join(dev, 'generated.txt'), 'keep on refusal', 'utf8');
    await writeFile(path.join(root, 'donor.txt'), 'keep donor', 'utf8');
    const destination = kind === 'missing' ? '../../absent' : kind === 'cycle' ? 'uncertain' : '../../donor.txt/child';
    await symlink(destination, path.join(dev, 'uncertain'));

    const result = await cleanupPostshipOutputs(root);

    expect(result.removed).toEqual([]);
    expect(result.refused).toEqual([{ path: 'src-tauri/target', reason: expect.stringContaining('linked entry inside src-tauri/target: dev/uncertain') }]);
    await expect(readFile(path.join(dev, 'generated.txt'), 'utf8')).resolves.toBe('keep on refusal');
    await expect(readFile(path.join(root, 'donor.txt'), 'utf8')).resolves.toBe('keep donor');
    expect((await lstat(path.join(dev, 'uncertain'))).isSymbolicLink()).toBe(true);
  });

  it.each(['absolute', 'relative', 'external-return', 'external-parent'])('refuses %s paths that escape the checkout', async (kind) => {
    const root = await makeRepoRoot();
    const external = await makeRepoRoot();
    const dev = path.join(root, 'src-tauri/target', 'dev');
    const donor = path.join(root, 'donor');
    await mkdir(dev, { recursive: true });
    await mkdir(donor);
    await writeFile(path.join(dev, 'generated.txt'), 'keep generated', 'utf8');
    await writeFile(path.join(donor, 'valuable.txt'), 'keep donor', 'utf8');
    await writeFile(path.join(external, 'valuable.txt'), 'keep external', 'utf8');
    await symlink(donor, path.join(external, 'return'));
    await symlink(external, path.join(root, 'external-ancestor'));
    const destinations: Record<string, string> = {
      absolute: external,
      relative: path.relative(dev, external),
      'external-return': path.join(root, 'external-ancestor', 'return'),
      'external-parent': `${root}/external-ancestor/../${path.basename(root)}/donor`,
    };
    await symlink(destinations[kind], path.join(dev, 'unsafe'));
    if (kind.startsWith('external-')) {
      // These resolve back inside; checking only the final realpath is unsafe.
      expect(await realpath(path.join(dev, 'unsafe'))).toBe(await realpath(donor));
    }

    const result = await cleanupPostshipOutputs(root);

    expect(result.removed).toEqual([]);
    expect(result.refused).toEqual([{ path: 'src-tauri/target', reason: expect.stringContaining('linked entry inside src-tauri/target: dev/unsafe') }]);
    await expect(readFile(path.join(dev, 'generated.txt'), 'utf8')).resolves.toBe('keep generated');
    await expect(readFile(path.join(donor, 'valuable.txt'), 'utf8')).resolves.toBe('keep donor');
    await expect(readFile(path.join(external, 'valuable.txt'), 'utf8')).resolves.toBe('keep external');
  });

  it.each([
    ['src-tauri', 'external'],
    ['src-tauri/sidecars', 'external'],
    ['src-tauri/sidecars/speech-local', 'external'],
    ['src-tauri', 'internal'],
    ['src-tauri/sidecars', 'internal'],
    ['src-tauri/sidecars/speech-local', 'internal'],
  ])('refuses the %s linked ancestor pointing %s', async (ancestor, location) => {
    const root = await makeRepoRoot();
    const destination = location === 'external' ? await makeRepoRoot() : path.join(root, 'donor');
    await mkdir(destination, { recursive: true });
    const relativeTarget = ancestor === 'src-tauri' ? 'src-tauri/target' : 'src-tauri/sidecars/speech-local/.build';
    const suffix = path.relative(ancestor, relativeTarget);
    const generated = path.join(destination, suffix);
    await mkdir(generated, { recursive: true });
    await writeFile(path.join(generated, 'valuable.txt'), 'keep', 'utf8');
    await mkdir(path.dirname(path.join(root, ancestor)), { recursive: true });
    await symlink(destination, path.join(root, ancestor));

    const result = await cleanupPostshipOutputs(root);

    expect(result.refused).toEqual([{ path: relativeTarget, reason: `linked ancestor: ${ancestor}` }]);
    await expect(readFile(path.join(generated, 'valuable.txt'), 'utf8')).resolves.toBe('keep');
    expect((await lstat(path.join(root, ancestor))).isSymbolicLink()).toBe(true);
  });

  it('refuses a generated-directory symlink without touching its destination', async () => {
    const root = await makeRepoRoot();
    const destination = await mkdtemp(path.join(tmpdir(), 'o8-postship-destination-'));
    cleanupRoots.push(destination);
    await writeFile(path.join(destination, 'valuable.txt'), 'keep', 'utf8');
    await symlink(destination, path.join(root, '.next'));

    const result = await cleanupPostshipOutputs(root);

    expect(result.refused).toEqual([{ path: '.next', reason: 'Postship output has unknown lifecycle ownership.' }]);
    await expect(readFile(path.join(destination, 'valuable.txt'), 'utf8')).resolves.toBe('keep');
  });

  it('refuses a linked subtree without traversing or deleting its destination', async () => {
    const root = await makeRepoRoot();
    const destination = await mkdtemp(path.join(tmpdir(), 'o8-postship-nested-destination-'));
    cleanupRoots.push(destination);
    await writeFile(path.join(destination, 'valuable.txt'), 'keep', 'utf8');
    await mkdir(path.join(root, '.next'), { recursive: true });
    await symlink(destination, path.join(root, '.next', 'linked-cache'));

    const result = await cleanupPostshipOutputs(root);

    expect(result.refused).toEqual([{
      path: '.next',
      reason: 'Postship output has unknown lifecycle ownership.',
    }]);
    await expect(readFile(path.join(destination, 'valuable.txt'), 'utf8')).resolves.toBe('keep');
  });
});
