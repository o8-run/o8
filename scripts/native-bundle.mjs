#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { verifyNextAppSidecar } from './next/verify-app-bundle.mjs';

export const SUPPORTED_NODE_MAJORS = [22, 24];
export const NATIVE_ABI_MANIFEST = 'native-addon-abis.json';
const NODE_RELEASE_INDEX_URL = 'https://nodejs.org/dist/index.json';
const BETTER_SQLITE3_ADDON = 'better_sqlite3.node';
const NODE_PTY_ADDON = 'pty.node';
const NODE_PTY_HELPER = 'spawn-helper';
export const DEFAULT_APPLE_SIGNING_IDENTITY = 'Developer ID Application: Marquise Hurtt (3U3MXN796S)';
const MACH_O_MAGICS = new Set([
  'feedface',
  'cefaedfe',
  'feedfacf',
  'cffaedfe',
  'cafebabe',
  'bebafeca',
  'cafebabf',
  'bfbafeca',
]);

function commandError(error) {
  return error?.stderr?.toString().trim()
    || error?.stdout?.toString().trim()
    || error?.message
    || String(error);
}

export function resolveAppleSigningIdentity(env = process.env) {
  return env.APPLE_SIGNING_IDENTITY?.trim() || DEFAULT_APPLE_SIGNING_IDENTITY;
}

export function resolveNativeBundleCacheRoot(cacheRoot, env = process.env) {
  return resolve(cacheRoot ?? (env.O8_NATIVE_BUNDLE_CACHE_DIR?.trim() || join(homedir(), '.o8-build-cache', 'native')));
}

export function isMachOFile(filePath) {
  const header = Buffer.alloc(4);
  let descriptor;
  try {
    descriptor = openSync(filePath, 'r');
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
    return MACH_O_MAGICS.has(header.toString('hex'));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function findMachOBinaries(rootPath) {
  const resolvedRoot = resolve(rootPath);
  if (!existsSync(resolvedRoot)) {
    throw new Error(`[native-sign] missing native module root: ${resolvedRoot}`);
  }

  const binaries = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && isMachOFile(entryPath)) {
        binaries.push(entryPath);
      }
    }
  };
  visit(resolvedRoot);

  return binaries.sort((left, right) => {
    const depthDelta = relative(resolvedRoot, right).split(sep).length
      - relative(resolvedRoot, left).split(sep).length;
    return depthDelta || left.localeCompare(right);
  });
}

export function verifyMachOSignatures(
  rootPath,
  { run = execFileSync, log = console.log } = {},
) {
  const binaries = findMachOBinaries(rootPath);
  if (binaries.length === 0) {
    throw new Error(`[native-sign] no Mach-O binaries found under ${resolve(rootPath)}`);
  }

  for (const filePath of binaries) {
    try {
      run('codesign', ['--verify', '--strict', '--verbose=2', filePath], { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`[native-sign] signature verification failed for ${filePath}: ${commandError(error)}`);
    }
  }
  log(`[native-sign] verified ${binaries.length} nested Mach-O signatures`);
  return binaries;
}

export function signMachOBinaries(
  rootPath,
  {
    identity = resolveAppleSigningIdentity(),
    run = execFileSync,
    log = console.log,
  } = {},
) {
  const binaries = findMachOBinaries(rootPath);
  if (binaries.length === 0) {
    throw new Error(`[native-sign] no Mach-O binaries found under ${resolve(rootPath)}`);
  }

  for (const filePath of binaries) {
    try {
      run('codesign', [
        '--force',
        identity === '-' ? '--timestamp=none' : '--timestamp',
        '--options',
        'runtime',
        '--sign',
        identity,
        filePath,
      ], { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`[native-sign] failed to sign ${filePath}: ${commandError(error)}`);
    }
  }
  log(`[native-sign] signed ${binaries.length} nested Mach-O binaries with ${identity}`);
  verifyMachOSignatures(rootPath, { run, log });
  return { binaries, identity };
}

function readMachOArchitecture(filePath) {
  const header = readFileSync(filePath).subarray(0, 8);
  if (header.length < 8 || header.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`${filePath} is not a thin 64-bit Mach-O binary`);
  }

  const cpuType = header.readUInt32LE(4);
  if (cpuType === 0x01000007) return 'x64';
  if (cpuType === 0x0100000c) return 'arm64';
  throw new Error(`${filePath} has unsupported Mach-O CPU type 0x${cpuType.toString(16)}`);
}

const ELF_MACHINES = new Map([[0x3e, 'x64'], [0xb7, 'arm64']]);

export function readElfArchitecture(filePath) {
  const header = readFileSync(filePath).subarray(0, 20);
  if (header.length < 20 || header.readUInt32BE(0) !== 0x7f454c46) {
    throw new Error(`${filePath} is not an ELF binary`);
  }
  if (header[4] !== 2 || header[5] !== 1) {
    throw new Error(`${filePath} is not a 64-bit little-endian ELF binary`);
  }
  const machine = header.readUInt16LE(18);
  const arch = ELF_MACHINES.get(machine);
  if (!arch) throw new Error(`${filePath} has unsupported ELF machine 0x${machine.toString(16)}`);
  return arch;
}

function assertElfArchitecture(filePath, expectedArch) {
  if (!existsSync(filePath)) {
    throw new Error(`missing ${expectedArch} native addon: ${filePath}`);
  }
  const actualArch = readElfArchitecture(filePath);
  if (actualArch !== expectedArch) {
    throw new Error(`wrong architecture at ${filePath}: expected ${expectedArch}, found ${actualArch}`);
  }
  return { path: filePath, arch: actualArch };
}

function assertMachOArchitecture(filePath, expectedArch) {
  if (!existsSync(filePath)) {
    throw new Error(`missing ${expectedArch} native addon: ${filePath}`);
  }
  const actualArch = readMachOArchitecture(filePath);
  if (actualArch !== expectedArch) {
    throw new Error(`wrong architecture at ${filePath}: expected ${expectedArch}, found ${actualArch}`);
  }
  return { path: filePath, arch: actualArch };
}

export function deriveNodeAbis(releases, nodeMajors = SUPPORTED_NODE_MAJORS) {
  const nodeAbis = {};
  for (const major of nodeMajors) {
    const matching = releases.filter((release) => {
      const releaseMajor = Number.parseInt(String(release.version || '').replace(/^v/, '').split('.')[0], 10);
      return releaseMajor === major && release.modules;
    });
    const modules = [...new Set(matching.map((release) => String(release.modules)))];
    if (modules.length !== 1) {
      throw new Error(`nodejs.org release index did not resolve one ABI for Node ${major}: ${modules.join(', ') || 'none'}`);
    }
    nodeAbis[String(major)] = modules[0];
  }
  return nodeAbis;
}

async function loadNodeReleaseIndex(cacheRoot) {
  const cachePath = join(cacheRoot, 'nodejs.org', 'index.json');
  if (existsSync(cachePath)) {
    return { releases: JSON.parse(readFileSync(cachePath, 'utf8')), cachePath, cacheSource: 'cache' };
  }

  let response;
  try {
    response = await fetch(NODE_RELEASE_INDEX_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`Node ABI lookup failed and no cache exists at ${cachePath}: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`Node ABI lookup returned HTTP ${response.status}: ${NODE_RELEASE_INDEX_URL}`);
  }

  const releases = await response.json();
  mkdirSync(dirname(cachePath), { recursive: true });
  const partialPath = `${cachePath}.${process.pid}.tmp`;
  try {
    writeFileSync(partialPath, `${JSON.stringify(releases, null, 2)}\n`);
    renameSync(partialPath, cachePath);
  } finally {
    rmSync(partialPath, { force: true });
  }
  return { releases, cachePath, cacheSource: 'download' };
}

export function betterSqlite3Asset(version, abi, arch, platform = 'darwin') {
  const filename = `better-sqlite3-v${version}-node-v${abi}-${platform}-${arch}.tar.gz`;
  return {
    filename,
    url: `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${filename}`,
  };
}

async function ensureCachedAsset(asset, cachePath) {
  if (existsSync(cachePath)) return 'cache';

  let response;
  try {
    response = await fetch(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`download failed and no cache exists at ${cachePath}: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`download returned HTTP ${response.status} and no cache exists at ${cachePath}: ${asset.url}`);
  }

  mkdirSync(dirname(cachePath), { recursive: true });
  const partialPath = `${cachePath}.${process.pid}.tmp`;
  try {
    writeFileSync(partialPath, Buffer.from(await response.arrayBuffer()));
    renameSync(partialPath, cachePath);
  } finally {
    rmSync(partialPath, { force: true });
  }
  return 'download';
}

function copyExecutable(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, statSync(source).mode & 0o777);
}

async function prepareBetterSqlite3Bundle({ projectRoot, serverRoot, cacheRoot, nodeAbis }) {
  const packageRoot = join(projectRoot, 'node_modules', 'better-sqlite3');
  const packageJsonPath = join(packageRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(`better-sqlite3 is not installed at ${packageRoot}`);
  }

  const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const moduleRoot = join(serverRoot, 'node_modules', 'better-sqlite3');
  const assets = [];
  for (const abi of Object.values(nodeAbis)) {
    for (const arch of ['x64', 'arm64']) {
      const asset = betterSqlite3Asset(version, abi, arch);
      const cachePath = join(cacheRoot, 'better-sqlite3', version, asset.filename);
      const cacheSource = await ensureCachedAsset(asset, cachePath);
      const extractRoot = mkdtempSync(join(tmpdir(), 'o8-better-sqlite3-'));
      const extractedAddon = join(extractRoot, 'build', 'Release', BETTER_SQLITE3_ADDON);
      try {
        execFileSync('tar', ['-xzf', cachePath, '-C', extractRoot, `build/Release/${BETTER_SQLITE3_ADDON}`], { stdio: 'pipe' });
        assertMachOArchitecture(extractedAddon, arch);
        const destination = join(moduleRoot, 'prebuilds', `node-v${abi}`, `darwin-${arch}`, BETTER_SQLITE3_ADDON);
        copyExecutable(extractedAddon, destination);
      } catch (error) {
        throw new Error(`failed to extract a valid ${arch} addon from ${cachePath}: ${error.stderr?.toString().trim() || error.message}`);
      } finally {
        rmSync(extractRoot, { recursive: true, force: true });
      }
      assets.push({ abi, arch, url: asset.url, cachePath, cacheSource });
    }
  }

  return { version, assets };
}

function prepareNodePtyBundle({ projectRoot, serverRoot, nodeAbis }) {
  const packageRoot = join(projectRoot, 'node_modules', 'node-pty');
  const packageJsonPath = join(packageRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(`node-pty is not installed at ${packageRoot}`);
  }

  const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const moduleRoot = join(serverRoot, 'node_modules', 'node-pty');
  for (const abi of Object.values(nodeAbis)) {
    for (const arch of ['x64', 'arm64']) {
      const sourceDir = join(packageRoot, 'prebuilds', `darwin-${arch}`);
      const sourceAddon = join(sourceDir, NODE_PTY_ADDON);
      const sourceHelper = join(sourceDir, NODE_PTY_HELPER);
      assertMachOArchitecture(sourceAddon, arch);
      assertMachOArchitecture(sourceHelper, arch);

      // node-pty's official Darwin prebuilds use Node-API, so one published
      // binary works across Node module ABIs. Keep an ABI-keyed copy for each
      // supported runtime so the runtime selector and ship gate use one layout.
      const destinationDir = join(moduleRoot, 'prebuilds', `node-v${abi}`, `darwin-${arch}`);
      copyExecutable(sourceAddon, join(destinationDir, NODE_PTY_ADDON));
      copyExecutable(sourceHelper, join(destinationDir, NODE_PTY_HELPER));
    }
  }
  return { version };
}

export function removePackagedNativeBuildOutputs(serverRoot) {
  const removed = [];
  for (const packageName of ['better-sqlite3', 'node-pty']) {
    const buildPath = join(serverRoot, 'node_modules', packageName, 'build');
    if (!existsSync(buildPath)) continue;
    rmSync(buildPath, { recursive: true, force: true });
    removed.push(buildPath);
  }
  return removed;
}

export function removeIncompatibleMacPrebuilds(serverRoot) {
  const prebuildRoot = join(serverRoot, 'node_modules', 'node-pty', 'prebuilds');
  if (!existsSync(prebuildRoot)) return [];

  const removed = [];
  for (const entry of readdirSync(prebuildRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || (!entry.name.startsWith('linux-') && !entry.name.startsWith('win32-'))) continue;
    const incompatiblePath = join(prebuildRoot, entry.name);
    rmSync(incompatiblePath, { recursive: true, force: true });
    removed.push(incompatiblePath);
  }
  return removed;
}

export async function prepareNativeBundle({ projectRoot, serverRoot, cacheRoot } = {}) {
  const resolvedProjectRoot = resolve(projectRoot ?? process.cwd());
  const resolvedServerRoot = resolve(serverRoot ?? join(resolvedProjectRoot, 'out', 'server'));
  const resolvedCacheRoot = resolveNativeBundleCacheRoot(cacheRoot);
  const nodeIndex = await loadNodeReleaseIndex(resolvedCacheRoot);
  const nodeAbis = deriveNodeAbis(nodeIndex.releases);
  const betterSqlite3 = await prepareBetterSqlite3Bundle({
    projectRoot: resolvedProjectRoot,
    serverRoot: resolvedServerRoot,
    cacheRoot: resolvedCacheRoot,
    nodeAbis,
  });
  const nodePty = prepareNodePtyBundle({
    projectRoot: resolvedProjectRoot,
    serverRoot: resolvedServerRoot,
    nodeAbis,
  });
  removePackagedNativeBuildOutputs(resolvedServerRoot);
  const prunedPrebuilds = removeIncompatibleMacPrebuilds(resolvedServerRoot);
  const nativeSigning = signMachOBinaries(join(resolvedServerRoot, 'node_modules'));

  const manifest = {
    schema: 'o8/native-addon-abis/v1',
    source: NODE_RELEASE_INDEX_URL,
    nodeAbis,
    addons: {
      'better-sqlite3': betterSqlite3.version,
      'node-pty': nodePty.version,
    },
  };
  writeFileSync(join(resolvedServerRoot, NATIVE_ABI_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { nodeAbis, nodeIndex, betterSqlite3, nodePty, prunedPrebuilds, nativeSigning };
}

async function prepareLinuxBetterSqlite3Bundle({ projectRoot, serverRoot, cacheRoot, nodeAbis, arch }) {
  const packageRoot = join(projectRoot, 'node_modules', 'better-sqlite3');
  const packageJsonPath = join(packageRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(`better-sqlite3 is not installed at ${packageRoot}`);
  }

  const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const moduleRoot = join(serverRoot, 'node_modules', 'better-sqlite3');
  const assets = [];
  for (const abi of Object.values(nodeAbis)) {
    const asset = betterSqlite3Asset(version, abi, arch, 'linux');
    const cachePath = join(cacheRoot, 'better-sqlite3', version, asset.filename);
    const cacheSource = await ensureCachedAsset(asset, cachePath);
    const extractRoot = mkdtempSync(join(tmpdir(), 'o8-better-sqlite3-'));
    const extractedAddon = join(extractRoot, 'build', 'Release', BETTER_SQLITE3_ADDON);
    try {
      execFileSync('tar', ['-xzf', cachePath, '-C', extractRoot, `build/Release/${BETTER_SQLITE3_ADDON}`], { stdio: 'pipe' });
      assertElfArchitecture(extractedAddon, arch);
      const destination = join(moduleRoot, 'prebuilds', `node-v${abi}`, `linux-${arch}`, BETTER_SQLITE3_ADDON);
      copyExecutable(extractedAddon, destination);
    } catch (error) {
      throw new Error(`failed to extract a valid linux-${arch} addon from ${cachePath}: ${error.stderr?.toString().trim() || error.message}`);
    } finally {
      rmSync(extractRoot, { recursive: true, force: true });
    }
    assets.push({ abi, arch, url: asset.url, cachePath, cacheSource });
  }
  return { version, assets };
}

/**
 * Linux counterpart of prepareNativeBundle. The Linux package runs on the
 * user's system Node, which the shell pre-flight accepts at every major in
 * SUPPORTED_NODE_MAJORS, so better-sqlite3 (a NODE_MODULE_VERSION addon) ships
 * once per ABI. node-pty's Linux prebuild is Node-API and loads on every ABI
 * unchanged, so it keeps its own layout. No signing step exists on Linux.
 */
export async function prepareLinuxNativeBundle({ projectRoot, serverRoot, cacheRoot, arch = process.arch } = {}) {
  const resolvedProjectRoot = resolve(projectRoot ?? process.cwd());
  const resolvedServerRoot = resolve(serverRoot ?? join(resolvedProjectRoot, 'out', 'server'));
  const resolvedCacheRoot = resolveNativeBundleCacheRoot(cacheRoot);
  const nodeIndex = await loadNodeReleaseIndex(resolvedCacheRoot);
  const nodeAbis = deriveNodeAbis(nodeIndex.releases);
  const betterSqlite3 = await prepareLinuxBetterSqlite3Bundle({
    projectRoot: resolvedProjectRoot,
    serverRoot: resolvedServerRoot,
    cacheRoot: resolvedCacheRoot,
    nodeAbis,
    arch,
  });
  // The selector redirects build/Release to the ABI-matched prebuild; drop the
  // host-compiled copy so a missing ABI fails loudly instead of loading the
  // wrong NODE_MODULE_VERSION.
  rmSync(join(resolvedServerRoot, 'node_modules', 'better-sqlite3', 'build'), { recursive: true, force: true });

  const manifest = {
    schema: 'o8/native-addon-abis/v1',
    source: NODE_RELEASE_INDEX_URL,
    platform: 'linux',
    arch,
    nodeAbis,
    addons: { 'better-sqlite3': betterSqlite3.version },
  };
  writeFileSync(join(resolvedServerRoot, NATIVE_ABI_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return { nodeAbis, nodeIndex, betterSqlite3 };
}

/** Packaged-tree gate for Linux: every supported Node major has its addon. */
export function verifyLinuxNativeBundle(serverRoot, { arch = process.arch, log = console.log } = {}) {
  const resolvedServerRoot = resolve(serverRoot);
  const manifest = readNativeAbiManifest(resolvedServerRoot);
  const verified = [];
  for (const major of SUPPORTED_NODE_MAJORS) {
    const abi = String(manifest.nodeAbis[String(major)]);
    const filePath = join(resolvedServerRoot, 'node_modules', 'better-sqlite3', 'prebuilds',
      `node-v${abi}`, `linux-${arch}`, BETTER_SQLITE3_ADDON);
    try {
      verified.push(assertElfArchitecture(filePath, arch));
      log(`[native-gate] OK better-sqlite3 Node ${major} ABI ${abi} linux-${arch}: ${filePath}`);
    } catch (error) {
      throw new Error(`[native-gate] FAILED better-sqlite3 Node ${major} ABI ${abi} linux-${arch}: ${error.message}`);
    }
  }
  const buildPath = join(resolvedServerRoot, 'node_modules', 'better-sqlite3', 'build');
  if (existsSync(buildPath)) {
    throw new Error(`[native-gate] FAILED packaged runtime build output must be absent: ${buildPath}`);
  }
  return verified;
}

function readNativeAbiManifest(serverRoot) {
  const manifestPath = join(serverRoot, NATIVE_ABI_MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new Error(`missing native ABI manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const major of SUPPORTED_NODE_MAJORS) {
    if (!manifest.nodeAbis?.[String(major)]) {
      throw new Error(`native ABI manifest is missing Node ${major}`);
    }
  }
  return manifest;
}

export function verifyNativeBundle(serverRoot, log = console.log) {
  const resolvedServerRoot = resolve(serverRoot);
  verifyNextAppSidecar(resolve(resolvedServerRoot, '../../..'));
  const manifest = readNativeAbiManifest(resolvedServerRoot);
  const required = [];
  for (const major of SUPPORTED_NODE_MAJORS) {
    const abi = String(manifest.nodeAbis[String(major)]);
    for (const arch of ['x64', 'arm64']) {
      const abiRoot = join('prebuilds', `node-v${abi}`, `darwin-${arch}`);
      required.push([
        `better-sqlite3 Node ${major} ABI ${abi} ${arch}`,
        join(resolvedServerRoot, 'node_modules', 'better-sqlite3', abiRoot, BETTER_SQLITE3_ADDON),
        arch,
      ]);
      required.push([
        `node-pty Node ${major} ABI ${abi} ${arch}`,
        join(resolvedServerRoot, 'node_modules', 'node-pty', abiRoot, NODE_PTY_ADDON),
        arch,
      ]);
      required.push([
        `node-pty helper Node ${major} ABI ${abi} ${arch}`,
        join(resolvedServerRoot, 'node_modules', 'node-pty', abiRoot, NODE_PTY_HELPER),
        arch,
      ]);
    }
  }

  for (const arch of ['x64', 'arm64']) {
    const loaderRoot = join('prebuilds', `darwin-${arch}`);
    required.push([
      `node-pty loader ${arch}`,
      join(resolvedServerRoot, 'node_modules', 'node-pty', loaderRoot, NODE_PTY_ADDON),
      arch,
    ]);
    required.push([
      `node-pty loader helper ${arch}`,
      join(resolvedServerRoot, 'node_modules', 'node-pty', loaderRoot, NODE_PTY_HELPER),
      arch,
    ]);
  }

  for (const packageName of ['better-sqlite3', 'node-pty']) {
    const buildPath = join(resolvedServerRoot, 'node_modules', packageName, 'build');
    if (existsSync(buildPath)) {
      throw new Error(`[native-gate] FAILED packaged runtime build output must be absent: ${buildPath}`);
    }
  }
  const nodePtyPrebuildRoot = join(resolvedServerRoot, 'node_modules', 'node-pty', 'prebuilds');
  for (const entry of readdirSync(nodePtyPrebuildRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && (entry.name.startsWith('linux-') || entry.name.startsWith('win32-'))) {
      throw new Error(`[native-gate] FAILED incompatible Mac prebuild must be absent: ${join(nodePtyPrebuildRoot, entry.name)}`);
    }
  }

  // fsevents is an optional chokidar dependency and its universal Darwin
  // binary registers through Node-API, not NODE_MODULE_VERSION. Chokidar also
  // catches an unavailable optional watcher, so it needs no per-ABI copies.
  const verified = [];
  for (const [label, filePath, expectedArch] of required) {
    try {
      verified.push(assertMachOArchitecture(filePath, expectedArch));
      log(`[native-gate] OK ${label}: ${filePath}`);
    } catch (error) {
      throw new Error(`[native-gate] FAILED ${label}: ${error.message}`);
    }
  }
  verifyMachOSignatures(join(resolvedServerRoot, 'node_modules'), { log });
  return verified;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [command, targetArg] = process.argv.slice(2);
  if (!targetArg || !['prepare', 'verify', 'prepare-linux', 'verify-linux'].includes(command)) {
    console.error(`usage: node ${basename(import.meta.url)} prepare|verify|prepare-linux|verify-linux <server-root>`);
    process.exit(1);
  }
  try {
    if (command === 'prepare-linux') {
      const result = await prepareLinuxNativeBundle({ serverRoot: targetArg });
      console.log(`[native-export] Node ABIs ${JSON.stringify(result.nodeAbis)} from ${result.nodeIndex.cachePath}`);
      for (const asset of result.betterSqlite3.assets) {
        console.log(`[native-export] ${asset.cacheSource === 'cache' ? 'using cache' : 'cached download'} ${asset.cachePath}`);
      }
    } else if (command === 'verify-linux') {
      verifyLinuxNativeBundle(targetArg);
    } else if (command === 'prepare') {
      const result = await prepareNativeBundle({ serverRoot: targetArg });
      console.log(`[native-export] Node ABIs ${JSON.stringify(result.nodeAbis)} from ${result.nodeIndex.cachePath}`);
      for (const asset of result.betterSqlite3.assets) {
        console.log(`[native-export] ${asset.cacheSource === 'cache' ? 'using cache' : 'cached download'} ${asset.cachePath}`);
      }
      console.log(`[native-export] node-pty ${result.nodePty.version} Node-API prebuilds copied for every supported ABI`);
      console.log(`[native-export] pruned ${result.prunedPrebuilds.length} incompatible Mac prebuild directories`);
      console.log(`[native-export] signed ${result.nativeSigning.binaries.length} nested Mach-O binaries with ${result.nativeSigning.identity}`);
    } else {
      verifyNativeBundle(targetArg);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
