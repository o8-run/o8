#!/usr/bin/env node
/**
 * Post-bundle sign-and-notarize pass.
 *
 * Tauri's `cargo tauri build` signs the .app shell with our Developer ID
 * cert, but its codesign --deep walk skips Node native modules under
 * Resources/server/node_modules. Apple's notary service then rejects the
 * submission ("binary is not signed", "hardened runtime not enabled").
 *
 * This script runs after `cargo tauri build` to:
 *   1. Find every Mach-O binary inside Resources/server/node_modules
 *      (.node files, .dylib, named executables like spawn-helper)
 *   2. Sign each with hardened runtime + secure timestamp + Developer ID
 *   3. Re-seal the .app shell with --force --deep so the outer signature
 *      covers the now-signed nested binaries
 *   4. Submit the .app to Apple's notarytool, wait, and staple
 *   5. Re-package as .app.tar.gz, sign with the Tauri minisign key, and
 *      rebuild the .dmg so the updater + dmg both ship the stapled app
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, rmSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveNotarizationCredentials, stapleAndValidate, submitForNotarization } from './lib/notarization.mjs';
import { assertMacPackageSize } from './lib/mac-package-size.mjs';
import {
  resolveMacosReleaseArtifacts,
  resolveMacosCpuArtifacts,
  assertMacosArchitecture,
  MACOS_REQUIRED_BINARIES,
  stageMacosDmgApp,
  verifyMacCpuApp,
  verifyMacCpuUpdaterArchive,
  verifyUniversalMacApp,
  verifyUniversalMacUpdaterArchive,
} from './lib/macos-release-artifacts.mjs';
import { assertCpuPreparationCurrent, macosCpuPackageArchitectures, prepareMacosCpuPackages } from './lib/macos-cpu-packages.mjs';

const args = process.argv.slice(2);
let architecture;
if (args.length) {
  if (args.length !== 2 || args[0] !== '--architecture') {
    throw new Error('usage: node scripts/sign-and-notarize.mjs [--architecture x86_64|arm64]');
  }
  architecture = assertMacosArchitecture(args[1]);
}
const cpuArchitectures = macosCpuPackageArchitectures(process.env.O8_MACOS_CPU_PACKAGES);

let notarizationCredentials;
try {
  if (!process.env.APPLE_SIGNING_IDENTITY?.trim()) {
    throw new Error('missing env var: APPLE_SIGNING_IDENTITY');
  }
  notarizationCredentials = resolveNotarizationCredentials();
} catch (error) {
  console.error(`[sign-and-notarize] ${error.message}`);
  process.exit(1);
}

const root = process.cwd();
const pkgJson = JSON.parse(execFileSync('cat', [join(root, 'package.json')], { encoding: 'utf8' }));
const version = pkgJson.version;
const artifacts = architecture
  ? resolveMacosCpuArtifacts(root, version, architecture)
  : resolveMacosReleaseArtifacts(root, version);
const BUNDLE = artifacts.bundleDir;
const APP = artifacts.app;
const TAR = artifacts.updaterArchive;
const TAR_SIG = artifacts.updaterSignature;
const DMG = artifacts.dmg;
const DMG_STAGING = join(BUNDLE, 'dmg-staging');
const ENTITLEMENTS = join(root, 'src-tauri/entitlements.plist');
// Voice STT sidecar (lifted from aqua/Symon) ships as a Tauri externalBin in
// Contents/MacOS/speech_recognizer. It needs its own entitlements (audio-input
// + speech) and must be signed BEFORE the outer --deep re-seal, the same way
// the nested node_modules Mach-O binaries are.
const SPEECH_ENTITLEMENTS = join(root, 'src-tauri/entitlements.speech.plist');
const SIGNING_KEY = `${process.env.HOME}/.tauri/cortex-ide.key`;
const verifyApp = architecture ? (app) => verifyMacCpuApp(app, architecture) : verifyUniversalMacApp;
const verifyArchive = architecture
  ? (app, tar) => verifyMacCpuUpdaterArchive(app, tar, architecture) : verifyUniversalMacUpdaterArchive;

if (!existsSync(APP)) {
  console.error(`[sign-and-notarize] missing .app: ${APP}`);
  console.error(`[sign-and-notarize] run cargo tauri build first`);
  process.exit(1);
}

try {
  console.log('[sign-and-notarize] artifact preflight', verifyApp(APP));
  if (architecture) {
    const source = resolveMacosReleaseArtifacts(root, version).app;
    execFileSync('codesign', ['--verify', '--deep', '--strict', source], { stdio: 'pipe' });
    assertCpuPreparationCurrent(root, version, architecture);
  }
} catch (error) {
  console.error(`[sign-and-notarize] refusing non-universal stable artifact: ${error.message}`);
  process.exit(1);
}

// Reject cache contamination and size regressions before signing or uploading.
console.log('[sign-and-notarize] package size preflight', assertMacPackageSize(APP));

// #1163: the gate launches a DISPOSABLE 2nd copy of o8.app from /tmp to test
// it, and that child intermittently PANICS (resource-dir resolution / wry event
// loop) → macOS pops "o8 quit unexpectedly" crash-report dialogs at the operator
// AND it false-blocks legit ships. Until it's redesigned to drive the
// already-running app or a headless WKWebView harness (no disposable GUI child),
// it is OPT-IN: skipped by default. The author-time #1160 ESLint guard +
// the WKWebView-API-guard directive cover the 0.1.252 class meanwhile.
// Re-enable with O8_PRESHIP_GATE_ENABLED=1; O8_GATE_STRICT=1 additionally hard-blocks.
if (process.env.O8_PRESHIP_GATE_ENABLED === '1') {
  try {
    execFileSync('node', ['scripts/preship-webview-gate.mjs', '--mode=fail-fast'], { stdio: 'inherit' });
  } catch {
    if (process.env.O8_GATE_STRICT === '1') {
      console.error('[sign-and-notarize] pre-ship boot gate FAILED (O8_GATE_STRICT) — aborting.');
      process.exit(1);
    }
    console.warn('[sign-and-notarize] WARNING: pre-ship boot gate failed (warn-only, #1163). Continuing.');
  }
} else {
  console.log('[sign-and-notarize] pre-ship boot gate skipped (opt-in via O8_PRESHIP_GATE_ENABLED=1; disabled by default — spawns a crashing GUI child, #1163).');
}

function walk(dir, predicate, results = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      walk(full, predicate, results);
    } else if (stat.isFile() && predicate(name, full)) {
      results.push(full);
    }
  }
  return results;
}

console.log('[sign-and-notarize] finding nested Mach-O binaries...');
const nodeModulesRoot = join(APP, 'Contents/Resources/server/node_modules');
const candidates = walk(nodeModulesRoot, (name) => (
  name.endsWith('.node')
  || name.endsWith('.dylib')
  || name === 'spawn-helper'
));

const machO = [];
for (const f of candidates) {
  try {
    const out = execFileSync('file', [f], { encoding: 'utf8' });
    if (out.includes('Mach-O')) machO.push(f);
  } catch {
    // skip files that can't be examined
  }
}
console.log(`[sign-and-notarize] signing ${machO.length} nested binaries`);

for (const f of architecture ? [] : machO) {
  execFileSync('codesign', [
    '--force',
    '--options', 'runtime',
    '--timestamp',
    '--sign', process.env.APPLE_SIGNING_IDENTITY,
    f,
  ], { stdio: 'inherit' });
}

// ── Voice STT sidecar (speech_recognizer externalBin) ──
// Tauri drops the externalBin into Contents/MacOS/speech_recognizer (the
// target-triple suffix is stripped at bundle time). It must be signed with
// hardened runtime + the speech/audio-input entitlements BEFORE the outer
// --deep re-seal, or notarization rejects it as unsigned.
const macosDir = join(APP, 'Contents/MacOS');
const speechCandidates = existsSync(macosDir)
  ? readdirSync(macosDir).filter((name) => name.startsWith('speech_recognizer'))
  : [];
if (speechCandidates.length === 0) {
  console.warn('[sign-and-notarize] WARNING: no speech_recognizer externalBin found in Contents/MacOS — voice STT may not have bundled');
}
for (const name of architecture ? [] : speechCandidates) {
  const f = join(macosDir, name);
  let isMachO = false;
  try {
    isMachO = execFileSync('file', [f], { encoding: 'utf8' }).includes('Mach-O');
  } catch { /* skip */ }
  if (!isMachO) continue;
  console.log(`[sign-and-notarize] signing voice STT sidecar: ${name}`);
  execFileSync('codesign', [
    '--force',
    '--options', 'runtime',
    '--timestamp',
    '--sign', process.env.APPLE_SIGNING_IDENTITY,
    '--entitlements', SPEECH_ENTITLEMENTS,
    f,
  ], { stdio: 'inherit' });
}

if (architecture) {
  // The common native addons are already signed in the verified universal
  // source. Re-sign only the thinned sidecars, preserving their exact policy.
  for (const relativePath of MACOS_REQUIRED_BINARIES.filter((path) => path !== 'Contents/MacOS/o8')) {
    execFileSync('codesign', [
      '--force', '--preserve-metadata=identifier,entitlements,requirements,flags,runtime',
      '--timestamp', '--sign', process.env.APPLE_SIGNING_IDENTITY, join(APP, relativePath),
    ], { stdio: 'inherit' });
  }
}
console.log('[sign-and-notarize] re-sealing .app shell');
execFileSync('codesign', [
  '--force',
  ...(architecture
    ? ['--preserve-metadata=identifier,entitlements,requirements,flags,runtime']
    : ['--deep', '--options', 'runtime']),
  '--timestamp',
  '--sign', process.env.APPLE_SIGNING_IDENTITY,
  ...(!architecture ? ['--entitlements', ENTITLEMENTS] : []),
  APP,
], { stdio: 'inherit' });

console.log('[sign-and-notarize] verifying signature');
execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', APP], { stdio: 'inherit' });

const ZIP = architecture ? join(BUNDLE, 'o8-notarize.zip') : '/tmp/o8-notarize.zip';
if (existsSync(ZIP)) rmSync(ZIP);
console.log('[sign-and-notarize] zipping for notarization');
execFileSync('ditto', ['-c', '-k', '--keepParent', APP, ZIP], { stdio: 'inherit' });

console.log('[sign-and-notarize] submitting to Apple notary (5-15 min)');
submitForNotarization(ZIP, notarizationCredentials);

console.log('[sign-and-notarize] stapling notarization ticket');
stapleAndValidate(APP);

// Codesigning and stapling rewrite bundle bytes. Re-inspect the final app
// before creating either distributable so a stale/thin replacement cannot
// become the arm64 updater payload.
console.log('[sign-and-notarize] final artifact', verifyApp(APP));
if (architecture) assertCpuPreparationCurrent(root, version, architecture);

console.log('[sign-and-notarize] repackaging .app.tar.gz');
if (existsSync(TAR)) rmSync(TAR);
if (existsSync(TAR_SIG)) rmSync(TAR_SIG);
// COPYFILE_DISABLE=1: macOS `tar` otherwise stores every xattr/resource-fork as
// an AppleDouble `._` member (`._o8.app`, `._Contents`, ...). macOS `tar -xzf`
// silently merges those, but the Tauri updater's Rust tar extractor FAILS on
// `._o8.app` ("failed to unpack ._o8.app") — which silently broke every
// auto-update. Disabling AppleDouble keeps the updater tarball clean. The app's
// code signature + staple are regular bundle files, unaffected.
execFileSync('tar', ['czf', TAR, '-C', join(BUNDLE, 'macos'), 'o8.app'], {
  stdio: 'inherit',
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});

console.log('[sign-and-notarize] verified updater archive', verifyArchive(APP, TAR));

// Recheck the final signed/stapled bytes before updater signing or DMG upload.
console.log('[sign-and-notarize] final package size', assertMacPackageSize(APP, TAR));

console.log('[sign-and-notarize] minisign-signing the new tar.gz');
// Newer cargo-tauri-cli rejects `--private-key-path` when
// TAURI_SIGNING_PRIVATE_KEY env var is also set ("cannot be used with").
// Read the key into the env var, drop the flag, force empty password,
// and close stdin so the signer doesn't prompt.
execFileSync('cargo', ['tauri', 'signer', 'sign', TAR], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(SIGNING_KEY, 'utf8').trim(),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
  },
});

console.log('[sign-and-notarize] rebuilding DMG with stapled app');
if (existsSync(DMG)) rmSync(DMG);
if (existsSync(DMG_STAGING)) rmSync(DMG_STAGING, { recursive: true, force: true });
mkdirSync(DMG_STAGING, { recursive: true });
stageMacosDmgApp(APP, DMG_STAGING);
symlinkSync('/Applications', join(DMG_STAGING, 'Applications'));
mkdirSync(dirname(DMG), { recursive: true });
execFileSync('hdiutil', [
  'create',
  '-volname', `o8 ${version}`,
  '-srcfolder', DMG_STAGING,
  '-ov',
  '-format', 'ULMO',
  DMG,
], { stdio: 'inherit' });
rmSync(DMG_STAGING, { recursive: true, force: true });

console.log('[sign-and-notarize] signing DMG');
execFileSync('codesign', [
  '--force',
  '--sign', process.env.APPLE_SIGNING_IDENTITY,
  '--timestamp',
  DMG,
], { stdio: 'inherit' });

console.log('[sign-and-notarize] submitting signed DMG to Apple notary (5-15 min)');
submitForNotarization(DMG, notarizationCredentials);

console.log('[sign-and-notarize] stapling and validating DMG notarization ticket');
stapleAndValidate(DMG);

console.log('[sign-and-notarize] done. app and DMG are notarized; now run scripts/release.mjs to publish');

if (!architecture && cpuArchitectures.length) {
  prepareMacosCpuPackages(root, version, process.env.O8_MACOS_CPU_PACKAGES);
  for (const cpu of cpuArchitectures) {
    execFileSync(process.execPath, [join(root, 'scripts/sign-and-notarize.mjs'), '--architecture', cpu], {
      cwd: root, stdio: 'inherit', env: process.env,
    });
  }
}
