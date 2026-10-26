/**
 * Which update action an install can actually perform.
 *
 * Tauri v2 replaces a Linux binary in place only when the running app is an
 * AppImage: the AppImage runtime exports `APPIMAGE` with the path it was
 * started from, and the updater rewrites that file. A deb/rpm install has no
 * `APPIMAGE`, its binary sits under a root-owned prefix, and
 * `downloadAndInstall()` cannot land — restart-to-install is a dead end there.
 * macOS and Windows bundles keep the existing self-update path.
 *
 * One predicate (`isSelfUpdatableInstall`) decides that for every surface, so
 * the card, the background idle-apply loop, and the restart helper cannot
 * disagree about what an install is capable of.
 */

export type InstallPlatform = 'darwin' | 'linux' | 'win32' | 'unknown';

export interface InstallInfo {
  platform: InstallPlatform;
  /** Node-style arch of the running app ('x64', 'arm64', …), null when unknown. */
  arch: string | null;
  /** Path the AppImage was started from; null on every non-AppImage install. */
  appImagePath: string | null;
  /** Updater verdict when the shell knows it; null when it has no opinion. */
  updaterSelfUpdatable: boolean | null;
}

export type UpdateAction =
  | { kind: 'restart' }
  /** `packageManager`: a deb/rpm install, updated with apt or dnf; `url` is the release page. */
  | { kind: 'download'; url: string; packageManager?: true };

const RELEASES_BASE = 'https://github.com/o8-run/o8/releases';

export const RELEASES_LATEST_URL = `${RELEASES_BASE}/latest`;

export function normalizeInstallPlatform(value: unknown): InstallPlatform {
  if (value === 'darwin' || value === 'linux' || value === 'win32') return value;
  return 'unknown';
}

/** Release artifacts are named by package arch, not by the Node arch string. */
function packageArch(arch: string | null): 'amd64' | 'arm64' | null {
  if (!arch) return null;
  const normalized = arch.trim().toLowerCase();
  if (normalized === 'x64' || normalized === 'x86_64' || normalized === 'amd64') return 'amd64';
  if (normalized === 'arm64' || normalized === 'aarch64') return 'arm64';
  return null;
}

export function normalizeInstallInfo(payload: unknown): InstallInfo | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const arch = typeof record.arch === 'string' && record.arch.trim() ? record.arch.trim() : null;
  const appImagePath = typeof record.appImagePath === 'string' && record.appImagePath.trim()
    ? record.appImagePath.trim()
    : null;
  return {
    platform: normalizeInstallPlatform(record.platform),
    arch,
    appImagePath,
    updaterSelfUpdatable: typeof record.updaterSelfUpdatable === 'boolean'
      ? record.updaterSelfUpdatable
      : null,
  };
}

/**
 * True when the running install can replace itself and relaunch. Unknown
 * platforms fail OPEN (true) so a missing/failed install-info probe leaves the
 * shipped macOS behaviour exactly as it was.
 */
export function isSelfUpdatableInstall(info: InstallInfo): boolean {
  if (info.updaterSelfUpdatable === false) return false;
  if (info.platform === 'linux') return Boolean(info.appImagePath);
  return true;
}

/**
 * A Linux install that is not an AppImage came from a .deb or .rpm. Its
 * package manager owns the files, so the update card points at the release
 * page and the package manager instead of a download that replaces nothing.
 */
export function isPackageManagedInstall(info: InstallInfo): boolean {
  return info.platform === 'linux' && !info.appImagePath;
}

export function releasePageUrl(version: string | null): string {
  const bare = version?.trim().replace(/^v/, '') ?? '';
  return bare ? `${RELEASES_BASE}/tag/v${bare}` : RELEASES_LATEST_URL;
}

/**
 * Where a non-self-updatable install sends the operator. The release pipeline
 * publishes one signed x86_64 AppImage per release, and the publish-preview
 * job re-uploads it under a name that differs from the local build's basename
 * — `publishedLinuxAssetName` in `scripts/lib/release-manifest.mjs` is the one
 * source of that name, and `tests/linux-update-download.test.ts` pins this
 * helper to the url that builder emits. Any other arch gets the release page,
 * which lists whatever that build actually produced.
 */
export function releaseDownloadUrl(info: InstallInfo, version: string | null): string {
  const bare = version?.trim().replace(/^v/, '') ?? '';
  if (!bare) return RELEASES_LATEST_URL;
  if (info.platform === 'linux' && packageArch(info.arch) === 'amd64') {
    return `${RELEASES_BASE}/download/v${bare}/o8_${bare}_linux_amd64_preview.AppImage`;
  }
  return `${RELEASES_BASE}/tag/v${bare}`;
}

/** The single decision every update surface renders and acts on. */
export function resolveUpdateAction(info: InstallInfo | null, version: string | null): UpdateAction {
  if (!info || isSelfUpdatableInstall(info)) return { kind: 'restart' };
  if (isPackageManagedInstall(info)) return { kind: 'download', url: releasePageUrl(version), packageManager: true };
  return { kind: 'download', url: releaseDownloadUrl(info, version) };
}
