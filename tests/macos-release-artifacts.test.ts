import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MACOS_RELEASE_ARCHITECTURES,
  readMachOArchitectures,
  resolveMacosReleaseArtifacts,
  verifyMacosDmgMatchesApp,
  verifyUniversalMacApp,
  verifyUniversalMacUpdaterArchive,
} from '../scripts/lib/macos-release-artifacts.mjs';

const detachFixture = vi.hoisted(() => ({
  interruptAfterUnmount: false,
  mountPath: '',
  attempts: [] as string[][],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (file: string, args: string[], options?: object) => {
      if (file === '/usr/bin/hdiutil' && args[0] === 'attach') {
        detachFixture.mountPath = args[args.indexOf('-mountpoint') + 1];
      }
      if (file === '/usr/bin/hdiutil' && args[0] === 'detach') {
        detachFixture.attempts.push([...args]);
        if (detachFixture.interruptAfterUnmount) {
          detachFixture.interruptAfterUnmount = false;
          actual.execFileSync('/usr/sbin/diskutil', ['unmount', detachFixture.mountPath]);
          throw new Error('fixture detach interrupted after the volume was unmounted');
        }
      }
      return actual.execFileSync(file, args, options);
    },
  };
});

const roots: string[] = [];
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

afterEach(() => {
  detachFixture.interruptAfterUnmount = false;
  detachFixture.attempts = [];
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function thinMachO(cpuType: number) {
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(cpuType, 4);
  return binary;
}

function universalMachO() {
  const slices = [thinMachO(CPU_TYPE_X86_64), thinMachO(CPU_TYPE_ARM64)];
  const headerBytes = 8 + slices.length * 20;
  const binary = Buffer.alloc(headerBytes + slices.reduce((sum, slice) => sum + slice.length, 0));
  binary.writeUInt32BE(0xcafebabe, 0);
  binary.writeUInt32BE(slices.length, 4);
  let offset = headerBytes;
  for (const [index, slice] of slices.entries()) {
    const entry = 8 + index * 20;
    binary.writeUInt32BE(index === 0 ? CPU_TYPE_X86_64 : CPU_TYPE_ARM64, entry);
    binary.writeUInt32BE(0, entry + 4);
    binary.writeUInt32BE(offset, entry + 8);
    binary.writeUInt32BE(slice.length, entry + 12);
    binary.writeUInt32BE(0, entry + 16);
    slice.copy(binary, offset);
    offset += slice.length;
  }
  return binary;
}

function appFixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-universal-app-'));
  roots.push(root);
  const app = join(root, 'o8.app');
  for (const name of ['o8', 'speech_recognizer', 'speech-local', 'o8-pi-write', 'o8-next']) {
    const path = join(app, 'Contents', 'MacOS', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, universalMachO());
  }
  return app;
}

function archiveFixture(app: string) {
  const archive = join(dirname(app), 'o8.app.tar.gz');
  execFileSync('tar', ['czf', archive, '-C', dirname(app), 'o8.app']);
  return archive;
}

function verifyWithUmask(app: string, archive: string, mask: number, scratch: string) {
  const moduleUrl = new URL('../scripts/lib/macos-release-artifacts.mjs', import.meta.url).href;
  const script = `
    const { verifyUniversalMacUpdaterArchive } = await import(${JSON.stringify(moduleUrl)});
    process.umask(Number(process.argv[1]));
    try {
      console.log(JSON.stringify({ identity: verifyUniversalMacUpdaterArchive(process.argv[2], process.argv[3]) }));
    } catch (error) {
      console.log(JSON.stringify({ error: error.message }));
    }
  `;
  return JSON.parse(execFileSync(process.execPath, [
    '--input-type=module', '-e', script, String(mask), app, archive,
  ], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
  }));
}

function signedAppFixture(version: string) {
  const root = mkdtempSync(join(tmpdir(), 'o8-signed-universal-app-'));
  roots.push(root);
  const app = join(root, 'o8.app');
  const macos = join(app, 'Contents', 'MacOS');
  mkdirSync(macos, { recursive: true });
  for (const name of ['o8', 'speech_recognizer', 'speech-local', 'o8-pi-write', 'o8-next']) {
    const path = join(macos, name);
    copyFileSync('/usr/bin/true', path);
    chmodSync(path, 0o755);
  }
  writeFileSync(join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>o8</string>
<key>CFBundleIdentifier</key><string>run.o8.fixture</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
</dict></plist>\n`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  return { app, root };
}

describe('stable macOS release artifact identity', () => {
  it.runIf(process.platform === 'darwin')('preserves staged bundle modes and relative links under umask 0077', () => {
    const app = appFixture();
    const staging = join(dirname(app), 'staging');
    const resources = join(app, 'Contents', 'Resources');
    mkdirSync(staging);
    mkdirSync(resources);
    writeFileSync(join(resources, 'asset.dat'), 'signed resource bytes');
    chmodSync(join(resources, 'asset.dat'), 0o644);
    writeFileSync(join(resources, 'helper'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(resources, 'helper'), 0o755);
    chmodSync(resources, 0o755);
    symlinkSync('asset.dat', join(resources, 'alias.dat'));

    const moduleUrl = new URL('../scripts/lib/macos-release-artifacts.mjs', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { stageMacosDmgApp } = await import(${JSON.stringify(moduleUrl)});
      process.umask(0o077);
      stageMacosDmgApp(process.argv[1], process.argv[2]);
    `, app, staging]);

    const stagedApp = join(staging, 'o8.app');
    const stagedResources = join(stagedApp, 'Contents', 'Resources');
    expect(statSync(stagedResources).mode & 0o777).toBe(0o755);
    expect(statSync(join(stagedResources, 'asset.dat')).mode & 0o777).toBe(0o644);
    expect(statSync(join(stagedResources, 'helper')).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(stagedResources, 'asset.dat'), 'utf8')).toBe('signed resource bytes');
    expect(readlinkSync(join(stagedResources, 'alias.dat'))).toBe('asset.dat');
    // Exercise the existing whole-bundle identity gate, including modes and links.
    expect(verifyUniversalMacUpdaterArchive(app, archiveFixture(stagedApp)).binaries)
      .toEqual(verifyUniversalMacApp(app).binaries);
  });

  it('resolves the universal target without inferring architecture from an x64 filename', () => {
    expect(resolveMacosReleaseArtifacts('/repo', '0.1.999')).toEqual({
      target: 'universal-apple-darwin',
      bundleDir: '/repo/src-tauri/target/universal-apple-darwin/release/bundle',
      app: '/repo/src-tauri/target/universal-apple-darwin/release/bundle/macos/o8.app',
      updaterArchive: '/repo/src-tauri/target/universal-apple-darwin/release/bundle/macos/o8.app.tar.gz',
      updaterSignature: '/repo/src-tauri/target/universal-apple-darwin/release/bundle/macos/o8.app.tar.gz.sig',
      dmg: '/repo/src-tauri/target/universal-apple-darwin/release/bundle/dmg/o8_0.1.999_universal.dmg',
    });
  });

  it('proves both slices from Mach-O bytes for the app and required sidecars', () => {
    const app = appFixture();
    const identity = verifyUniversalMacApp(app);

    expect(identity.kind).toBe('macos-universal-app');
    expect(identity.architectures).toEqual(MACOS_RELEASE_ARCHITECTURES);
    expect(identity.binaries.map((binary) => binary.relativePath)).toEqual([
      'Contents/MacOS/o8',
      'Contents/MacOS/speech_recognizer',
      'Contents/MacOS/speech-local',
      'Contents/MacOS/o8-pi-write',
      'Contents/MacOS/o8-next',
    ]);
    expect(identity.binaries.every((binary) => binary.sha256.length === 64)).toBe(true);
    expect(readMachOArchitectures(join(app, 'Contents/MacOS/o8')))
      .toEqual(MACOS_RELEASE_ARCHITECTURES);
  });

  it('refuses an x86_64-only app before it can back the arm64 updater entry', () => {
    const app = appFixture();
    writeFileSync(join(app, 'Contents/MacOS/o8'), thinMachO(CPU_TYPE_X86_64));

    expect(() => verifyUniversalMacApp(app)).toThrow(
      'Contents/MacOS/o8 is missing required Mach-O architecture arm64',
    );
  });

  it('refuses a fat header whose declared slice does not match its embedded Mach-O', () => {
    const app = appFixture();
    const binary = universalMachO();
    binary.writeUInt32LE(CPU_TYPE_X86_64, 48 + 32 + 4);
    writeFileSync(join(app, 'Contents/MacOS/speech-local'), binary);

    expect(() => verifyUniversalMacApp(app)).toThrow('fat Mach-O slice CPU type mismatch');
  });

  it('binds the updater archive contents to the inspected universal app', () => {
    const app = appFixture();
    const archive = archiveFixture(app);

    const identity = verifyUniversalMacUpdaterArchive(app, archive);

    expect(identity.updaterArchiveSha256).toHaveLength(64);
    expect(identity.bundleSha256).toHaveLength(64);
    expect(identity.binaries.every((binary) => binary.architectures.length === 2)).toBe(true);
  });

  it.skipIf(process.platform === 'win32').each([
    { label: '077', mask: 0o077 },
    { label: '022', mask: 0o022 },
  ])(
    'preserves archived modes under umask $label inside a private scratch ancestor',
    ({ mask }) => {
      const app = appFixture();
      const root = dirname(app);
      chmodSync(root, 0o700);
      for (const path of [app, join(app, 'Contents'), join(app, 'Contents/MacOS')]) {
        chmodSync(path, 0o755);
      }
      for (const name of ['o8', 'speech_recognizer', 'speech-local', 'o8-pi-write', 'o8-next']) {
        chmodSync(join(app, 'Contents/MacOS', name), 0o755);
      }
      const resources = join(app, 'Contents/Resources');
      mkdirSync(resources, { mode: 0o755 });
      chmodSync(resources, 0o755);
      const metadata = join(resources, 'identity.txt');
      writeFileSync(metadata, 'same archived bytes');
      chmodSync(metadata, 0o644);
      symlinkSync('identity.txt', join(resources, 'identity-link'));
      const archive = archiveFixture(app);
      const scratch = join(root, 'private-inspection');
      mkdirSync(scratch, { mode: 0o700 });

      const result = verifyWithUmask(app, archive, mask, scratch);

      expect(result.error).toBeUndefined();
      expect(result.identity.bundleSha256).toHaveLength(64);
      expect(result.identity.updaterArchiveSha256).toHaveLength(64);
      expect(result.identity.binaries.every((binary: { architectures: string[] }) =>
        binary.architectures.length === 2)).toBe(true);
      expect(statSync(root).mode & 0o7777).toBe(0o700);
      expect(statSync(scratch).mode & 0o7777).toBe(0o700);
      expect(readdirSync(scratch)).toEqual([]);
      expect(statSync(metadata).mode & 0o7777).toBe(0o644);
      expect(statSync(join(app, 'Contents/MacOS/o8')).mode & 0o7777).toBe(0o755);
    },
  );

  it.skipIf(process.platform === 'win32').each([
    { label: '077', mask: 0o077 },
    { label: '022', mask: 0o022 },
  ])('refuses an archive with a mode-only difference under umask $label', ({ mask }) => {
    const app = appFixture();
    const binary = join(app, 'Contents/MacOS/o8');
    chmodSync(binary, 0o755);
    const archive = archiveFixture(app);
    chmodSync(binary, 0o700);
    const scratch = join(dirname(app), 'private-inspection');
    mkdirSync(scratch, { mode: 0o700 });

    expect(verifyWithUmask(app, archive, mask, scratch).error).toBe(
      'updater archive contents do not match the inspected macOS app bundle',
    );
    expect(readdirSync(scratch)).toEqual([]);
    expect(statSync(binary).mode & 0o7777).toBe(0o700);
  });

  it('refuses archived content changes at an otherwise identical path', () => {
    const app = appFixture();
    const metadata = join(app, 'Contents/identity.txt');
    writeFileSync(metadata, 'old bytes');
    const archive = archiveFixture(app);
    writeFileSync(metadata, 'new bytes');

    expect(() => verifyUniversalMacUpdaterArchive(app, archive)).toThrow(
      'updater archive contents do not match the inspected macOS app bundle',
    );
  });

  it('refuses archive members outside the app namespace before extraction', () => {
    const app = appFixture();
    const root = dirname(app);
    writeFileSync(join(root, 'outside.txt'), 'outside member');
    const archive = join(root, 'unsafe.tar.gz');
    execFileSync('tar', ['czf', archive, '-C', root, 'o8.app', 'outside.txt']);

    expect(() => verifyUniversalMacUpdaterArchive(app, archive)).toThrow(
      'updater archive contains unsafe member "outside.txt"',
    );
  });

  it.skipIf(process.platform === 'win32')('refuses an archived symlink escaping the app', () => {
    const app = appFixture();
    const link = join(app, 'Contents/escape');
    symlinkSync('../../outside.txt', link);
    const archive = archiveFixture(app);
    rmSync(link);

    expect(() => verifyUniversalMacUpdaterArchive(app, archive)).toThrow(
      'has an unsafe symlink target outside o8.app',
    );
  });

  it('refuses a thin updater archive even when the loose app is universal', () => {
    const app = appFixture();
    writeFileSync(join(app, 'Contents/MacOS/o8'), thinMachO(CPU_TYPE_X86_64));
    const archive = archiveFixture(app);
    writeFileSync(join(app, 'Contents/MacOS/o8'), universalMachO());

    expect(() => verifyUniversalMacUpdaterArchive(app, archive)).toThrow(
      'archived Contents/MacOS/o8 is missing required Mach-O architecture arm64',
    );
  });

  it('refuses a stale universal updater archive whose contents differ from the loose app', () => {
    const app = appFixture();
    const archive = archiveFixture(app);
    writeFileSync(join(app, 'Contents', 'release-identity.txt'), 'new build');

    expect(() => verifyUniversalMacUpdaterArchive(app, archive)).toThrow(
      'updater archive contents do not match the inspected macOS app bundle',
    );
  });

  it.skipIf(process.platform !== 'darwin').each([false, true])('mounts and verifies an actual signed DMG against the source app (interrupted detach: %s)', (interruptedDetach) => {
    const version = '0.1.999';
    const { app, root } = signedAppFixture(version);
    const staging = join(root, 'dmg-staging');
    const dmg = join(root, 'o8.dmg');
    mkdirSync(staging);
    cpSync(app, join(staging, 'o8.app'), { recursive: true, preserveTimestamps: true });
    execFileSync('/usr/bin/hdiutil', [
      'create',
      '-quiet',
      '-volname', 'o8 fixture',
      '-srcfolder', staging,
      '-ov',
      '-format', 'UDZO',
      dmg,
    ]);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', dmg]);

    detachFixture.interruptAfterUnmount = interruptedDetach;
    const identity = verifyMacosDmgMatchesApp(app, dmg, version);

    expect(identity.bundleVersion).toBe(version);
    expect(identity.architectures).toEqual(MACOS_RELEASE_ARCHITECTURES);
    expect(identity.dmgSha256).toHaveLength(64);
    expect(identity.bundleSha256).toHaveLength(64);
    expect(detachFixture.attempts).toHaveLength(interruptedDetach ? 2 : 1);
    expect(detachFixture.attempts[0][1]).toMatch(/^\/dev\/disk\d+$/);
    if (interruptedDetach) {
      expect(detachFixture.attempts[1]).toEqual(['detach', detachFixture.attempts[0][1], '-force']);
    }
    const attachedImages = execFileSync('/usr/bin/hdiutil', ['info'], { encoding: 'utf8' });
    expect(attachedImages).not.toContain(dmg);
  });
});
