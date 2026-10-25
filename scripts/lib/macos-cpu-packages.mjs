import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MACOS_RELEASE_ARCHITECTURES,
  MACOS_REQUIRED_BINARIES,
  bundleContentSha256,
  macosSharedResourcesSha256,
  macosExecutablePayloadSha256,
  resolveMacosCpuArtifacts,
  resolveMacosReleaseArtifacts,
  verifyMacCpuApp,
  verifyUniversalMacApp,
} from './macos-release-artifacts.mjs';

export function macosCpuPackageArchitectures(mode) {
  if (mode === undefined || mode === '' || mode === '0') return [];
  if (MACOS_RELEASE_ARCHITECTURES.includes(mode)) return [mode];
  if (mode === '1') return [...MACOS_RELEASE_ARCHITECTURES];
  throw new Error('O8_MACOS_CPU_PACKAGES must be 0, 1, x86_64 or arm64');
}

function inspectSignature(path, architecture, options) {
  const result = spawnSync('/usr/bin/codesign', ['-d', '--arch', architecture, ...options, path], {
    encoding: 'utf8', timeout: 30_000,
  });
  if (result.error || result.status !== 0) throw new Error('unable to inspect macOS source signing policy');
  return result;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function macosSigningPolicy(path, architecture) {
  const details = inspectSignature(path, architecture, ['--verbose=4']).stderr;
  const field = (name) => details.split('\n').find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
  const identifier = field('Identifier');
  const team = field('TeamIdentifier');
  const flags = details.match(/\bflags=(0x[\da-f]+)/i)?.[1];
  if (!identifier || !team || !flags) throw new Error('incomplete macOS source signing policy');
  const entitlements = inspectSignature(path, architecture, ['--entitlements', ':-']).stdout.trim();
  let entitlementsValue = null;
  if (entitlements) {
    const converted = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
      input: entitlements, encoding: 'utf8', timeout: 30_000,
    });
    if (converted.error || converted.status !== 0) throw new Error('unable to inspect macOS entitlements');
    entitlementsValue = canonical(JSON.parse(converted.stdout));
  }
  return {
    identifier, team, flags, runtime: field('Runtime Version') ?? null,
    requirements: inspectSignature(path, architecture, ['-r', '-']).stdout.trim(),
    entitlements: entitlementsValue,
  };
}

export function verifyMacCpuDerivation(universalApp, cpuApp, architecture) {
  verifyUniversalMacApp(universalApp);
  const identity = verifyMacCpuApp(cpuApp, architecture);
  const sharedResourcesSha256 = macosSharedResourcesSha256(universalApp);
  if (macosSharedResourcesSha256(cpuApp) !== sharedResourcesSha256) {
    throw new Error(`${architecture} app runtime resources differ from the universal source`);
  }
  for (const relativePath of MACOS_REQUIRED_BINARIES) {
    if (macosExecutablePayloadSha256(join(cpuApp, relativePath), architecture)
      !== macosExecutablePayloadSha256(join(universalApp, relativePath), architecture)) {
      throw new Error(`${architecture} executable payload differs from the universal source: ${relativePath}`);
    }
    if (JSON.stringify(macosSigningPolicy(join(cpuApp, relativePath), architecture))
      !== JSON.stringify(macosSigningPolicy(join(universalApp, relativePath), architecture))) {
      throw new Error(`${architecture} signing policy differs from the universal source: ${relativePath}`);
    }
    if ((lstatSync(join(cpuApp, relativePath)).mode & 0o7777)
      !== (lstatSync(join(universalApp, relativePath)).mode & 0o7777)) {
      throw new Error(`${architecture} executable modes differ from the universal source`);
    }
  }
  return { ...identity, sharedResourcesSha256 };
}

export function prepareMacosCpuPackages(root, version, mode = '1') {
  const architectures = macosCpuPackageArchitectures(mode);
  if (!architectures.length) throw new Error('CPU preparation requires a selected architecture');
  if (process.platform !== 'darwin') throw new Error('macOS CPU preparation requires macOS');
  const universal = resolveMacosReleaseArtifacts(root, version);
  verifyUniversalMacApp(universal.app);
  const appVersion = execFileSync('/usr/bin/plutil', [
    '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(universal.app, 'Contents/Info.plist'),
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (appVersion !== version) throw new Error('universal app version does not match CPU preparation version');
  const sourceBundleSha256 = bundleContentSha256(universal.app);
  const destination = join(universal.bundleDir, 'cpu');
  if (lstatSync(destination, { throwIfNoEntry: false })) {
    throw new Error('CPU package output already exists; preserve or retire it before preparing again');
  }
  const staging = mkdtempSync(join(universal.bundleDir, '.cpu-staging-'));
  // Failed preparation is retained in its unique staging directory. Never
  // overwrite or retire another preparation's artifacts.
  const identities = [];
  for (const architecture of architectures) {
    const app = join(staging, architecture, 'macos', 'o8.app');
    mkdirSync(dirname(app), { recursive: true });
    execFileSync('/usr/bin/ditto', [universal.app, app], { stdio: 'pipe' });
    for (const relativePath of MACOS_REQUIRED_BINARIES) {
      const binary = join(app, relativePath);
      const mode = lstatSync(binary).mode & 0o7777;
      const thinned = `${binary}.cpu-slice`;
      execFileSync('/usr/bin/lipo', [binary, '-thin', architecture, '-output', thinned], { stdio: 'pipe' });
      chmodSync(thinned, mode);
      renameSync(thinned, binary);
    }
    identities.push(verifyMacCpuDerivation(universal.app, app, architecture));
  }
  if (bundleContentSha256(universal.app) !== sourceBundleSha256) {
    throw new Error('universal source changed during CPU package preparation');
  }
  writeFileSync(join(staging, 'derivation.json'), JSON.stringify({
    schema: 'o8/macos-cpu-derivation/v1', version, sourceBundleSha256, identities,
    acceptance: 'unsigned preparation; signing, notarization and installed acceptance pending',
  }, null, 2));
  // A concurrent preparation may have completed since the first existence check.
  if (lstatSync(destination, { throwIfNoEntry: false })) throw new Error('CPU package output already exists');
  renameSync(staging, destination);
  return architectures.map((architecture, index) => ({
    ...resolveMacosCpuArtifacts(root, version, architecture), identity: identities[index],
  }));
}

export function assertCpuPreparationCurrent(root, version, architecture) {
  const universal = resolveMacosReleaseArtifacts(root, version);
  const cpu = resolveMacosCpuArtifacts(root, version, architecture);
  const receipt = JSON.parse(readFileSync(join(universal.bundleDir, 'cpu', 'derivation.json'), 'utf8'));
  if (receipt.schema !== 'o8/macos-cpu-derivation/v1' || receipt.version !== version
    || receipt.sourceBundleSha256 !== bundleContentSha256(universal.app)) {
    throw new Error('CPU preparation no longer matches the universal release source');
  }
  return verifyMacCpuDerivation(universal.app, cpu.app, architecture);
}
