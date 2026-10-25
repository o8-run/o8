import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MACOS_REQUIRED_BINARIES } from './macos-release-artifacts.mjs';

function listFiles(directory, suffix) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => join(directory, entry.name))
    .sort();
}

// The Linux build produces a local AppImage named "o8_<version>_amd64.AppImage"
// (see tests/release-artifacts.test.ts fixtures), but the publish-preview job
// in .github/workflows/port-build.yml re-uploads it under a different name:
// "o8_<version>_linux_amd64_preview.AppImage". The updater manifest url must
// point at the name the asset is actually published under, not the local
// build's basename.
const LINUX_APPIMAGE_NAME_PATTERN = /^o8_(.+)_amd64\.AppImage$/;

export function publishedLinuxAssetName(version) {
  return `o8_${version}_linux_amd64_preview.AppImage`;
}

// Single definition of the linux-x86_64 updater entry, shared by the local
// ship path (which discovers a locally built + signed AppImage) and the
// operator-invoked signing step for a CI-published AppImage.
export function linuxUpdaterPlatform({ version, signature, downloadBase }) {
  return {
    signature,
    url: `${downloadBase}/${publishedLinuxAssetName(version)}`,
  };
}

function assertLinuxAppImageVersionMatches(artifactPath, version) {
  const name = basename(artifactPath);
  const match = name.match(LINUX_APPIMAGE_NAME_PATTERN);
  if (!match) {
    throw new Error(
      `Linux AppImage release artifact "${name}" does not match the expected "o8_<version>_amd64.AppImage" naming pattern`,
    );
  }
  const [, appImageVersion] = match;
  if (appImageVersion !== version) {
    throw new Error(
      `Linux AppImage version "${appImageVersion}" (from "${name}") does not match release version "${version}"`,
    );
  }
}

function discoverLinuxArtifacts(bundleDir) {
  const appImageDir = join(bundleDir, 'appimage');
  const appImages = listFiles(appImageDir, '.AppImage');
  const signatures = listFiles(appImageDir, '.AppImage.sig');
  const signedAppImages = appImages
    .map((artifactPath) => ({ artifactPath, signaturePath: `${artifactPath}.sig` }))
    .filter(({ signaturePath }) => existsSync(signaturePath));

  if (appImages.length !== signedAppImages.length || signatures.length !== signedAppImages.length) {
    throw new Error('Linux AppImage release artifacts must include one matching .AppImage.sig file per AppImage');
  }
  if (signedAppImages.length > 1) {
    throw new Error('Expected at most one signed Linux AppImage release artifact');
  }

  const updater = signedAppImages[0] ?? null;
  const uploadAssets = updater
    ? [updater.artifactPath, updater.signaturePath]
    : [];
  uploadAssets.push(...listFiles(join(bundleDir, 'deb'), '.deb'));

  return { updater, uploadAssets };
}

function assertUniversalDarwinArtifact(artifact) {
  if (!artifact || typeof artifact.signature !== 'string' || artifact.signature.trim() === '') {
    throw new Error('macOS updater artifact is missing its signature');
  }
  if (artifact.identity?.kind !== 'macos-universal-app') {
    throw new Error('macOS updater artifact identity must come from a universal app inspection');
  }
  for (const architecture of ['x86_64', 'arm64']) {
    if (!artifact.identity.architectures?.includes(architecture)) {
      throw new Error(`macOS updater artifact identity is missing ${architecture}`);
    }
  }
}

function cpuDarwinPlatforms(artifacts, universal, version, downloadBase) {
  if (!Array.isArray(artifacts) || ![1, 2].includes(artifacts.length)
    || new Set(artifacts.map((artifact) => artifact?.architecture)).size !== artifacts.length
    || artifacts.some((artifact) => !['x86_64', 'arm64'].includes(artifact?.architecture))) {
    throw new Error('CPU packages require one artifact per selected macOS architecture');
  }
  const platforms = {};
  const uploadAssets = [];
  for (const architecture of ['x86_64', 'arm64']) {
    const artifact = artifacts.find((candidate) => candidate.architecture === architecture);
    if (!artifact) continue;
    const identity = artifact.identity;
    if (identity?.kind !== 'macos-cpu-app' || identity.architectures?.length !== 1
      || identity.architectures[0] !== architecture
      || identity.binaries?.length !== MACOS_REQUIRED_BINARIES.length
      || !MACOS_REQUIRED_BINARIES.every((path) => identity.binaries.some((binary) =>
        binary.relativePath === path && binary.architectures?.length === 1 && binary.architectures[0] === architecture))) {
      throw new Error(`${architecture} CPU artifact identity is incomplete or mismatched`);
    }
    if (!/^[a-f0-9]{64}$/.test(universal.identity.bundleSha256 ?? '')
      || identity.sourceBundleSha256 !== universal.identity.bundleSha256) {
      throw new Error(`${architecture} CPU artifact has a different universal source identity`);
    }
    if (typeof artifact.signature !== 'string' || !artifact.signature.trim()
      || !/^[a-f0-9]{64}$/.test(identity.updaterArchiveSha256 ?? '')
      || !/^[a-f0-9]{64}$/.test(identity.bundleSha256 ?? '')) {
      throw new Error(`${architecture} CPU artifact requires a verified archive and signature`);
    }
    const name = `o8_${architecture}.app.tar.gz`;
    if (typeof artifact.archivePath !== 'string' || basename(artifact.archivePath) !== name
      || artifact.signaturePath !== `${artifact.archivePath}.sig`
      || typeof artifact.dmgPath !== 'string' || basename(artifact.dmgPath) !== `o8_${version}_${architecture}.dmg`) {
      throw new Error(`${architecture} CPU artifact filenames do not match the release`);
    }
    platforms[architecture === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64'] = {
      signature: artifact.signature, url: `${downloadBase}/${name}`,
    };
    uploadAssets.push(artifact.dmgPath, artifact.archivePath, artifact.signaturePath);
  }
  return { platforms, uploadAssets };
}

export function buildReleaseManifest({
  bundleDir,
  version,
  notes,
  pubDate,
  downloadBase,
  darwinArtifact,
  darwinCpuArtifacts,
  baseUploadAssets = [],
  trailingUploadAssets = [],
}) {
  assertUniversalDarwinArtifact(darwinArtifact);
  const linux = discoverLinuxArtifacts(bundleDir);
  let platforms = {
    'darwin-x86_64': {
      signature: darwinArtifact.signature,
      url: `${downloadBase}/o8.app.tar.gz`,
    },
    'darwin-aarch64': {
      signature: darwinArtifact.signature,
      url: `${downloadBase}/o8.app.tar.gz`,
    },
  };
  let cpuUploadAssets = [];
  if (darwinCpuArtifacts !== undefined) {
    const cpu = cpuDarwinPlatforms(darwinCpuArtifacts, darwinArtifact, version, downloadBase);
    platforms = { ...platforms, ...cpu.platforms };
    cpuUploadAssets = cpu.uploadAssets;
  }

  if (linux.updater) {
    assertLinuxAppImageVersionMatches(linux.updater.artifactPath, version);
    platforms['linux-x86_64'] = linuxUpdaterPlatform({
      version,
      signature: readFileSync(linux.updater.signaturePath, 'utf8').trim(),
      downloadBase,
    });
  }

  return {
    latestJson: {
      version,
      notes,
      pub_date: pubDate,
      platforms,
    },
    uploadArgs: [
      ...baseUploadAssets,
      ...cpuUploadAssets,
      ...linux.uploadAssets,
      ...trailingUploadAssets,
    ],
  };
}
