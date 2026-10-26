export interface ReleaseUpdaterPlatform {
  signature: string;
  url: string;
}

export interface ReleaseUpdaterManifest {
  channel?: 'beta';
  installers?: Array<{ url: string; sha256: string }>;
  version: string;
  notes: string;
  pub_date: string;
  platforms: {
    'darwin-x86_64': ReleaseUpdaterPlatform;
    'darwin-aarch64': ReleaseUpdaterPlatform;
    'linux-x86_64'?: ReleaseUpdaterPlatform;
  };
}

export function publishedLinuxAssetName(version: string): string;

export function linuxUpdaterPlatform(options: {
  version: string;
  signature: string;
  downloadBase: string;
}): ReleaseUpdaterPlatform;

export interface BuildReleaseManifestOptions {
  bundleDir: string;
  version: string;
  notes: string;
  pubDate: string;
  downloadBase: string;
  darwinArtifact: {
    signature: string;
    identity: import('./macos-release-artifacts.mjs').MacosUniversalArtifactIdentity;
  };
  darwinCpuArtifacts?: Array<{
    architecture: import('./macos-release-artifacts.mjs').MacosArchitecture;
    signature: string;
    identity: import('./macos-release-artifacts.mjs').MacosCpuArtifactIdentity & { sourceBundleSha256: string };
    archivePath: string;
    signaturePath: string;
    dmgPath: string;
  }>;
  baseUploadAssets?: string[];
  trailingUploadAssets?: string[];
}

export function buildReleaseManifest(options: BuildReleaseManifestOptions): {
  latestJson: ReleaseUpdaterManifest;
  uploadArgs: string[];
};
