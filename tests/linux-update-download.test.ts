/**
 * Real-path seam for #2059: the update card's action is decided by what the
 * RUNNING install can do, not by what the card assumes.
 *
 * Seam A drives the real `/api/panel/app/install-info` route handler with the
 * platform stubbed, feeds its JSON through the same normalizer the card uses,
 * and asserts which action the card would render.
 * Seam B drives the real `installUpdateAndRestart` chokepoint every surface
 * (button, idle auto-apply, remote apply mutation) funnels into, and asserts a
 * non-self-updatable install opens the download and never reaches the updater.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeInstallInfo, releaseDownloadUrl, resolveUpdateAction } from '@/lib/app-update/install-target';
import { buildReleaseManifest } from '../scripts/lib/release-manifest.mjs';

const { openExternalUrl, updaterCheck, invoke, relaunch } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(),
  updaterCheck: vi.fn(async () => null),
  invoke: vi.fn(async () => undefined),
  relaunch: vi.fn(async () => undefined),
}));

vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: updaterCheck }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }));

const { GET } = await import('@/app/api/panel/app/install-info/route');
const { installUpdateAndRestart } = await import('@/lib/app-update/client-restart');

const realPlatform = process.platform;
const realArch = process.arch;
const realAppImage = process.env.APPIMAGE;

function stubInstall(platform: NodeJS.Platform, arch: string, appImage: string | null) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  if (appImage) process.env.APPIMAGE = appImage;
  else delete process.env.APPIMAGE;
}

async function actionForRunningInstall(version: string) {
  const response = await GET();
  expect(response.status).toBe(200);
  const info = normalizeInstallInfo(await response.json());
  expect(info).not.toBeNull();
  return resolveUpdateAction(info, version);
}

describe('install-info route decides the update action (seam A)', () => {
  beforeEach(() => {
    openExternalUrl.mockClear();
    updaterCheck.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    Object.defineProperty(process, 'arch', { value: realArch, configurable: true });
    if (realAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = realAppImage;
  });

  it('points a Linux install with no AppImage path (deb/rpm) at its package manager', async () => {
    stubInstall('linux', 'x64', null);
    await expect(actionForRunningInstall('0.1.726')).resolves.toEqual({
      kind: 'download',
      url: 'https://github.com/o8-run/o8/releases/tag/v0.1.726',
      packageManager: true,
    });
  });

  it('keeps restart-to-install on a Linux AppImage', async () => {
    stubInstall('linux', 'x64', '/home/o8/Apps/o8_0.1.726_amd64.AppImage');
    await expect(actionForRunningInstall('0.1.726')).resolves.toEqual({ kind: 'restart' });
  });

  it('keeps macOS behaviour unchanged', async () => {
    stubInstall('darwin', 'arm64', null);
    await expect(actionForRunningInstall('0.1.726')).resolves.toEqual({ kind: 'restart' });
  });
});

describe('install chokepoint honours the install verdict (seam B)', () => {
  beforeEach(() => {
    openExternalUrl.mockClear();
    updaterCheck.mockClear();
    invoke.mockClear();
    relaunch.mockClear();
  });

  it('opens the release download and never runs the updater when the install cannot self-update', async () => {
    const url = 'https://github.com/o8-run/o8/releases/download/v0.1.726/o8_0.1.726_linux_amd64_preview.AppImage';
    await expect(installUpdateAndRestart(url, { selfUpdatable: false })).resolves.toEqual({
      installed: false,
      downloadOpened: true,
    });
    expect(openExternalUrl).toHaveBeenCalledWith(url);
    expect(updaterCheck).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });
});

describe('the download url matches what the release pipeline publishes (seam C)', () => {
  const bundles: string[] = [];

  afterEach(() => {
    while (bundles.length) rmSync(bundles.pop() as string, { recursive: true, force: true });
  });

  it('resolves the same linux-x86_64 asset url the updater manifest emits', () => {
    const version = '0.1.999';
    const bundleDir = mkdtempSync(join(tmpdir(), 'o8-release-manifest-'));
    bundles.push(bundleDir);
    const appImageDir = join(bundleDir, 'appimage');
    mkdirSync(appImageDir, { recursive: true });
    writeFileSync(join(appImageDir, `o8_${version}_amd64.AppImage`), 'appimage');
    writeFileSync(join(appImageDir, `o8_${version}_amd64.AppImage.sig`), 'linux-fixture-signature\n');

    const downloadBase = 'https://github.com/o8-run/o8/releases/download/v0.1.999';
    const { latestJson } = buildReleaseManifest({
      bundleDir,
      version,
      notes: `o8 v${version}`,
      pubDate: '2026-09-02T12:00:00.000Z',
      downloadBase,
      darwinArtifact: {
        signature: 'darwin-fixture-signature',
        identity: {
          kind: 'macos-universal-app',
          architectures: ['x86_64', 'arm64'],
          binaries: [],
        },
      },
    });

    // The local build name and the published asset name differ; the card must
    // link the published one or every Linux download 404s.
    const linuxUrl = latestJson.platforms['linux-x86_64']?.url;
    expect(typeof linuxUrl).toBe('string');
    expect(releaseDownloadUrl(
      { platform: 'linux', arch: 'x64', appImagePath: null, updaterSelfUpdatable: null },
      version,
    )).toBe(linuxUrl);
    expect(latestJson.platforms['darwin-x86_64']?.url).toBe(`${downloadBase}/o8.app.tar.gz`);
  });
});
