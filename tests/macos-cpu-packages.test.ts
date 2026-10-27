import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveMacosCpuArtifacts,
  resolveMacosReleaseArtifacts,
  verifyMacCpuApp,
  verifyMacCpuUpdaterArchive,
  verifyUniversalMacApp,
} from '../scripts/lib/macos-release-artifacts.mjs';
import { verifyMacCpuDerivation } from '../scripts/lib/macos-cpu-packages.mjs';

const roots: string[] = [];
const binaries = ['o8', 'speech_recognizer', 'speech-local', 'o8-pi-write', 'o8-next'];
const script = join(process.cwd(), 'scripts/macos-cpu-packages.mjs');

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function thin(arch: 'x86_64' | 'arm64') {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(arch === 'x86_64' ? 0x01000007 : 0x0100000c, 4);
  return bytes;
}

function fixture(arch: 'x86_64' | 'arm64') {
  const root = mkdtempSync(join(tmpdir(), 'o8-cpu-packages-'));
  roots.push(root);
  const app = join(root, 'o8.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  for (const name of binaries) writeFileSync(join(app, 'Contents/MacOS', name), thin(arch));
  return { root, app };
}

describe('CPU-specific macOS artifact boundaries', () => {
  it.each(['x86_64', 'arm64'] as const)('requires exactly the %s slice in every required executable', (arch) => {
    const { app } = fixture(arch);
    expect(verifyMacCpuApp(app, arch)).toMatchObject({ kind: 'macos-cpu-app', architectures: [arch] });
    expect(() => verifyUniversalMacApp(app)).toThrow('missing required Mach-O architecture');
    writeFileSync(join(app, 'Contents/MacOS/speech-local'), thin(arch === 'arm64' ? 'x86_64' : 'arm64'));
    expect(() => verifyMacCpuApp(app, arch)).toThrow('must contain exactly');
  });

  it('rejects an unknown architecture before resolving output paths', () => {
    expect(() => resolveMacosCpuArtifacts('/repo', '0.1.999', '../other' as 'arm64')).toThrow('unsupported macOS architecture');
  });

  it('keeps the universal fallback path and gives CPU artifacts distinct names', () => {
    expect(resolveMacosReleaseArtifacts('/repo', '0.1.999').updaterArchive).toMatch(/macos\/o8\.app\.tar\.gz$/);
    expect(resolveMacosCpuArtifacts('/repo', '0.1.999', 'arm64')).toMatchObject({
      architecture: 'arm64',
      updaterArchive: '/repo/src-tauri/target/universal-apple-darwin/release/bundle/cpu/arm64/macos/o8_arm64.app.tar.gz',
      dmg: '/repo/src-tauri/target/universal-apple-darwin/release/bundle/cpu/arm64/dmg/o8_0.1.999_arm64.dmg',
    });
  });

  it.each(['x86_64', 'arm64'] as const)('binds the %s archive to all resources and modes', (arch) => {
    const { root, app } = fixture(arch);
    writeFileSync(join(app, 'Contents/resource.txt'), 'preserved');
    const archive = join(root, 'app.tar.gz');
    execFileSync('tar', ['czf', archive, '-C', root, 'o8.app'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    expect(verifyMacCpuUpdaterArchive(app, archive, arch).bundleSha256).toHaveLength(64);
    chmodSync(join(app, 'Contents/resource.txt'), 0o700);
    expect(() => verifyMacCpuUpdaterArchive(app, archive, arch)).toThrow('contents do not match');
  });

  it.skipIf(process.platform === 'win32')('rejects escaped bundle links before CPU archive extraction', () => {
    const { root, app } = fixture('arm64');
    symlinkSync('../../outside', join(app, 'Contents/escape'));
    const archive = join(root, 'app.tar.gz');
    execFileSync('tar', ['czf', archive, '-C', root, 'o8.app'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    expect(() => verifyMacCpuUpdaterArchive(app, archive, 'arm64')).toThrow('unsafe symlink');
  });

  it.runIf(process.platform === 'darwin').each(['1', 'x86_64'])('prepares the selected %s packages through the CLI without changing source resources or overwriting prior output', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'o8-cpu-cli-'));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.999' }));
    const source = resolveMacosReleaseArtifacts(root, '0.1.999').app;
    mkdirSync(join(source, 'Contents/MacOS'), { recursive: true });
    const c = join(root, 'fixture.c');
    const executable = join(root, 'fixture');
    const entitlements = join(root, 'entitlements.plist');
    writeFileSync(entitlements, '<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
    writeFileSync(c, 'int main(void) { return 0; }\n');
    execFileSync('/usr/bin/clang', ['-arch', 'x86_64', '-arch', 'arm64', c, '-o', executable]);
    const requirement = '=designated => identifier "run.o8.fixture"';
    execFileSync('/usr/bin/codesign', [
      '--force', '--identifier', 'run.o8.fixture', '--requirements', requirement,
      '--options', 'runtime', '--entitlements', entitlements, '--sign', '-', executable,
    ]);
    for (const name of binaries) copyFileSync(executable, join(source, 'Contents/MacOS', name));
    mkdirSync(join(source, 'Contents/Resources/server'), { recursive: true });
    writeFileSync(join(source, 'Contents/Resources/server/runtime.js'), 'same runtime');
    writeFileSync(join(source, 'Contents/Info.plist'), '<plist><dict><key>CFBundleExecutable</key><string>o8</string><key>CFBundleIdentifier</key><string>run.o8.fixture</string><key>CFBundleShortVersionString</key><string>0.1.999</string><key>CFBundleVersion</key><string>0.1.999</string></dict></plist>');
    execFileSync('/usr/bin/codesign', [
      '--force', '--requirements', requirement, '--options', 'runtime',
      '--entitlements', entitlements, '--sign', '-', source,
    ]);
    const original = readFileSync(join(source, 'Contents/MacOS/o8'));
    const run = () => spawnSync(process.execPath, [script, '--root', root], {
      encoding: 'utf8', timeout: 30_000, env: { ...process.env, O8_MACOS_CPU_PACKAGES: mode },
    });
    const first = run();
    expect(first.status, first.stderr).toBe(0);
    const architectures = mode === 'x86_64' ? ['x86_64'] as const : ['x86_64', 'arm64'] as const;
    for (const arch of architectures) {
      const paths = resolveMacosCpuArtifacts(root, '0.1.999', arch);
      expect(verifyMacCpuApp(paths.app, arch).architectures).toEqual([arch]);
      expect(readFileSync(join(paths.app, 'Contents/Resources/server/runtime.js'), 'utf8')).toBe('same runtime');
      expect(existsSync(paths.updaterSignature)).toBe(false);
      execFileSync('/usr/bin/codesign', [
        '--force', '--preserve-metadata=identifier,entitlements,requirements,flags,runtime',
        '--sign', '-', join(paths.app, 'Contents/MacOS/o8'),
      ]);
      expect(verifyMacCpuDerivation(source, paths.app, arch).sharedResourcesSha256).toHaveLength(64);
    }
    if (mode === 'x86_64') expect(existsSync(resolveMacosCpuArtifacts(root, '0.1.999', 'arm64').app)).toBe(false);
    expect(readFileSync(join(source, 'Contents/MacOS/o8'))).toEqual(original);
    const second = run();
    expect(second.status).toBe(1);
    expect(second.stderr).toContain('already exists');
    expect(readFileSync(join(source, 'Contents/MacOS/o8'))).toEqual(original);
    expect(dirname(resolveMacosCpuArtifacts(root, '0.1.999', 'arm64').app)).toContain('/cpu/arm64/macos');
    const rejectedArchitecture = mode === 'x86_64' ? 'x86_64' : 'arm64';
    const arm = resolveMacosCpuArtifacts(root, '0.1.999', rejectedArchitecture).app;
    const emptyEntitlements = join(root, 'empty-entitlements.plist');
    writeFileSync(emptyEntitlements, '<plist><dict/></plist>');
    execFileSync('/usr/bin/codesign', [
      '--force', '--preserve-metadata=identifier,requirements,flags,runtime',
      '--entitlements', emptyEntitlements, '--sign', '-', join(arm, 'Contents/MacOS/speech_recognizer'),
    ]);
    expect(() => verifyMacCpuDerivation(source, arm, rejectedArchitecture)).toThrow('signing policy differs');
    const rejectedSign = spawnSync(process.execPath, [join(process.cwd(), 'scripts/sign-and-notarize.mjs'), '--architecture', rejectedArchitecture], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: {
        ...process.env, APPLE_SIGNING_IDENTITY: 'fixture', APPLE_ID: 'fixture.invalid',
        APPLE_PASSWORD: 'fixture', APPLE_TEAM_ID: 'fixture',
      },
    });
    expect(rejectedSign.status, rejectedSign.stderr).toBe(1);
    expect(rejectedSign.stderr).toContain('signing policy differs');
    expect(rejectedSign.stdout).not.toContain('submitting to Apple');
    expect(existsSync(resolveMacosCpuArtifacts(root, '0.1.999', rejectedArchitecture).updaterSignature)).toBe(false);
    const changed = readFileSync(join(arm, 'Contents/MacOS/o8'));
    changed[4096] ^= 1;
    writeFileSync(join(arm, 'Contents/MacOS/o8'), changed);
    expect(() => verifyMacCpuDerivation(source, arm, rejectedArchitecture)).toThrow('executable payload differs');
  });
});
