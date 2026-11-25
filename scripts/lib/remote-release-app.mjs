import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { resolveMacosReleaseArtifacts, verifyUniversalMacApp } from './macos-release-artifacts.mjs';
import { releaseBuildCacheInternals } from './release-build-cache.mjs';
import { resolveReleaseConfig } from './release-config.mjs';

export const REMOTE_RELEASE_APP_SCHEMA = 'o8/remote-release-app/v1';
export const REMOTE_RELEASE_APP_IMPORT_SCHEMA = 'o8/remote-release-app-import/v1';
const PUBLIC_ENV = /^(NEXT_PUBLIC_|CLERK_PUBLISHABLE_KEY$|O8_APP_VERSION$|O8_BYOK_REQUIRED$|O8_EXPERIMENTAL_|O8_LICENSE_PUBKEY$)/;
const BUILD_OPTIONS = Object.freeze({
  target: 'universal-apple-darwin', nodeEnv: 'production',
  nextBundler: 'webpack', tauriFeatures: ['dev-mcp-plugin'], signing: 'unsigned-or-adhoc',
});
const { stableJson, PHASE_CONFIG, collectWebEnvironmentFiles } = releaseBuildCacheInternals;
const digest = (value) => createHash('sha256').update(value).digest('hex');

function assertMacPlatform() {
  if (process.platform !== 'darwin') throw new Error('remote release app handoff requires macOS');
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function isInside(root, target) {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function recipeInputs(root) {
  const inputs = [];
  const paths = new Set([
    ...Object.values(PHASE_CONFIG).flatMap((phase) => phase.recipeInputs),
    'scripts/native-bundle.mjs', 'cli/esbuild.config.mjs',
    'scripts/packaged-server-smoke.mjs', 'scripts/lib/packaged-server-smoke.mjs',
    'scripts/lib/tauri-export-safety.mjs', 'src-tauri/entitlements.plist',
    'src-tauri/entitlements.speech.plist',
  ]);
  function visit(path) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) {
      inputs.push({ path, sha256: 'missing' });
      return;
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`release recipe input is a symlink: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) visit(`${path}/${name}`);
    } else if (stat.isFile()) {
      inputs.push({ path, sha256: digest(readFileSync(absolute)), mode: stat.mode & 0o7777 });
    } else throw new Error(`unsupported release recipe input: ${path}`);
  }
  for (const path of [...paths].sort()) visit(path);
  return inputs;
}

export function collectRemoteReleaseAppSource(root, env = process.env) {
  const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n').filter(Boolean).filter((line) => !/^[ MADRCU?!]{1,2} o8\.md$/.test(line));
  if (dirty.length) throw new Error('remote release app requires a clean source checkout');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error('invalid release version');
  }
  const tauri = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const macosConfigPath = join(root, 'src-tauri/tauri.macos.conf.json');
  const macos = existsSync(macosConfigPath) ? JSON.parse(readFileSync(macosConfigPath, 'utf8')) : {};
  const bundleIdentifier = macos.identifier ?? tauri.identifier;
  if (typeof bundleIdentifier !== 'string' || !/^[A-Za-z0-9.-]+$/.test(bundleIdentifier)) {
    throw new Error('invalid committed macOS bundle identifier');
  }
  const publicEnvironment = Object.fromEntries(Object.keys(env).filter((key) => PUBLIC_ENV.test(key))
    .sort().map((key) => [key, digest(String(env[key] ?? ''))]));
  const configuration = {
    release: resolveReleaseConfig(root, env), publicEnvironment,
    environmentFiles: collectWebEnvironmentFiles(root),
    releaseChannel: env.O8_RELEASE_CHANNEL || 'stable',
  };
  return {
    head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']), version, bundleIdentifier,
    inputsSha256: digest(stableJson(recipeInputs(root))),
    productionConfigSha256: digest(stableJson(configuration)), buildOptions: BUILD_OPTIONS,
  };
}

function collectAppInventory(appPath) {
  const root = resolve(appPath);
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new Error('handoff app must be a real directory');
  }
  const inventory = [];
  function visit(path, name) {
    const stat = lstatSync(path);
    const mode = stat.mode & 0o7777;
    if (mode & 0o6000) throw new Error(`unsafe privileged app mode: ${name}`);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (isAbsolute(target) || !isInside(root, resolve(dirname(path), target))) {
        throw new Error(`unsafe app symlink: ${name}`);
      }
      if (!isInside(realpathSync(root), realpathSync(path))) throw new Error(`escaping app symlink: ${name}`);
      inventory.push({ path: name, kind: 'symlink', mode, target });
    } else if (stat.isDirectory()) {
      inventory.push({ path: name, kind: 'directory', mode });
      for (const child of readdirSync(path).sort()) {
        if (child.includes('\\') || /[\x00-\x1f]/.test(child)) throw new Error('unsafe app entry name');
        visit(join(path, child), name === '.' ? child : `${name}/${child}`);
      }
    } else if (stat.isFile()) {
      inventory.push({ path: name, kind: 'file', mode, size: stat.size, sha256: digest(readFileSync(path)) });
    } else throw new Error(`unsupported app entry: ${name}`);
  }
  visit(root, '.');
  return inventory;
}

function assertAppMetadata(appPath, source) {
  const result = spawnSync('/usr/bin/plutil', [
    '-convert', 'json', '-o', '-', '--', join(appPath, 'Contents/Info.plist'),
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error('app Info.plist could not be parsed');
  let plist;
  try { plist = JSON.parse(result.stdout); } catch { throw new Error('app Info.plist is invalid'); }
  const expected = {
    CFBundleExecutable: 'o8', CFBundleIdentifier: source.bundleIdentifier,
    CFBundleShortVersionString: source.version, CFBundleVersion: source.version,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (plist?.[key] !== value) throw new Error(`app ${key} does not match committed release identity`);
  }
}

function assertUnsignedApp(appPath) {
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', appPath], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
  });
  if (!result.error && result.status !== 0 && result.stderr.includes('code object is not signed at all')) return;
  if (!result.error && result.status === 0 && /^Signature=adhoc$/m.test(result.stderr)
    && !/^Authority=/m.test(result.stderr)) return;
  throw new Error('handoff app must be unsigned or ad-hoc signed');
}

function inspectApp(appPath, source) {
  const inventory = collectAppInventory(appPath);
  assertAppMetadata(appPath, source);
  const universal = verifyUniversalMacApp(appPath);
  for (const binary of universal.binaries) {
    if (!(lstatSync(join(appPath, binary.relativePath)).mode & 0o111)) {
      throw new Error(`app binary is not executable: ${binary.relativePath}`);
    }
  }
  assertUnsignedApp(appPath);
  return { name: 'o8.app', inventory, bundleSha256: digest(stableJson(inventory)), universal };
}

export function writeRemoteReleaseAppManifest({ root, appPath, outputPath, env = process.env }) {
  assertMacPlatform();
  if (basename(appPath) !== 'o8.app' || resolve(dirname(appPath)) !== resolve(dirname(outputPath))) {
    throw new Error('handoff o8.app must live beside its manifest');
  }
  const source = collectRemoteReleaseAppSource(root, env);
  const manifest = {
    schema: REMOTE_RELEASE_APP_SCHEMA, createdAt: new Date().toISOString(),
    source, app: inspectApp(appPath, source),
  };
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { manifestPath: resolve(outputPath), manifest };
}

export function verifyRemoteReleaseAppManifest({ root, manifestPath, env = process.env }) {
  assertMacPlatform();
  if (!lstatSync(manifestPath).isFile() || lstatSync(manifestPath).isSymbolicLink()) {
    throw new Error('handoff manifest must be a real file');
  }
  const manifestBytes = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schema !== REMOTE_RELEASE_APP_SCHEMA || manifest.app?.name !== 'o8.app') {
    throw new Error('invalid handoff manifest schema or app path');
  }
  const source = collectRemoteReleaseAppSource(root, env);
  if (stableJson(manifest.source) !== stableJson(source)) throw new Error('handoff source or production configuration mismatch');
  const appPath = join(dirname(resolve(manifestPath)), 'o8.app');
  const app = inspectApp(appPath, source);
  if (stableJson(app) !== stableJson(manifest.app)) throw new Error('handoff app inventory or digest mismatch');
  return { manifest, appPath, manifestSha256: digest(manifestBytes) };
}

function safeOutputDirectory(root, directory) {
  const realRoot = realpathSync(root);
  if (!isInside(realRoot, resolve(directory))) throw new Error('release output is outside checkout');
  let current = realRoot;
  for (const part of relative(realRoot, directory).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current);
    if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) {
      throw new Error('release output directory contains an unsafe entry');
    }
  }
}

export function importRemoteReleaseApp({ root, manifestPath, env = process.env }) {
  const verified = verifyRemoteReleaseAppManifest({ root, manifestPath, env });
  const destination = resolveMacosReleaseArtifacts(realpathSync(root), verified.manifest.source.version).app;
  if (isInside(verified.appPath, destination) || isInside(destination, verified.appPath)) {
    throw new Error('handoff source overlaps release output');
  }
  safeOutputDirectory(root, dirname(destination));
  const receiptsDirectory = join(realpathSync(root), 'out', 'remote-release-imports');
  safeOutputDirectory(root, receiptsDirectory);
  const owned = mkdtempSync(join(dirname(destination), '.o8-remote-app-'));
  const staged = join(owned, 'o8.app');
  const previous = join(owned, 'previous.app');
  let movedPrevious = false;
  let installed = false;
  try {
    cpSync(verified.appPath, staged, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
    // Inspect the copied paths before chmod, which otherwise could follow a
    // source directory replaced with an escaping link during the copy.
    const withoutModes = (inventory) => inventory.map(({ mode: _mode, ...entry }) => entry);
    if (stableJson(withoutModes(collectAppInventory(staged)))
      !== stableJson(withoutModes(verified.manifest.app.inventory))) {
      throw new Error('staged handoff app inventory mismatch');
    }
    // cp's directory modes can reflect umask; restore precisely the recorded modes.
    for (const entry of verified.manifest.app.inventory) {
      if (entry.kind !== 'symlink') chmodSync(join(staged, entry.path), entry.mode);
    }
    if (stableJson(inspectApp(staged, verified.manifest.source)) !== stableJson(verified.manifest.app)) {
      throw new Error('staged handoff app inventory mismatch');
    }
    if (stableJson(collectRemoteReleaseAppSource(root, env)) !== stableJson(verified.manifest.source)) {
      throw new Error('release source changed during app import');
    }
    const receipt = {
      schema: REMOTE_RELEASE_APP_IMPORT_SCHEMA, createdAt: new Date().toISOString(),
      manifestSha256: verified.manifestSha256, source: verified.manifest.source,
      bundleSha256: verified.manifest.app.bundleSha256,
      destination: relative(realpathSync(root), destination),
      previousApp: existsSync(destination) ? relative(realpathSync(root), previous) : null,
    };
    const stagedReceiptPath = join(owned, 'import-receipt.json');
    const receiptPath = join(receiptsDirectory, `${basename(owned)}.json`);
    writeFileSync(stagedReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (existsSync(destination)) {
      if (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory()) {
        throw new Error('existing release app is an unsafe entry');
      }
      renameSync(destination, previous);
      movedPrevious = true;
    }
    renameSync(staged, destination);
    installed = true;
    renameSync(stagedReceiptPath, receiptPath);
    return { appPath: destination, receiptPath, receipt };
  } catch (error) {
    if (installed) {
      renameSync(destination, staged);
      installed = false;
    }
    if (movedPrevious && !installed) renameSync(previous, destination);
    if (!installed) rmSync(owned, { recursive: true, force: true });
    throw error;
  }
}
