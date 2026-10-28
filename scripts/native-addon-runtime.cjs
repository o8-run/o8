'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const redirects = new Map();
let resolverInstalled = false;

function assertSupportedArchitecture(packageName, arch, platform = 'darwin') {
  if (arch !== 'x64' && arch !== 'arm64') {
    const label = platform === 'linux' ? 'Linux' : 'macOS';
    throw new Error(`[native-addon] Unsupported ${label} architecture for ${packageName}: ${arch}`);
  }
}

function bundledAbiDirectories(moduleRoot) {
  try {
    return fs.readdirSync(path.join(moduleRoot, 'prebuilds'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^node-v\d+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function selectPrebuild(moduleRoot, packageName, addonName, arch, abi, pathExists = fs.existsSync, platform = 'darwin') {
  assertSupportedArchitecture(packageName, arch, platform);

  const abiDirectories = bundledAbiDirectories(moduleRoot);
  const selectedAbiDirectory = `node-v${abi}`;
  const selected = path.join(moduleRoot, 'prebuilds', selectedAbiDirectory, `${platform}-${arch}`, addonName);
  if (pathExists(selected)) return selected;

  // Linux bundles are always multi-ABI when they have any node-v* directory:
  // never fall back to another ABI's binary, which cannot load.
  if (platform !== 'darwin') {
    throw new Error(`[native-addon] Missing ${packageName} ${platform}-${arch} prebuild for Node ABI ${abi}: ${selected}`);
  }

  // Older single-ABI bundles only have prebuilds/darwin-<arch>. A partially
  // migrated bundle may have one node-v* directory. Preserve both layouts,
  // but never silently choose an arbitrary ABI when multiple are bundled.
  if (abiDirectories.length === 1) {
    const singleAbi = path.join(moduleRoot, 'prebuilds', abiDirectories[0], `darwin-${arch}`, addonName);
    if (pathExists(singleAbi)) return singleAbi;
  }
  if (abiDirectories.length === 0) {
    const legacy = path.join(moduleRoot, 'prebuilds', `darwin-${arch}`, addonName);
    if (pathExists(legacy)) return legacy;
  }

  throw new Error(`[native-addon] Missing ${packageName} ${arch} prebuild for Node ABI ${abi}: ${selected}`);
}

function selectBetterSqlite3Prebuild(
  moduleRoot,
  arch,
  pathExists = fs.existsSync,
  abi = process.versions.modules,
  platform = 'darwin',
) {
  return selectPrebuild(moduleRoot, 'better-sqlite3', 'better_sqlite3.node', arch, abi, pathExists, platform);
}

function selectNodePtyPrebuild(
  moduleRoot,
  arch,
  pathExists = fs.existsSync,
  abi = process.versions.modules,
) {
  return selectPrebuild(moduleRoot, 'node-pty', 'pty.node', arch, abi, pathExists);
}

function installNativeRedirects() {
  if (resolverInstalled) return;
  resolverInstalled = true;

  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function resolvePackagedNativeAddon(request, parent, isMain, options) {
    if (typeof request === 'string') {
      const redirect = redirects.get(path.resolve(request));
      if (redirect) return redirect;
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
}

function findPackageRoots(serverRoot, packageName) {
  const nodeModules = path.join(serverRoot, 'node_modules');
  let entries;
  try {
    entries = fs.readdirSync(nodeModules, { withFileTypes: true });
  } catch (error) {
    throw new Error(`[native-addon] Cannot inspect packaged node_modules at ${nodeModules}: ${error.message}`);
  }

  return entries
    .filter((entry) => entry.isDirectory() && (entry.name === packageName || entry.name.startsWith(`${packageName}-`)))
    .map((entry) => path.join(nodeModules, entry.name));
}

function prepareBetterSqlite3(serverRoot, arch = process.arch, abi = process.versions.modules, platform = 'darwin') {
  const moduleRoots = findPackageRoots(serverRoot, 'better-sqlite3');
  if (moduleRoots.length === 0) {
    throw new Error(`[native-addon] No packaged better-sqlite3 module found under ${serverRoot}`);
  }

  for (const moduleRoot of moduleRoots) {
    const source = selectBetterSqlite3Prebuild(moduleRoot, arch, fs.existsSync, abi, platform);
    const target = path.join(moduleRoot, 'build', 'Release', 'better_sqlite3.node');
    redirects.set(path.resolve(target), source);
    installNativeRedirects();
  }
}

function prepareNodePty(serverRoot, arch = process.arch, abi = process.versions.modules) {
  const moduleRoots = findPackageRoots(serverRoot, 'node-pty');
  if (moduleRoots.length === 0) {
    throw new Error(`[native-addon] No packaged node-pty module found under ${serverRoot}`);
  }

  for (const moduleRoot of moduleRoots) {
    const source = selectNodePtyPrebuild(moduleRoot, arch, fs.existsSync, abi);
    const sourceHelper = path.join(path.dirname(source), 'spawn-helper');
    const loaderDir = path.join(moduleRoot, 'prebuilds', `darwin-${arch}`);
    const loaderSource = path.join(loaderDir, 'pty.node');
    const loaderHelper = path.join(loaderDir, 'spawn-helper');
    for (const required of [sourceHelper, loaderSource, loaderHelper]) {
      if (!fs.existsSync(required)) {
        throw new Error(`[native-addon] Missing packaged node-pty runtime: ${required}`);
      }
    }
  }
}

/** Whether every packaged better-sqlite3 copy carries the multi-ABI layout. */
function hasMultiAbiBetterSqlite3(serverRoot) {
  let roots;
  try {
    roots = findPackageRoots(serverRoot, 'better-sqlite3');
  } catch {
    return false;
  }
  return roots.length > 0 && roots.every((root) => bundledAbiDirectories(root).length > 0);
}

function prepareNativeAddons(serverRoot, arch = process.arch, abi = process.versions.modules, platform = process.platform) {
  if (platform === 'darwin') {
    prepareBetterSqlite3(serverRoot, arch, abi);
    prepareNodePty(serverRoot, arch, abi);
    return;
  }
  // Linux packages ship better-sqlite3 for every supported Node ABI under
  // `prebuilds/node-v<abi>/linux-<arch>` (one per Node major the pre-flight
  // accepts). node-pty's Linux prebuild is Node-API, so it loads unchanged on
  // every ABI. Bundles and source checkouts without the multi-ABI layout keep
  // the host-compiled build/Release binary and load it untouched (#1673).
  if (platform === 'linux' && hasMultiAbiBetterSqlite3(serverRoot)) {
    prepareBetterSqlite3(serverRoot, arch, abi, 'linux');
  }
}

module.exports = {
  hasMultiAbiBetterSqlite3,
  prepareBetterSqlite3,
  prepareNativeAddons,
  prepareNodePty,
  selectBetterSqlite3Prebuild,
  selectNodePtyPrebuild,
};
