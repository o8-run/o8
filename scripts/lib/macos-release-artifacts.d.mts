export const MACOS_RELEASE_TARGET: 'universal-apple-darwin';
export const MACOS_RELEASE_ARCHITECTURES: readonly ['x86_64', 'arm64'];
export const MACOS_REQUIRED_BINARIES: readonly string[];
export type MacosArchitecture = 'x86_64' | 'arm64';

export interface MacosReleaseArtifacts {
  target: typeof MACOS_RELEASE_TARGET;
  bundleDir: string;
  app: string;
  updaterArchive: string;
  updaterSignature: string;
  dmg: string;
}

export interface MacosUniversalArtifactIdentity {
  kind: 'macos-universal-app';
  architectures: Array<'x86_64' | 'arm64'>;
  binaries: Array<{
    relativePath: string;
    architectures: Array<'x86_64' | 'arm64'>;
    sha256: string;
  }>;
  bundleSha256?: string;
  updaterArchiveSha256?: string;
}

export interface MacosCpuArtifactIdentity extends Omit<MacosUniversalArtifactIdentity, 'kind'> {
  kind: 'macos-cpu-app';
  architectures: [MacosArchitecture];
}

export interface MacosCpuArtifacts extends MacosReleaseArtifacts {
  architecture: MacosArchitecture;
}

export function assertMacosArchitecture(architecture: string): MacosArchitecture;
export function resolveMacosCpuArtifacts(root: string, version: string, architecture: MacosArchitecture): MacosCpuArtifacts;
export function bundleContentSha256(appPath: string, excludedPaths?: readonly string[]): string;
export function macosSharedResourcesSha256(appPath: string): string;
export function macosExecutablePayloadSha256(path: string, architecture: MacosArchitecture): string;
export function macosBuildPayloadIdentity(path: string, architecture: MacosArchitecture, payloadBytes?: number): {
  sha256: string;
  payloadBytes: number;
};
export function verifyMacCpuApp(appPath: string, architecture: MacosArchitecture): MacosCpuArtifactIdentity;
export function verifyMacCpuUpdaterArchive(appPath: string, archivePath: string, architecture: MacosArchitecture): MacosCpuArtifactIdentity & {
  bundleSha256: string;
  updaterArchiveSha256: string;
};

export function readMachOArchitectures(path: string): Array<'x86_64' | 'arm64'>;
export function resolveMacosReleaseArtifacts(root: string, version: string): MacosReleaseArtifacts;
export function stageMacosDmgApp(appPath: string, stagingPath: string): void;
export function verifyUniversalMacApp(appPath: string): MacosUniversalArtifactIdentity;
export function verifyUniversalMacUpdaterArchive(
  appPath: string,
  archivePath: string,
): MacosUniversalArtifactIdentity & { bundleSha256: string; updaterArchiveSha256: string };
export function verifyMacosDmgMatchesApp(
  appPath: string,
  dmgPath: string,
  version: string,
): MacosUniversalArtifactIdentity & {
  bundleVersion: string;
  bundleSha256: string;
  dmgSha256: string;
};
export function verifyMacosDmgMatchesApp(
  appPath: string,
  dmgPath: string,
  version: string,
  architecture: MacosArchitecture,
): MacosCpuArtifactIdentity & { bundleVersion: string; bundleSha256: string; dmgSha256: string };
