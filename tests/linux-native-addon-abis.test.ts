import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error The executable build script intentionally has no declaration file.
import * as nativeBundle from '../scripts/native-bundle.mjs';

const require = createRequire(import.meta.url);
const runtime = require('../scripts/native-addon-runtime.cjs') as {
  prepareNativeAddons: (serverRoot: string, arch: string, abi: string, platform: string) => void;
  selectBetterSqlite3Prebuild: (moduleRoot: string, arch: string, pathExists: (path: string) => boolean,
    abi: string, platform: string) => string;
};
const { prepareLinuxNativeBundle, verifyLinuxNativeBundle, readElfArchitecture, SUPPORTED_NODE_MAJORS } = nativeBundle;

const roots: string[] = [];
function scratch(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Minimal 64-bit little-endian ELF header for the given e_machine. */
function elf(machine: number) {
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0x7f454c46, 0);
  header[4] = 2;
  header[5] = 1;
  header.writeUInt16LE(machine, 18);
  return header;
}

describe('Linux better-sqlite3 per-ABI selection', () => {
  const moduleRoot = '/usr/lib/o8/server/node_modules/better-sqlite3';
  const node22 = join(moduleRoot, 'prebuilds', 'node-v127', 'linux-x64', 'better_sqlite3.node');
  const node24 = join(moduleRoot, 'prebuilds', 'node-v137', 'linux-x64', 'better_sqlite3.node');
  const available = new Set([node22, node24]);

  it.each([['127', node22], ['137', node24]])('selects ABI %s', (abi, expected) => {
    expect(runtime.selectBetterSqlite3Prebuild(moduleRoot, 'x64', (path) => available.has(path), abi, 'linux'))
      .toBe(expected);
  });

  it('never falls back to another ABI', () => {
    expect(() => runtime.selectBetterSqlite3Prebuild(moduleRoot, 'x64', (path) => path === node22, '137', 'linux'))
      .toThrow('Missing better-sqlite3 linux-x64 prebuild for Node ABI 137');
  });

  it('redirects the binding require to the ABI-matched prebuild', () => {
    const serverRoot = scratch('o8-linux-native-runtime-');
    const root = join(serverRoot, 'node_modules', 'better-sqlite3');
    const abi = '999127';
    const source = join(root, 'prebuilds', `node-v${abi}`, 'linux-x64', 'better_sqlite3.node');
    mkdirSync(join(source, '..'), { recursive: true });
    writeFileSync(source, 'prebuild');

    runtime.prepareNativeAddons(serverRoot, 'x64', abi, 'linux');

    expect(require.resolve(join(root, 'build', 'Release', 'better_sqlite3.node'))).toBe(source);
  });

  it('leaves single-ABI host builds untouched', () => {
    const serverRoot = scratch('o8-linux-native-legacy-');
    const target = join(serverRoot, 'node_modules', 'better-sqlite3-legacy', 'build', 'Release', 'better_sqlite3.node');
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, 'host build');

    runtime.prepareNativeAddons(serverRoot, 'x64', '127', 'linux');

    expect(require.resolve(target)).toBe(target);
  });
});

describe('Linux native bundle export', () => {
  function fixture(arch: 'x64' | 'arm64', addonMachine: number) {
    const projectRoot = scratch('o8-linux-native-project-');
    const serverRoot = join(projectRoot, 'out', 'server');
    const cacheRoot = join(projectRoot, 'cache');
    const version = '12.8.0';
    mkdirSync(join(projectRoot, 'node_modules', 'better-sqlite3'), { recursive: true });
    writeFileSync(join(projectRoot, 'node_modules', 'better-sqlite3', 'package.json'), JSON.stringify({ version }));
    const hostBuild = join(serverRoot, 'node_modules', 'better-sqlite3', 'build', 'Release');
    mkdirSync(hostBuild, { recursive: true });
    writeFileSync(join(hostBuild, 'better_sqlite3.node'), elf(0x3e));

    mkdirSync(join(cacheRoot, 'nodejs.org'), { recursive: true });
    writeFileSync(join(cacheRoot, 'nodejs.org', 'index.json'), JSON.stringify([
      { version: 'v24.22.1', modules: '137' },
      { version: 'v22.23.4', modules: '127' },
    ]));
    for (const abi of ['127', '137']) {
      const staging = join(projectRoot, `tar-${abi}`);
      mkdirSync(join(staging, 'build', 'Release'), { recursive: true });
      writeFileSync(join(staging, 'build', 'Release', 'better_sqlite3.node'), elf(addonMachine));
      const tarball = join(cacheRoot, 'better-sqlite3', version, `better-sqlite3-v${version}-node-v${abi}-linux-${arch}.tar.gz`);
      mkdirSync(join(tarball, '..'), { recursive: true });
      execFileSync('tar', ['-czf', tarball, '-C', staging, 'build/Release/better_sqlite3.node']);
    }
    return { projectRoot, serverRoot, cacheRoot };
  }

  it('ships better-sqlite3 for every supported Node major from the cache', async () => {
    const { projectRoot, serverRoot, cacheRoot } = fixture('x64', 0x3e);

    const result = await prepareLinuxNativeBundle({ projectRoot, serverRoot, cacheRoot, arch: 'x64' });

    expect(SUPPORTED_NODE_MAJORS).toEqual([22, 24]);
    expect(result.nodeAbis).toEqual({ 22: '127', 24: '137' });
    for (const abi of ['127', '137']) {
      const addon = join(serverRoot, 'node_modules', 'better-sqlite3', 'prebuilds', `node-v${abi}`, 'linux-x64', 'better_sqlite3.node');
      expect(readElfArchitecture(addon)).toBe('x64');
    }
    expect(existsSync(join(serverRoot, 'node_modules', 'better-sqlite3', 'build'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(serverRoot, 'native-addon-abis.json'), 'utf8'));
    expect(manifest).toMatchObject({ platform: 'linux', arch: 'x64', nodeAbis: { 22: '127', 24: '137' } });
    expect(verifyLinuxNativeBundle(serverRoot, { arch: 'x64', log: () => {} })).toHaveLength(2);
  });

  it('rejects a prebuild for the wrong CPU', async () => {
    const { projectRoot, serverRoot, cacheRoot } = fixture('x64', 0xb7);

    await expect(prepareLinuxNativeBundle({ projectRoot, serverRoot, cacheRoot, arch: 'x64' }))
      .rejects.toThrow('expected x64, found arm64');
  });

  it('fails the gate when a supported major is missing', async () => {
    const { projectRoot, serverRoot, cacheRoot } = fixture('x64', 0x3e);
    await prepareLinuxNativeBundle({ projectRoot, serverRoot, cacheRoot, arch: 'x64' });
    rmSync(join(serverRoot, 'node_modules', 'better-sqlite3', 'prebuilds', 'node-v137'), { recursive: true });

    expect(() => verifyLinuxNativeBundle(serverRoot, { arch: 'x64', log: () => {} }))
      .toThrow('FAILED better-sqlite3 Node 24 ABI 137 linux-x64');
  });
});
