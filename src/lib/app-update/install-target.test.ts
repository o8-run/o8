import { describe, expect, it } from 'vitest';

import {
  isSelfUpdatableInstall,
  normalizeInstallInfo,
  releaseDownloadUrl,
  resolveUpdateAction,
  type InstallInfo,
} from './install-target';

function info(overrides: Partial<InstallInfo> = {}): InstallInfo {
  return {
    platform: 'darwin',
    arch: 'arm64',
    appImagePath: null,
    updaterSelfUpdatable: null,
    ...overrides,
  };
}

describe('isSelfUpdatableInstall', () => {
  it('keeps macOS and Windows bundles on the restart-to-install path', () => {
    expect(isSelfUpdatableInstall(info({ platform: 'darwin' }))).toBe(true);
    expect(isSelfUpdatableInstall(info({ platform: 'darwin', arch: 'x64' }))).toBe(true);
    expect(isSelfUpdatableInstall(info({ platform: 'win32', arch: 'x64' }))).toBe(true);
  });

  it('treats a Linux install as self-updatable only when it is an AppImage', () => {
    expect(isSelfUpdatableInstall(info({
      platform: 'linux',
      arch: 'x64',
      appImagePath: '/home/o8/Apps/o8_0.1.726_amd64.AppImage',
    }))).toBe(true);
    // deb/rpm: no APPIMAGE in the app env.
    expect(isSelfUpdatableInstall(info({ platform: 'linux', arch: 'x64' }))).toBe(false);
    expect(isSelfUpdatableInstall(info({ platform: 'linux', arch: 'arm64' }))).toBe(false);
  });

  it('honours an explicit updater verdict on every platform', () => {
    expect(isSelfUpdatableInstall(info({ updaterSelfUpdatable: false }))).toBe(false);
    expect(isSelfUpdatableInstall(info({
      platform: 'linux',
      appImagePath: '/tmp/o8.AppImage',
      updaterSelfUpdatable: false,
    }))).toBe(false);
  });

  it('fails open on an unknown platform so the shipped path is unchanged', () => {
    expect(isSelfUpdatableInstall(info({ platform: 'unknown', arch: null }))).toBe(true);
  });
});

describe('releaseDownloadUrl', () => {
  it('points x86_64 Linux at the published AppImage asset', () => {
    expect(releaseDownloadUrl(info({ platform: 'linux', arch: 'x64' }), '0.1.726'))
      .toBe('https://github.com/o8-run/o8/releases/download/v0.1.726/o8_0.1.726_linux_amd64_preview.AppImage');
    expect(releaseDownloadUrl(info({ platform: 'linux', arch: 'x86_64' }), 'v0.1.726'))
      .toBe('https://github.com/o8-run/o8/releases/download/v0.1.726/o8_0.1.726_linux_amd64_preview.AppImage');
  });

  it('falls back to the release page for an arch with no published asset', () => {
    expect(releaseDownloadUrl(info({ platform: 'linux', arch: 'arm64' }), '0.1.726'))
      .toBe('https://github.com/o8-run/o8/releases/tag/v0.1.726');
    expect(releaseDownloadUrl(info({ platform: 'linux', arch: null }), '0.1.726'))
      .toBe('https://github.com/o8-run/o8/releases/tag/v0.1.726');
  });

  it('falls back to the latest release when the version is unknown', () => {
    expect(releaseDownloadUrl(info({ platform: 'linux', arch: 'x64' }), null))
      .toBe('https://github.com/o8-run/o8/releases/latest');
  });
});

describe('resolveUpdateAction', () => {
  it('renders restart-to-install wherever the install can self-update', () => {
    expect(resolveUpdateAction(info({ platform: 'darwin' }), '0.1.726')).toEqual({ kind: 'restart' });
    expect(resolveUpdateAction(info({
      platform: 'linux',
      arch: 'x64',
      appImagePath: '/home/o8/Apps/o8.AppImage',
    }), '0.1.726')).toEqual({ kind: 'restart' });
  });

  it('sends a deb/rpm Linux install to its package manager and the release page', () => {
    expect(resolveUpdateAction(info({ platform: 'linux', arch: 'x64' }), '0.1.726')).toEqual({
      kind: 'download',
      url: 'https://github.com/o8-run/o8/releases/tag/v0.1.726',
      packageManager: true,
    });
    expect(resolveUpdateAction(info({ platform: 'linux', arch: 'arm64' }), null)).toEqual({
      kind: 'download',
      url: 'https://github.com/o8-run/o8/releases/latest',
      packageManager: true,
    });
  });

  it('keeps the AppImage download when the updater refuses an AppImage install', () => {
    expect(resolveUpdateAction(info({
      platform: 'linux',
      arch: 'x64',
      appImagePath: '/home/o8/Apps/o8.AppImage',
      updaterSelfUpdatable: false,
    }), '0.1.726')).toEqual({
      kind: 'download',
      url: 'https://github.com/o8-run/o8/releases/download/v0.1.726/o8_0.1.726_linux_amd64_preview.AppImage',
    });
  });

  it('renders restart-to-install while the install is still unknown', () => {
    expect(resolveUpdateAction(null, '0.1.726')).toEqual({ kind: 'restart' });
  });
});

describe('normalizeInstallInfo', () => {
  it('reads the route payload and rejects junk', () => {
    expect(normalizeInstallInfo({
      platform: 'linux',
      arch: 'x64',
      appImagePath: '  /home/o8/o8.AppImage  ',
      updaterSelfUpdatable: false,
    })).toEqual({
      platform: 'linux',
      arch: 'x64',
      appImagePath: '/home/o8/o8.AppImage',
      updaterSelfUpdatable: false,
    });
    expect(normalizeInstallInfo({ platform: 'plan9', arch: '', appImagePath: '  ' })).toEqual({
      platform: 'unknown',
      arch: null,
      appImagePath: null,
      updaterSelfUpdatable: null,
    });
    expect(normalizeInstallInfo(null)).toBeNull();
    expect(normalizeInstallInfo('linux')).toBeNull();
  });
});
