import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  importRemoteReleaseApp, verifyRemoteReleaseAppManifest, writeRemoteReleaseAppManifest,
} from '../scripts/lib/remote-release-app.mjs';
// @ts-expect-error The existing ship workflow module has no declaration file.
import { defaultShipPlan } from '../scripts/lib/ship-broadcast.mjs';
import { resolveMacosReleaseArtifacts } from '../scripts/lib/macos-release-artifacts.mjs';

const roots: string[] = [];
const cli = fileURLToPath(new URL('../scripts/import-release-app.mjs', import.meta.url));
const originalPlatform = process.platform;
// Platform adaptation belongs exclusively to the synthetic test harness.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const nativePlatform = (await import('node:os')).platform();
  const fs = await import('node:fs');
  return {
    ...actual,
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
      if (nativePlatform !== 'darwin' && args[0] === '/usr/bin/codesign') {
        return { status: 1, stderr: 'code object is not signed at all', stdout: '' };
      }
      if (nativePlatform !== 'darwin' && args[0] === '/usr/bin/plutil') {
        const plistPath = (args[1] as string[]).at(-1)!;
        const contents = fs.readFileSync(plistPath, 'utf8');
        return { status: 0, stderr: '', stdout: JSON.stringify(Object.fromEntries(
          [...contents.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g)].map((entry) => [entry[1], entry[2]]),
        )) };
      }
      return actual.spawnSync(...args);
    },
  };
});
beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin' }));
afterAll(() => Object.defineProperty(process, 'platform', { value: originalPlatform }));
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function universalBinary() {
  const result = Buffer.alloc(112);
  result.writeUInt32BE(0xcafebabe, 0);
  result.writeUInt32BE(2, 4);
  for (const [index, cpu] of [0x01000007, 0x0100000c].entries()) {
    const offset = 48 + index * 32;
    result.writeUInt32BE(cpu, 8 + index * 20);
    result.writeUInt32BE(offset, 16 + index * 20);
    result.writeUInt32BE(32, 20 + index * 20);
    result.writeUInt32LE(0xfeedfacf, offset);
    result.writeUInt32LE(cpu, offset + 4);
  }
  return result;
}

function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'o8-remote-release-'));
  roots.push(scratch);
  const root = join(scratch, 'checkout');
  const delivery = join(scratch, 'delivery');
  const appPath = join(delivery, 'o8.app');
  const manifestPath = join(delivery, 'handoff.json');
  mkdirSync(root);
  mkdirSync(join(root, 'src-tauri'));
  mkdirSync(join(appPath, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'src-tauri/target\nout\n.env*\no8.release.json\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ identifier: 'run.o8.fixture' }));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  for (const name of ['o8', 'o8-next', 'speech_recognizer', 'speech-local', 'o8-pi-write']) {
    const path = join(appPath, 'Contents/MacOS', name);
    writeFileSync(path, universalBinary());
    chmodSync(path, 0o755);
  }
  writeFileSync(join(appPath, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>o8</string>
<key>CFBundleIdentifier</key><string>run.o8.fixture</string>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
<key>CFBundleVersion</key><string>1.2.3</string>
</dict></plist>`);
  symlinkSync('o8', join(appPath, 'Contents/MacOS/alias'));
  const env = { ...process.env, O8_RELEASE_APP_HANDOFF: manifestPath };
  const cliArgs = [cli];
  if (originalPlatform !== 'darwin') {
    const harness = join(scratch, 'mac-platform-fixture.mjs');
    writeFileSync(harness, `import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: 'darwin' });
const actualSpawn = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === '/usr/bin/codesign') return { status: 1, stderr: 'code object is not signed at all', stdout: '' };
  if (args[0] === '/usr/bin/plutil') {
    const contents = fs.readFileSync(args[1].at(-1), 'utf8');
    return { status: 0, stderr: '', stdout: JSON.stringify(Object.fromEntries(
      [...contents.matchAll(/<key>([^<]+)<\\/key>\\s*<string>([^<]*)<\\/string>/g)].map((entry) => [entry[1], entry[2]]),
    )) };
  }
  return actualSpawn(...args);
};
syncBuiltinESMExports();\n`);
    cliArgs.unshift('--import', harness);
  }
  return { root, appPath, manifestPath, env, cliArgs };
}

function manifestFixture() {
  const value = fixture();
  const { manifest } = writeRemoteReleaseAppManifest({ ...value, outputPath: value.manifestPath });
  return { ...value, manifest };
}

describe('remote release app handoff', () => {
  it('imports through the real CLI, records its digest, and retains the previous app', () => {
    const value = manifestFixture();
    const destination = resolveMacosReleaseArtifacts(value.root, '1.2.3').app;
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'old'), 'recover me');
    const result = spawnSync(process.execPath, value.cliArgs, { cwd: value.root, env: value.env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const receiptPath = result.stdout.match(/\[release-app-import\] receipt (.+)/)?.[1];
    expect(receiptPath).toBeTruthy();
    expect(receiptPath).toContain(join(value.root, 'out/remote-release-imports'));
    const receipt = JSON.parse(readFileSync(receiptPath!, 'utf8'));
    expect(receipt.bundleSha256).toBe(value.manifest.app.bundleSha256);
    expect(receipt.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(value.root, receipt.previousApp, 'old'), 'utf8')).toBe('recover me');
    expect(readFileSync(join(destination, 'Contents/MacOS/o8'))).toEqual(universalBinary());
  });

  it.each(['bytes', 'mode', 'link', 'extra'] as const)('rejects changed %s without replacing the old output', (change) => {
    const value = manifestFixture();
    const binary = join(value.appPath, 'Contents/MacOS/o8');
    if (change === 'bytes') writeFileSync(binary, Buffer.concat([universalBinary(), Buffer.from('changed')]));
    if (change === 'mode') chmodSync(binary, 0o700);
    if (change === 'link') {
      rmSync(join(value.appPath, 'Contents/MacOS/alias'));
      symlinkSync('speech-local', join(value.appPath, 'Contents/MacOS/alias'));
    }
    if (change === 'extra') writeFileSync(join(value.appPath, 'extra'), 'changed');
    const destination = resolveMacosReleaseArtifacts(value.root, '1.2.3').app;
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'old'), 'still here');
    const result = spawnSync(process.execPath, value.cliArgs, { cwd: value.root, env: value.env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('inventory or digest mismatch');
    expect(readFileSync(join(destination, 'old'), 'utf8')).toBe('still here');
  });

  it.each(['head', 'tree', 'version', 'inputsSha256', 'productionConfigSha256'])('rejects manifest %s mismatch', (field) => {
    const value = manifestFixture();
    writeFileSync(value.manifestPath, JSON.stringify({
      ...value.manifest, source: { ...value.manifest.source, [field]: 'mismatch' },
    }));
    expect(() => importRemoteReleaseApp(value)).toThrow('source or production configuration mismatch');
    expect(existsSync(resolveMacosReleaseArtifacts(value.root, '1.2.3').app)).toBe(false);
  });

  it('rejects changed public config, dotenv inputs, and dirty source', () => {
    const value = manifestFixture();
    expect(() => verifyRemoteReleaseAppManifest({ ...value, env: { ...value.env, NEXT_PUBLIC_FEATURE: 'on' } }))
      .toThrow('production configuration mismatch');
    writeFileSync(join(value.root, '.env.production'), 'NEXT_PUBLIC_FEATURE=on\n');
    expect(() => verifyRemoteReleaseAppManifest(value)).toThrow('production configuration mismatch');
    rmSync(join(value.root, '.env.production'));
    writeFileSync(join(value.root, 'package.json'), JSON.stringify({ version: '1.2.4' }));
    expect(() => verifyRemoteReleaseAppManifest(value)).toThrow('clean source checkout');
  });

  it('rejects a later clean commit through the real CLI', () => {
    const value = manifestFixture();
    writeFileSync(join(value.root, 'new-source'), 'changed');
    execFileSync('git', ['add', 'new-source'], { cwd: value.root });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'new source'], { cwd: value.root });
    const result = spawnSync(process.execPath, value.cliArgs, { cwd: value.root, env: value.env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('source or production configuration mismatch');
  });

  it.each(['extra-file', 'escaping-link'])('rejects staging %s without moving the app or following links in chmod', (corruption) => {
    const value = manifestFixture();
    const destination = resolveMacosReleaseArtifacts(value.root, '1.2.3').app;
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'old'), 'still here');
    const outside = join(dirname(value.root), 'outside-mode-target');
    mkdirSync(outside, { mode: 0o700 });
    const harness = join(dirname(value.root), 'corrupt-staging.mjs');
    writeFileSync(harness, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const actualCopy = fs.cpSync;
fs.cpSync = (...args) => {
  actualCopy(...args);
  if (${JSON.stringify(corruption)} === 'extra-file') {
    fs.writeFileSync(args[1] + '/changed-after-copy', 'bad');
  } else {
    fs.rmSync(args[1] + '/Contents', { recursive: true, force: true });
    fs.symlinkSync(${JSON.stringify(outside)}, args[1] + '/Contents');
  }
};
syncBuiltinESMExports();\n`);
    const result = spawnSync(process.execPath, ['--import', harness, ...value.cliArgs], {
      cwd: value.root, env: value.env, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(corruption === 'extra-file' ? 'staged handoff app inventory mismatch' : 'unsafe app symlink');
    expect(readFileSync(join(destination, 'old'), 'utf8')).toBe('still here');
    expect(statSync(outside).mode & 0o777).toBe(0o700);
  });

  it('refuses a credential-signed app even with a matching byte manifest', () => {
    const value = manifestFixture();
    const harness = join(dirname(value.root), 'signed-shell.mjs');
    writeFileSync(harness, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const actualSpawn = childProcess.spawnSync;
childProcess.spawnSync = (...args) => args[0] === '/usr/bin/codesign'
  ? { status: 0, stderr: 'Authority=Developer ID Application: Fixture\\n', stdout: '' }
  : actualSpawn(...args);
syncBuiltinESMExports();\n`);
    const cliArgs = [...value.cliArgs];
    cliArgs.splice(cliArgs.length - 1, 0, '--import', harness);
    const result = spawnSync(process.execPath, cliArgs, { cwd: value.root, env: value.env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be unsigned or ad-hoc signed');
  });

  it.each(['app', 'receipt'])('restores the old app when final %s publication fails', (failure) => {
    const value = manifestFixture();
    const destination = resolveMacosReleaseArtifacts(value.root, '1.2.3').app;
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'old'), 'recover me');
    const harness = join(dirname(value.root), 'fail-replacement.mjs');
    writeFileSync(harness, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const actualRename = fs.renameSync;
fs.renameSync = (...args) => {
  if (args[0].includes('/.o8-remote-app-') && args[0].endsWith(
    ${JSON.stringify(failure === 'app' ? '/o8.app' : '/import-receipt.json')}
  )) {
    throw new Error('fixture final replacement failure');
  }
  return actualRename(...args);
};
syncBuiltinESMExports();\n`);
    const result = spawnSync(process.execPath, ['--import', harness, ...value.cliArgs], {
      cwd: value.root, env: value.env, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('fixture final replacement failure');
    expect(readFileSync(join(destination, 'old'), 'utf8')).toBe('recover me');
  });

  it('rejects escaping and chained links before writing a receipt', () => {
    const value = fixture();
    symlinkSync('../../../outside', join(value.appPath, 'Contents/MacOS/escape'));
    expect(() => writeRemoteReleaseAppManifest({ ...value, outputPath: value.manifestPath }))
      .toThrow('unsafe app symlink');
    expect(existsSync(value.manifestPath)).toBe(false);
    rmSync(join(value.appPath, 'Contents/MacOS/escape'));
    const outside = join(dirname(value.appPath), 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret'), 'outside');
    symlinkSync('../../../outside', join(value.appPath, 'Contents/MacOS/outside'));
    symlinkSync('outside/secret', join(value.appPath, 'Contents/MacOS/chain'));
    expect(() => writeRemoteReleaseAppManifest({ ...value, outputPath: value.manifestPath }))
      .toThrow('escaping app symlink');
  });

  it('rejects unsafe manifest app names and symlinked output parents', () => {
    const value = manifestFixture();
    writeFileSync(value.manifestPath, JSON.stringify({ ...value.manifest, app: { ...value.manifest.app, name: '../other.app' } }));
    expect(() => importRemoteReleaseApp(value)).toThrow('app path');
    writeFileSync(value.manifestPath, JSON.stringify(value.manifest));
    const outside = join(dirname(value.root), 'outside');
    mkdirSync(outside);
    mkdirSync(join(value.root, 'src-tauri'), { recursive: true });
    symlinkSync(outside, join(value.root, 'src-tauri/target'));
    expect(() => importRemoteReleaseApp(value)).toThrow('unsafe entry');
    expect(existsSync(join(outside, 'universal-apple-darwin'))).toBe(false);
  });

  it('requires matching app plist version and both executable architecture slices', () => {
    const value = fixture();
    const originalPlist = readFileSync(join(value.appPath, 'Contents/Info.plist'), 'utf8');
    writeFileSync(join(value.appPath, 'Contents/Info.plist'), originalPlist.replaceAll('1.2.3', '1.2.4'));
    expect(() => writeRemoteReleaseAppManifest({ ...value, outputPath: value.manifestPath })).toThrow('release identity');
    writeFileSync(join(value.appPath, 'Contents/Info.plist'), originalPlist);
    writeFileSync(join(value.appPath, 'Contents/MacOS/o8'), universalBinary().subarray(48, 80));
    expect(() => writeRemoteReleaseAppManifest({ ...value, outputPath: value.manifestPath })).toThrow('architecture arm64');
  });

  it.each(['CFBundleIdentifier', 'CFBundleExecutable'])('refuses wrong %s without replacing an existing app', (key) => {
    const value = manifestFixture();
    const destination = resolveMacosReleaseArtifacts(value.root, '1.2.3').app;
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'old'), 'still here');
    const path = join(value.appPath, 'Contents/Info.plist');
    const original = key === 'CFBundleIdentifier' ? 'run.o8.fixture' : 'o8';
    writeFileSync(path, readFileSync(path, 'utf8').replace(`<string>${original}</string>`, '<string>wrong</string>'));
    const result = spawnSync(process.execPath, value.cliArgs, { cwd: value.root, env: value.env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(key);
    expect(readFileSync(join(destination, 'old'), 'utf8')).toBe('still here');
  });
});

describe('remote ship selection', () => {
  it('keeps the default build and every signing/publication stage unchanged', () => {
    const local = defaultShipPlan('/repo', {});
    const remote = defaultShipPlan('/repo', { O8_RELEASE_APP_HANDOFF: '/handoff.json' });
    expect(local.build).toEqual({ command: 'npm', args: ['run', 'tauri:build:stable-macos'] });
    expect(remote.build).toEqual({ command: process.execPath, args: ['/repo/scripts/import-release-app.mjs'] });
    expect({ ...remote, build: local.build }).toEqual(local);
    expect(defaultShipPlan('/repo', { O8_RELEASE_APP_HANDOFF: '  ' })).toEqual(local);
  });
});
