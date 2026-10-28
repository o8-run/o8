#!/usr/bin/env node
/**
 * Local release script — skips GitHub Actions entirely.
 *
 * The normal Tauri release flow uses tauri-action on macos-latest runners.
 * That works fine when GitHub billing is healthy, but for a "ship to myself"
 * dev prod mode loop it's slower (~6 min CI) and requires paid minutes.
 *
 * This script does the same thing from a local build:
 *   1. Reads the current package.json version (already synced across all
 *      manifests via scripts/sync-version.mjs)
 *   2. Locates the cargo tauri build artifacts
 *   3. Generates the tauri-updater latest.json with the signature + URL
 *   4. Creates (or replaces) the GitHub release and uploads everything
 *
 * Usage:
 *   TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/cortex-ide.key) npm run tauri:build
 *   node scripts/release.mjs
 *
 * Or via the combined script:
 *   npm run ship
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyNativeBundle } from './native-bundle.mjs';
import { verifyNextAppSidecar } from './next/verify-app-bundle.mjs';
import { runShipWorkflow } from './lib/ship-broadcast.mjs';
import { warmUpdatePublication } from './lib/release-update-warmup.mjs';
import { buildReleaseManifest } from './lib/release-manifest.mjs';
import {
  resolveMacosReleaseArtifacts,
  resolveMacosCpuArtifacts,
  verifyMacCpuUpdaterArchive,
  verifyMacosDmgMatchesApp,
  verifyUniversalMacUpdaterArchive,
} from './lib/macos-release-artifacts.mjs';
import { assertCpuPreparationCurrent, macosCpuPackageArchitectures } from './lib/macos-cpu-packages.mjs';
import { verifyUpdaterSignature } from './lib/updater-signature.mjs';
import { acquirePublicationLock } from './lib/release-publication.mjs';
import { assertLinuxArtifactChannels } from './lib/linux-build-channel.mjs';
import { stableReleaseEffects } from './lib/stable-release-effects.mjs';
import { artifactChannel } from './lib/build-channel.mjs';
import { resolveReleaseChannel } from './lib/release-channel.mjs';

const REPO = 'o8-run/o8';
const PUBLIC_MIRROR = 'hurttlocker/o8-releases';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister';
const CHECKOUT_NATIVE_MODULES = ['better-sqlite3', 'node-pty'];
const root = process.cwd();
const cpuArchitectures = macosCpuPackageArchitectures(process.env.O8_MACOS_CPU_PACKAGES);

function runCheckoutNativeModuleGate(checkoutRoot) {
  const script = `
for (const moduleName of process.argv.slice(1)) {
  try {
    const resolved = require.resolve(moduleName);
    require(moduleName);
    console.log('[release] checkout native module ' + moduleName + ' resolved to ' + resolved);
  } catch (error) {
    console.error('[release] FATAL: checkout native module ' + moduleName + ' failed to resolve or load: ' + error.message);
    process.exitCode = 1;
  }
}`;
  execFileSync(process.execPath, ['-e', script, ...CHECKOUT_NATIVE_MODULES], {
    cwd: checkoutRoot,
    stdio: 'inherit',
  });
}

function runNativeGate(serverRoot) {
  verifyNativeBundle(serverRoot);
  console.log('[release] native addon ABI + architecture gate passed');
}

if (process.argv[2] === '--verify-native-bundle') {
  const target = process.argv[3];
  if (!target) {
    console.error('[release] usage: node scripts/release.mjs --verify-native-bundle <server-root>');
    process.exit(1);
  }
  try {
    runNativeGate(resolve(target));
    process.exit(0);
  } catch (error) {
    console.error(`[release] FATAL: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[2] === '--verify-checkout-native-modules') {
  const target = resolve(process.argv[3] || root);
  try {
    runCheckoutNativeModuleGate(target);
    process.exit(0);
  } catch {
    console.error(`[release] FATAL: checkout native module verification failed in ${target}`);
    process.exit(1);
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
let releaseChannel;
try {
  const expected = version.includes('-preview.') ? 'preview' : 'stable';
  releaseChannel = resolveReleaseChannel(version, { O8_RELEASE_CHANNEL: expected, O8_RELEASE_CLOBBER: process.env.O8_RELEASE_CLOBBER });
  if (!process.argv.includes('--dry-run') && process.argv[2] !== '--ship') artifactChannel(root, version, expected);
} catch (error) {
  console.error(`[release] ${error.message}`);
  process.exit(1);
}
const tag = releaseChannel.tag;
const dryRun = process.argv.includes('--dry-run');
const dryRunOutDir = optionValue('--out-dir') || join(tmpdir(), 'o8-public-release-out');
const stable = stableReleaseEffects({ root, version, tag });
const { publishPublicRelease, resolvePublishedAt, composeReleaseAnnouncement,
  announceRelease, releaseMetadataRange } = stable;
function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

// The authoring toolchain stays pinned to Node 22 via package.json + .nvmrc.
// Runtime ABI compatibility is independent of this guard: tauri-export now
// downloads and gates the Node 22 + 24 better-sqlite3 prebuilds explicitly.
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor !== 22) {
  console.error(`[release] FATAL: builds must run on Node 22 LTS (current: ${process.version})`);
  console.error(`[release] Run \`nvm use\` (reads .nvmrc) then retry npm run ship.`);
  process.exit(1);
}

if (dryRun) {
  try {
    if (releaseChannel.preview) {
      console.log(JSON.stringify(releaseChannel, null, 2));
      process.exit(0);
    }
    publishPublicRelease({
      publishedAt: resolvePublishedAt(),
      dryRun: true,
      outDir: dryRunOutDir,
    });
    process.exit(0);
  } catch (error) {
    console.error(`[release] dry run failed: ${error?.message ?? error}`);
    process.exit(1);
  }
}

if (releaseChannel.preview && (process.argv.includes('--announce') || process.argv.includes('--announce-preview'))) {
  console.error('[release] Stable announcements are disabled for preview releases.');
  process.exit(1);
}

if (process.argv[2] === '--ship') {
  try {
    await runShipWorkflow({ root, version });
    process.exit(0);
  } catch (error) {
    console.error(`[release] ship failed: ${error?.message ?? error}`);
    process.exit(1);
  }
}

// Resolve once before publication effects so every artifact uses the same
// verified baseline, including when this candidate is published mid-process.
if (!releaseChannel.preview) releaseMetadataRange();

// `npm run ship` detaches stale DMGs before this script. Garbage-collect their
// LaunchServices claims before publishing so dead o8:// handlers do not accrue.
if (process.platform === 'darwin') {
  try {
    execFileSync(LSREGISTER, ['-gc'], { stdio: 'ignore' });
    console.log('[release] garbage-collected stale LaunchServices registrations');
  } catch (error) {
    console.warn(`[release] LaunchServices garbage collection skipped: ${error?.message ?? error}`);
  }
}

// Manual community-announce path: preview prints, announce posts. For backfill
// (a release that shipped before the webhook existed) or a re-run after a
// Discord hiccup. The full ship flow calls announceRelease() automatically.
if (process.argv[2] === '--announce-preview' || process.argv[2] === '--announce') {
  const preview = composeReleaseAnnouncement();
  console.log(preview.content);
  console.log(`\n[preview] ${preview.ping ? '@everyone WILL ping' : 'no ping'} — ${preview.reason}`);
  if (process.argv[2] === '--announce') {
    await announceRelease();
  }
  process.exit(0);
}

try {
  const headTag = execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { encoding: 'utf8' }).trim();
  if (headTag !== tag) {
    console.warn(`[release] WARNING: HEAD is ${headTag}, not ${tag}; fixed-report receipts will scan ${releaseMetadataRange()}.`);
  }
} catch {
  console.warn(`[release] WARNING: HEAD is not ${tag}; fixed-report receipts will scan ${releaseMetadataRange()}.`);
}

const artifacts = resolveMacosReleaseArtifacts(root, version);
const BUNDLE = artifacts.bundleDir;
const DMG = artifacts.dmg;
const APP_TAR = artifacts.updaterArchive;
const APP_SIG = artifacts.updaterSignature;

for (const path of [DMG, APP_TAR, APP_SIG]) {
  if (!existsSync(path)) {
    console.error(`[release] missing artifact: ${path}`);
    console.error(`[release] Run this first:`);
    console.error('[release]   npm run tauri:build:stable-macos');
    process.exit(1);
  }
}

let darwinIdentity;
try {
  darwinIdentity = verifyUniversalMacUpdaterArchive(artifacts.app, APP_TAR);
  verifyNextAppSidecar(artifacts.app);
  console.log('[release] universal macOS updater archive gate passed', JSON.stringify(darwinIdentity));
} catch (error) {
  console.error(`[release] FATAL: ${error.message}`);
  console.error('[release] Refusing to publish either Darwin updater entry without an archive matching the verified x86_64 + arm64 app and sidecar slices.');
  process.exit(1);
}

try {
  const signatureIdentity = verifyUpdaterSignature(root, APP_TAR, APP_SIG);
  if (signatureIdentity.artifactSha256 !== darwinIdentity.updaterArchiveSha256) {
    throw new Error('verified updater signature identity does not match the inspected updater archive');
  }
  console.log('[release] updater signature gate passed', JSON.stringify(signatureIdentity));
} catch (error) {
  console.error(`[release] FATAL: ${error.message}`);
  console.error('[release] Refusing to publish an updater archive without a valid signature from the configured updater key.');
  process.exit(1);
}

try {
  const dmgIdentity = verifyMacosDmgMatchesApp(artifacts.app, DMG, version);
  console.log('[release] macOS installer identity gate passed', JSON.stringify(dmgIdentity));
} catch (error) {
  console.error(`[release] FATAL: ${error.message}`);
  console.error('[release] Refusing to publish a DMG that does not contain the same signed, versioned universal app.');
  process.exit(1);
}

const PACKAGED_SERVER = join(artifacts.app, 'Contents', 'Resources', 'server');
try {
  runNativeGate(PACKAGED_SERVER);
} catch (error) {
  console.error(`[release] FATAL: ${error.message}`);
  console.error('[release] Refusing to publish without Node 22 + 24, x64 + arm64 prebuilds for both native addons.');
  process.exit(1);
}

try {
  runCheckoutNativeModuleGate(root);
} catch {
  console.error(`[release] FATAL: checkout native module verification failed in ${root}`);
  console.error('[release] Refusing to publish because the local ship changed the checkout dependency state.');
  process.exit(1);
}

// #1163: OPT-IN. The gate launches a disposable 2nd o8.app copy from /tmp that
// intermittently PANICS (resource-dir / wry event loop) → macOS crash-report
// dialogs at the operator + false-blocked ships. Disabled by default until it's
// redesigned to drive the running app / a headless WKWebView harness. The
// author-time #1160 ESLint guard + directive cover the 0.1.252 class meanwhile.
// Re-enable with O8_PRESHIP_GATE_ENABLED=1; O8_GATE_STRICT=1 additionally hard-blocks.
let gateWarnFailed = false;
if (process.env.O8_PRESHIP_GATE_ENABLED === '1') {
  try {
    execFileSync('node', ['scripts/preship-webview-gate.mjs', '--mode=authoritative', APP_TAR], { stdio: 'inherit' });
  } catch {
    if (process.env.O8_GATE_STRICT === '1') {
      console.error('[release] pre-ship boot gate FAILED (O8_GATE_STRICT) — refusing to publish.');
      process.exit(1);
    }
    gateWarnFailed = true;
    console.warn('[release] WARNING: pre-ship boot gate failed (warn-only, #1163). Publishing anyway.');
  }
} else {
  console.log('[release] pre-ship boot gate skipped (opt-in via O8_PRESHIP_GATE_ENABLED=1; disabled by default — spawns a crashing GUI child, #1163).');
}

const signature = readFileSync(APP_SIG, 'utf8').trim();
let darwinCpuArtifacts;
if (cpuArchitectures.length) {
  try {
    darwinCpuArtifacts = cpuArchitectures.map((architecture) => {
      const cpu = resolveMacosCpuArtifacts(root, version, architecture);
      assertCpuPreparationCurrent(root, version, architecture);
      const identity = verifyMacCpuUpdaterArchive(cpu.app, cpu.updaterArchive, architecture);
      const signatureIdentity = verifyUpdaterSignature(root, cpu.updaterArchive, cpu.updaterSignature);
      artifactChannel(root, version, releaseChannel.channel, cpu);
      if (signatureIdentity.artifactSha256 !== identity.updaterArchiveSha256) {
        throw new Error(`${architecture} updater signature identity mismatch`);
      }
      verifyMacosDmgMatchesApp(cpu.app, cpu.dmg, version, architecture);
      execFileSync('xcrun', ['stapler', 'validate', cpu.app], { stdio: 'pipe' });
      execFileSync('xcrun', ['stapler', 'validate', cpu.dmg], { stdio: 'pipe' });
      runNativeGate(join(cpu.app, 'Contents', 'Resources', 'server'));
      return {
        architecture,
        signature: readFileSync(cpu.updaterSignature, 'utf8').trim(),
        identity: { ...identity, sourceBundleSha256: darwinIdentity.bundleSha256 },
        archivePath: cpu.updaterArchive, signaturePath: cpu.updaterSignature, dmgPath: cpu.dmg,
      };
    });
  } catch (error) {
    console.error(`[release] FATAL: CPU package verification failed: ${error.message}`);
    console.error('[release] Refusing partial or unverified CPU delivery; the universal artifacts remain intact.');
    process.exit(1);
  }
}
const pubDate = new Date().toISOString();
// Point latest.json download URLs at the PUBLIC MIRROR so the Tauri updater
// can fetch artifacts anonymously. The private repo (REPO) returns 404 for
// anonymous download requests even when the release is published.
const downloadBase = `https://github.com/${PUBLIC_MIRROR}/releases/download/${tag}`;
const gateReleaseNotePath = join(BUNDLE, 'macos', 'preship-webview-gate-release-note.txt');
const gateReleaseNote = existsSync(gateReleaseNotePath)
  ? readFileSync(gateReleaseNotePath, 'utf8').trim()
  : '';
const warnStamp = gateWarnFailed
  ? '\n\ngate:warn-failed — pre-ship boot gate did not pass; shipped warn-only per #1163.'
  : '';
const creditLine = stable.creditLine();
const releaseNotes = (gateReleaseNote
  ? `o8 ${tag} — see installer assets.\n\n${gateReleaseNote}`
  : `o8 ${tag} — see installer assets.`) + (creditLine ? `\n\n${creditLine}` : '') + warnStamp;
const latestNotes = gateReleaseNote ? `o8 ${tag} — ${gateReleaseNote}` : `o8 ${tag}`;

// Universal delivery stays the default and its artifacts always remain in
// the upload list. CPU delivery requires both independently verified packages.
const latestJsonPath = join(BUNDLE, 'macos', releaseChannel.manifestName);
const fixedJsonPath = join(BUNDLE, 'macos', 'fixed.json');
acquirePublicationLock();
const { latestJson, uploadArgs } = buildReleaseManifest({
  // Linux preview artifacts are produced separately under the non-targeted
  // Cargo bundle directory. Keep discovering them there while macOS uses the
  // explicit universal target directory.
  bundleDir: join(root, 'src-tauri/target/release/bundle'),
  version,
  notes: latestNotes,
  pubDate,
  downloadBase,
  darwinArtifact: { signature, identity: darwinIdentity },
  darwinCpuArtifacts,
  baseUploadAssets: [DMG, APP_TAR, APP_SIG],
  trailingUploadAssets: [latestJsonPath, ...(releaseChannel.publishStableEffects ? [fixedJsonPath] : [])],
});
assertLinuxArtifactChannels(root, version, releaseChannel.channel, uploadArgs);
latestJson.channel = releaseChannel.channel;
writeFileSync(latestJsonPath, JSON.stringify(latestJson, null, 2));
console.log(`[release] wrote ${latestJsonPath}`);

// fixed.json — the receipt manifest, shipped next to latest.json.
//
// The reporter's own app downloads this (public, anonymous, same URL pattern the
// updater already uses — no new infrastructure, no cost) and joins it against
// its LOCAL ledger to tell them their bug is fixed. It never uploads anything.
//
// CUMULATIVE on purpose: a per-release list would lose a fix for anyone who skips
// versions. Contains no reporter handles — the app only needs "was MY report
// fixed, and in which version".
// Mirror the intake channel into the local ledger first — a user's report was
// recorded on THEIR machine, not ours, so without this every fix we ship for
// someone else's bug resolves to "unknown id" and never reaches fixed.json.
if (releaseChannel.publishStableEffects) await stable.prepareFixed(fixedJsonPath, pubDate);

try {
  execFileSync('git', ['ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`], { stdio: 'pipe' });
  console.log(`[release] tag ${tag} present on origin`);
} catch {
  console.error(`[release] tag ${tag} is not on origin.`);
  console.error(`[release] After the version PR merges, push its exact tag: git push origin refs/tags/${tag}:refs/tags/${tag}`);
  process.exit(1);
}

let releaseExists = false;
try {
  execFileSync('gh', ['release', 'view', tag, '-R', REPO], { stdio: 'pipe' });
  releaseExists = true;
} catch {}

// #1486 — an existing release for the CURRENT version almost always means the
// operator forgot `npm version patch`: silently replacing the published
// assets under the same tag re-signs history and updaters never see a new
// build (the 2026-07-08 #1499 incident). Refuse unless explicitly overridden.
if (releaseExists && process.env.O8_RELEASE_CLOBBER !== '1') {
  console.error(`[release] REFUSING: ${tag} is already published. Did you forget to bump?`);
  console.error('[release]   Prepare a fresh version PR with npm version patch --no-git-tag-version.');
  console.error('[release]   Merge after required checks, verify merged main, then create the exact version tag.');
  console.error('[release]   release_version=$(node -p "require(\'./package.json\').version")');
  console.error('[release]   git push origin "refs/tags/v${release_version}:refs/tags/v${release_version}"');
  console.error('[release]   npm run ship');
  console.error('[release] To deliberately replace the existing release assets in place:');
  console.error('[release]   O8_RELEASE_CLOBBER=1 npm run ship');
  process.exit(1);
}

let mirrorNotes = `o8 ${tag} is published. See the release history for details.`;
try {
  mirrorNotes = stable.prepareNotes();
} catch { console.warn('[release] Public summary preparation unavailable; publishing the release fallback.'); }
if (gateReleaseNote) mirrorNotes += `\n\n${gateReleaseNote}`;

if (releaseExists) {
  console.log(`[release] ${tag} already exists — replacing assets (O8_RELEASE_CLOBBER=1)`);
  execFileSync('gh', [
    'release', 'edit', tag,
    '--title', `o8 ${tag}`,
    '--notes', releaseNotes,
    ...releaseChannel.githubFlags,
    '-R', REPO,
  ], { stdio: 'inherit' });
  execFileSync('gh', [
    'release', 'upload', tag, ...uploadArgs,
    '--clobber',
    '-R', REPO,
  ], { stdio: 'inherit' });
} else {
  console.log(`[release] creating ${tag}`);
  execFileSync('gh', [
    'release', 'create', tag, ...uploadArgs,
    '--title', `o8 ${tag}`,
    '--notes', releaseNotes,
    ...releaseChannel.githubFlags,
    '-R', REPO,
  ], { stdio: 'inherit' });
}

console.log(`[release] published ${tag}`);

// Mirror artifacts to the public repo so the Tauri updater can fetch
// latest.json + the .app.tar.gz anonymously. The private REPO is the source
// of truth for code + full release notes; PUBLIC_MIRROR only carries the
// updater payload. Failures here are logged but non-fatal — the private
// publish above already succeeded.
try {
  let mirrorExists = false;
  try {
    execFileSync('gh', ['release', 'view', tag, '-R', PUBLIC_MIRROR], { stdio: 'pipe' });
    mirrorExists = true;
  } catch {}

  if (mirrorExists) {
    if (releaseChannel.preview) {
      throw new Error('Preview mirror artifacts already exist; use a new preview version.');
    }
    console.log(`[release-mirror] ${tag} already exists on ${PUBLIC_MIRROR} — replacing assets`);
    execFileSync('gh', [
      'release', 'edit', tag,
      '--title', `o8 ${tag}`,
      '--notes', mirrorNotes,
      ...releaseChannel.githubFlags,
      '-R', PUBLIC_MIRROR,
    ], { stdio: 'inherit' });
    execFileSync('gh', [
      'release', 'upload', tag, ...uploadArgs,
      '--clobber',
      '-R', PUBLIC_MIRROR,
    ], { stdio: 'inherit' });
  } else {
    console.log(`[release-mirror] creating ${tag} on ${PUBLIC_MIRROR}`);
    execFileSync('gh', [
      'release', 'create', tag, ...uploadArgs,
      '--title', `o8 ${tag}`,
      '--notes', mirrorNotes,
      ...releaseChannel.githubFlags,
      '-R', PUBLIC_MIRROR,
    ], { stdio: 'inherit' });
  }

  console.log(`[release-mirror] mirrored ${tag} to ${PUBLIC_MIRROR}`);

  if (releaseChannel.preview) {
    console.log('[release] Preview published for explicit tag downloads; the stable updater and announcements are unchanged.');
    process.exit(0);
  }
  try {
    const receipt = await warmUpdatePublication({ root, version,
      previousVersion: releaseMetadataRange().split('..')[0].replace(/^v/, ''),
      publishedAt: resolvePublishedAt(pubDate) });
    const timing = receipt.publishToOfferMs === null ? 'unverified' : `${receipt.publishToOfferMs}ms`;
    console.log(`[release] update publication ${receipt.status}; publish-to-offer ${timing}; within-five-minutes=${receipt.withinPublishToOfferBudget ?? 'unverified'}`);
  } catch {
    console.warn('[release] update publication verification unavailable; no fresh-offer receipt was recorded.');
  }
  await stable.complete(pubDate);
} catch (err) {
  console.error(`[release-mirror] failed to mirror ${tag} to ${PUBLIC_MIRROR}:`, err?.message ?? err);
  console.error(`[release-mirror] private publish above is unaffected — auto-update will not pick up this version until the mirror succeeds`);
  if (releaseChannel.preview) process.exit(1);
}

console.log(`[release] the installed o8.app will pick up the update on next launch`);
console.log(`[release] (or within 30 min via the UpdateBanner poll).`);
