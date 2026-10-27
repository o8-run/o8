#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { assertLinuxArtifactChannels } from './lib/linux-build-channel.mjs';
import { artifactChannel } from './lib/build-channel.mjs';
import {
  verifyUniversalMacUpdaterArchive,
  verifyMacosDmgMatchesApp,
  resolveMacosCpuArtifacts,
  verifyMacCpuUpdaterArchive,
} from './lib/macos-release-artifacts.mjs';
import { verifyUpdaterSignature } from './lib/updater-signature.mjs';
import { verifyNextAppSidecar } from './next/verify-app-bundle.mjs';
import { verifyNativeBundle } from './native-bundle.mjs';
import {
  macosCpuPackageArchitectures,
  assertCpuPreparationCurrent,
} from './lib/macos-cpu-packages.mjs';
import { buildReleaseManifest } from './lib/release-manifest.mjs';
import {
  acquirePublicationLock,
  BETA_FEED_TAG,
  compareVersions,
} from './lib/release-publication.mjs';
import { DEFAULT_REPOS } from './lib/linux-appimage-signature.mjs';

function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--dry-run'))
    throw new Error('Unknown publication option.');
  const root = process.cwd(),
    version = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ).version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error('Invalid candidate version.');
  const { artifacts, identity } = artifactChannel(root, version, 'beta');
  const universal = verifyUniversalMacUpdaterArchive(
    artifacts.app,
    artifacts.updaterArchive,
  );
  verifyNextAppSidecar(artifacts.app);
  verifyMacosDmgMatchesApp(artifacts.app, artifacts.dmg, version);
  verifyNativeBundle(join(artifacts.app, 'Contents/Resources/server'));
  execFileSync(
    process.execPath,
    ['scripts/release.mjs', '--verify-checkout-native-modules', root],
    { stdio: 'pipe' },
  );
  const cpus = macosCpuPackageArchitectures(
    process.env.O8_MACOS_CPU_PACKAGES,
  ).map((architecture) => {
    const cpu = resolveMacosCpuArtifacts(root, version, architecture);
    assertCpuPreparationCurrent(root, version, architecture);
    const archive = verifyMacCpuUpdaterArchive(
      cpu.app,
      cpu.updaterArchive,
      architecture,
    );
    verifyUpdaterSignature(root, cpu.updaterArchive, cpu.updaterSignature);
    artifactChannel(root, version, 'beta', cpu);
    verifyMacosDmgMatchesApp(cpu.app, cpu.dmg, version, architecture);
    execFileSync('xcrun', ['stapler', 'validate', cpu.app], { stdio: 'pipe' });
    execFileSync('xcrun', ['stapler', 'validate', cpu.dmg], { stdio: 'pipe' });
    verifyNativeBundle(join(cpu.app, 'Contents/Resources/server'));
    return {
      architecture,
      signature: readFileSync(cpu.updaterSignature, 'utf8').trim(),
      identity: { ...archive, sourceBundleSha256: universal.bundleSha256 },
      archivePath: cpu.updaterArchive,
      signaturePath: cpu.updaterSignature,
      dmgPath: cpu.dmg,
    };
  });
  if (process.argv.includes('--dry-run')) {
    console.log(
      JSON.stringify({
        channel: identity.channel,
        version,
        manifestName: 'beta.json',
        publishStableEffects: false,
      }),
    );
    return;
  }
  const path = join(artifacts.bundleDir, 'macos/beta.json');
  const { latestJson, uploadArgs } = buildReleaseManifest({
    bundleDir: join(root, 'src-tauri/target/release/bundle'),
    version,
    notes: `o8 v${version}`,
    pubDate: new Date().toISOString(),
    downloadBase: `https://github.com/${DEFAULT_REPOS[1]}/releases/download/v${version}`,
    darwinArtifact: {
      signature: readFileSync(artifacts.updaterSignature, 'utf8').trim(),
      identity: universal,
    },
    darwinCpuArtifacts: cpus.length ? cpus : undefined,
    baseUploadAssets: [
      artifacts.dmg,
      artifacts.updaterArchive,
      artifacts.updaterSignature,
    ],
    trailingUploadAssets: [path],
  });
  assertLinuxArtifactChannels(root, version, identity.channel, uploadArgs);
  latestJson.channel = identity.channel;
  latestJson.buildIdentity = identity;
  latestJson.installers = uploadArgs.filter(path => /\.(dmg|AppImage)$/.test(path)).map(path => ({
    url: path.endsWith('.AppImage') ? latestJson.platforms['linux-x86_64'].url
      : new URL(basename(path), latestJson.platforms['darwin-aarch64'].url).href,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }));

  // One immutable candidate, one lock for all feed writers. Never generate stable receipts or announcements.
  const lock = acquirePublicationLock();
  let dir;
  try {
    writeFileSync(path, `${JSON.stringify(latestJson, null, 2)}\n`);
    dir = mkdtempSync(join(tmpdir(), 'o8-beta-feed-'));
    const anchors = DEFAULT_REPOS.map((repo) => {
      try {
        execFileSync('gh', ['release', 'view', `v${version}`, '--repo', repo], {
          stdio: 'pipe',
        });
      } catch {
        const feed = JSON.parse(
          execFileSync(
            'gh',
            [
              'release',
              'view',
              BETA_FEED_TAG,
              '--repo',
              repo,
              '--json',
              'tagName,isDraft,isPrerelease',
            ],
            { encoding: 'utf8', stdio: 'pipe' },
          ),
        );
        if (
          feed.tagName !== BETA_FEED_TAG ||
          feed.isDraft !== false ||
          feed.isPrerelease !== true
        )
          throw new Error(
            'A published prerelease beta feed anchor is required.',
          );
        return { repo, tag: BETA_FEED_TAG };
      }
      throw new Error('Candidate already exists; use a fresh version.');
    });
    for (const { repo, tag } of anchors) {
      const assets = JSON.parse(
        execFileSync(
          'gh',
          ['release', 'view', tag, '--repo', repo, '--json', 'assets'],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      );
      if (!Array.isArray(assets.assets))
        throw new Error('Feed inventory unavailable.');
      if (assets.assets.some((v) => v.name === 'beta.json')) {
        execFileSync(
          'gh',
          [
            'release',
            'download',
            tag,
            '--repo',
            repo,
            '--pattern',
            'beta.json',
            '--dir',
            dir,
            '--clobber',
          ],
          { stdio: 'pipe' },
        );
        const current = JSON.parse(
          readFileSync(join(dir, 'beta.json'), 'utf8'),
        );
        if (
          current.channel !== 'beta' ||
          compareVersions(version, current.version) <= 0
        )
          throw new Error('Refusing to replace or downgrade beta.');
      }
    }
    // Every destination has passed preflight before the first provider mutation.
    for (const { repo } of anchors)
      execFileSync(
        'gh',
        [
          'release',
          'create',
          `v${version}`,
          ...uploadArgs,
          '--prerelease',
          '--latest=false',
          '--repo',
          repo,
          '--title',
          `o8 v${version}`,
          '--notes',
          'Beta candidate.',
        ],
        { stdio: 'pipe' },
      );
    for (const { repo, tag } of anchors) {
      execFileSync(
        'gh',
        ['release', 'upload', tag, path, '--clobber', '--repo', repo],
        { stdio: 'pipe' },
      );
    }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    lock.release();
  }
}
try {
  main();
} catch (error) {
  console.error(`[release-beta] Publication refused: ${error.message}`);
  process.exitCode = 1;
}
