import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectReleaseArtifactRecipe,
  verifyReleaseArtifactManifest,
  writeReleaseArtifactManifest,
} from '../scripts/lib/release-artifacts.mjs';
import { buildReleaseManifest } from '../scripts/lib/release-manifest.mjs';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeArtifact() {
  const root = mkdtempSync(join(tmpdir(), 'o8-release-artifact-'));
  roots.push(root);
  mkdirSync(join(root, 'out', 'frontend'), { recursive: true });
  mkdirSync(join(root, 'src-tauri', 'helpers'), { recursive: true });
  writeFileSync(join(root, 'out', 'frontend', 'index.html'), '<h1>verified</h1>');
  for (const name of [
    'speech-local',
    'speech-local-aarch64-apple-darwin',
    'speech-local-universal-apple-darwin',
    'speech-local-x86_64-apple-darwin',
  ]) {
    writeFileSync(join(root, 'src-tauri', 'helpers', name), `binary-${name}`);
  }
  return root;
}

describe('release artifact provenance', () => {
  it('invalidates artifact reuse when the public web-build environment changes', () => {
    const version = '0.1.999';
    const first = collectReleaseArtifactRecipe(process.cwd(), version, {
      env: { ...process.env, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_release_one' },
    });
    const second = collectReleaseArtifactRecipe(process.cwd(), version, {
      env: { ...process.env, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_release_two' },
    });

    expect(first.recipeSha256).not.toBe(second.recipeSha256);
    expect(JSON.stringify(first)).not.toContain('pk_test_release_one');
  });

  it('reuses only an exact recipe with the exact output set and checksums', () => {
    const root = makeArtifact();
    const recipe = { recipeSha256: 'recipe-a', head: 'head-a', version: '0.1.999' };
    const written = writeReleaseArtifactManifest(root, recipe);

    expect(written.manifest.outputs.length).toBe(5);
    expect(verifyReleaseArtifactManifest(root, recipe)).toMatchObject({ reusable: true });
    expect(verifyReleaseArtifactManifest(root, { ...recipe, recipeSha256: 'recipe-b' }))
      .toMatchObject({ reusable: false, reason: 'recipe_mismatch' });
    expect(verifyReleaseArtifactManifest(root, { ...recipe, worktreeClean: false }))
      .toMatchObject({ reusable: false, reason: 'dirty_worktree' });

    writeFileSync(join(root, 'out', 'frontend', 'index.html'), '<h1>mutated</h1>');
    expect(verifyReleaseArtifactManifest(root, recipe)).toMatchObject({
      reusable: false,
      reason: 'checksum_mismatch:out/frontend/index.html',
    });
  });

  it('rejects an extra output that was never verified', () => {
    const root = makeArtifact();
    const recipe = { recipeSha256: 'recipe-a' };
    writeReleaseArtifactManifest(root, recipe);
    writeFileSync(join(root, 'out', 'frontend', 'late.js'), 'unverified');
    expect(verifyReleaseArtifactManifest(root, recipe)).toMatchObject({
      reusable: false,
      reason: 'output_set_mismatch',
    });
  });
});

function makeReleaseBundle(includeLinux: boolean, linuxAppImageVersion = '0.1.999') {
  const bundleDir = mkdtempSync(join(tmpdir(), 'o8-release-bundle-'));
  roots.push(bundleDir);
  const macosDir = join(bundleDir, 'macos');
  const dmgDir = join(bundleDir, 'dmg');
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(dmgDir, { recursive: true });
  const macosAssets = [
    join(dmgDir, 'o8_0.1.999_universal.dmg'),
    join(macosDir, 'o8.app.tar.gz'),
    join(macosDir, 'o8.app.tar.gz.sig'),
  ];
  const trailingAssets = [
    join(macosDir, 'latest.json'),
    join(macosDir, 'fixed.json'),
  ];
  for (const path of macosAssets) writeFileSync(path, 'fixture');

  const linuxAssets: string[] = [];
  if (includeLinux) {
    const appImageDir = join(bundleDir, 'appimage');
    const debDir = join(bundleDir, 'deb');
    mkdirSync(appImageDir, { recursive: true });
    mkdirSync(debDir, { recursive: true });
    linuxAssets.push(
      join(appImageDir, `o8_${linuxAppImageVersion}_amd64.AppImage`),
      join(appImageDir, `o8_${linuxAppImageVersion}_amd64.AppImage.sig`),
      join(debDir, 'o8_0.1.999_amd64.deb'),
    );
    writeFileSync(linuxAssets[0], 'appimage');
    writeFileSync(linuxAssets[1], 'linux-fixture-signature\n');
    writeFileSync(linuxAssets[2], 'deb');
  }

  return { bundleDir, macosAssets, trailingAssets, linuxAssets };
}

function releasePlan(bundle: ReturnType<typeof makeReleaseBundle>) {
  return buildReleaseManifest({
    bundleDir: bundle.bundleDir,
    version: '0.1.999',
    notes: 'o8 v0.1.999',
    pubDate: '2026-08-27T12:00:00.000Z',
    downloadBase: 'https://github.com/example/releases/download/v0.1.999',
    darwinArtifact: {
      signature: 'darwin-fixture-signature',
      identity: {
        kind: 'macos-universal-app',
        architectures: ['x86_64', 'arm64'],
        binaries: [],
      },
    },
    baseUploadAssets: bundle.macosAssets,
    trailingUploadAssets: bundle.trailingAssets,
  });
}

describe('release updater manifest', () => {
  function cpuPlan(architectures: Array<'x86_64' | 'arm64'> = ['x86_64', 'arm64']) {
    const bundle = makeReleaseBundle(false);
    const universal = {
      kind: 'macos-universal-app' as const, architectures: ['x86_64', 'arm64'] as Array<'x86_64' | 'arm64'>,
      binaries: [], bundleSha256: 'a'.repeat(64),
    };
    const cpus = architectures.map((architecture) => ({
      architecture,
      signature: `${architecture}-signature`,
      identity: {
        kind: 'macos-cpu-app' as const, architectures: [architecture] as ['x86_64' | 'arm64'], sourceBundleSha256: 'a'.repeat(64),
        binaries: ['o8', 'speech_recognizer', 'speech-local', 'o8-pi-write', 'o8-next'].map((name) => ({
          relativePath: `Contents/MacOS/${name}`, architectures: [architecture] as Array<'x86_64' | 'arm64'>, sha256: 'b'.repeat(64),
        })),
        updaterArchiveSha256: 'c'.repeat(64), bundleSha256: 'd'.repeat(64),
      },
      archivePath: join(bundle.bundleDir, `o8_${architecture}.app.tar.gz`),
      signaturePath: join(bundle.bundleDir, `o8_${architecture}.app.tar.gz.sig`),
      dmgPath: join(bundle.bundleDir, `o8_0.1.999_${architecture}.dmg`),
    }));
    return { bundle, cpus, options: {
      bundleDir: bundle.bundleDir, version: '0.1.999', notes: 'o8', pubDate: '2026-10-14T00:00:00Z',
      downloadBase: 'https://example.test/v0.1.999',
      darwinArtifact: { signature: 'universal-signature', identity: universal },
      darwinCpuArtifacts: cpus,
      baseUploadAssets: bundle.macosAssets,
    } };
  }

  it('routes each CPU to its own signature and archive while retaining universal assets', () => {
    const f = cpuPlan();
    const plan = buildReleaseManifest(f.options);
    expect(plan.latestJson.platforms).toEqual({
      'darwin-x86_64': { signature: 'x86_64-signature', url: 'https://example.test/v0.1.999/o8_x86_64.app.tar.gz' },
      'darwin-aarch64': { signature: 'arm64-signature', url: 'https://example.test/v0.1.999/o8_arm64.app.tar.gz' },
    });
    expect(plan.uploadArgs).toEqual([
      ...f.bundle.macosAssets,
      ...f.cpus.flatMap((cpu) => [cpu.dmgPath, cpu.archivePath, cpu.signaturePath]),
    ]);
  });

  it('routes Intel to its CPU package while Apple Silicon retains the universal signature and archive', () => {
    const f = cpuPlan(['x86_64']);
    const plan = buildReleaseManifest(f.options);
    expect(plan.latestJson.platforms).toEqual({
      'darwin-x86_64': { signature: 'x86_64-signature', url: 'https://example.test/v0.1.999/o8_x86_64.app.tar.gz' },
      'darwin-aarch64': { signature: 'universal-signature', url: 'https://example.test/v0.1.999/o8.app.tar.gz' },
    });
    expect(plan.uploadArgs).toEqual([
      ...f.bundle.macosAssets,
      ...f.cpus.flatMap((cpu) => [cpu.dmgPath, cpu.archivePath, cpu.signaturePath]),
    ]);
    expect(plan.uploadArgs.some(path => path.includes('o8_arm64.'))).toBe(false);
  });

  it('supports Apple Silicon-only delivery while retaining the Intel universal fallback', () => {
    const f = cpuPlan(['arm64']);
    const plan = buildReleaseManifest(f.options);
    expect(plan.latestJson.platforms).toEqual({
      'darwin-x86_64': { signature: 'universal-signature', url: 'https://example.test/v0.1.999/o8.app.tar.gz' },
      'darwin-aarch64': { signature: 'arm64-signature', url: 'https://example.test/v0.1.999/o8_arm64.app.tar.gz' },
    });
    expect(plan.uploadArgs).toEqual([
      ...f.bundle.macosAssets,
      ...f.cpus.flatMap((cpu) => [cpu.dmgPath, cpu.archivePath, cpu.signaturePath]),
    ]);
  });

  it.each([{ architectures: ['x86_64', 'x86_64'] }, { architectures: ['arm64', 'arm64'] }, { architectures: [] }] as Array<{ architectures: Array<'x86_64' | 'arm64'> }>)('rejects an empty or duplicate CPU set $architectures', ({ architectures }) => {
    expect(() => buildReleaseManifest(cpuPlan(architectures).options)).toThrow('one artifact per selected macOS architecture');
  });

  it('rejects a CPU artifact derived from another universal build', () => {
    const f = cpuPlan();
    f.cpus[1].identity.sourceBundleSha256 = 'e'.repeat(64);
    expect(() => buildReleaseManifest(f.options)).toThrow('universal source identity');
  });

  it('rejects a signature or CPU identity assigned to the wrong platform', () => {
    const f = cpuPlan();
    f.cpus[1].identity.architectures = ['x86_64'];
    expect(() => buildReleaseManifest(f.options)).toThrow('CPU artifact identity');
  });

  it('keeps the macOS-only platforms and upload list unchanged', () => {
    const bundle = makeReleaseBundle(false);
    const plan = releasePlan(bundle);

    expect(plan.latestJson.platforms).toEqual({
      'darwin-x86_64': {
        signature: 'darwin-fixture-signature',
        url: 'https://github.com/example/releases/download/v0.1.999/o8.app.tar.gz',
      },
      'darwin-aarch64': {
        signature: 'darwin-fixture-signature',
        url: 'https://github.com/example/releases/download/v0.1.999/o8.app.tar.gz',
      },
    });
    expect(plan.uploadArgs).toEqual([...bundle.macosAssets, ...bundle.trailingAssets]);
  });

  it('adds signed Linux artifacts to the updater manifest and upload list, using the published asset name', () => {
    const bundle = makeReleaseBundle(true);
    const plan = releasePlan(bundle);

    // publish-preview (.github/workflows/port-build.yml) re-uploads the local
    // "o8_<version>_amd64.AppImage" build output under
    // "o8_<version>_linux_amd64_preview.AppImage" — the manifest url must
    // match the published name, not the local build's basename, or the
    // updater 404s.
    expect(plan.latestJson.platforms['linux-x86_64']).toEqual({
      signature: 'linux-fixture-signature',
      url: 'https://github.com/example/releases/download/v0.1.999/o8_0.1.999_linux_amd64_preview.AppImage',
    });
    expect(plan.uploadArgs).toEqual([
      ...bundle.macosAssets,
      ...bundle.linuxAssets,
      ...bundle.trailingAssets,
    ]);
  });

  it('throws before upload when the Linux AppImage version does not match the release version', () => {
    const bundle = makeReleaseBundle(true, '0.1.998');
    expect(() => releasePlan(bundle)).toThrow(/does not match release version "0\.1\.999"/);
  });

  it('throws when the Linux AppImage filename does not match the expected naming pattern', () => {
    const bundleDir = mkdtempSync(join(tmpdir(), 'o8-release-bundle-'));
    roots.push(bundleDir);
    const appImageDir = join(bundleDir, 'appimage');
    mkdirSync(appImageDir, { recursive: true });
    writeFileSync(join(appImageDir, 'o8-unexpected-name.AppImage'), 'appimage');
    writeFileSync(join(appImageDir, 'o8-unexpected-name.AppImage.sig'), 'sig\n');

    expect(() =>
      buildReleaseManifest({
        bundleDir,
        version: '0.1.999',
        notes: 'o8 v0.1.999',
        pubDate: '2026-08-27T12:00:00.000Z',
        downloadBase: 'https://github.com/example/releases/download/v0.1.999',
        darwinArtifact: {
          signature: 'darwin-fixture-signature',
          identity: {
            kind: 'macos-universal-app',
            architectures: ['x86_64', 'arm64'],
            binaries: [],
          },
        },
      }),
    ).toThrow(/does not match the expected "o8_<version>_amd64\.AppImage" naming pattern/);
  });

  it('refuses to emit an arm64 updater entry for an x86_64-only macOS identity', () => {
    const bundle = makeReleaseBundle(false);
    expect(() => buildReleaseManifest({
      bundleDir: bundle.bundleDir,
      version: '0.1.999',
      notes: 'o8 v0.1.999',
      pubDate: '2026-08-27T12:00:00.000Z',
      downloadBase: 'https://github.com/example/releases/download/v0.1.999',
      darwinArtifact: {
        signature: 'darwin-fixture-signature',
        identity: {
          kind: 'macos-universal-app',
          architectures: ['x86_64'],
          binaries: [],
        },
      },
    })).toThrow('macOS updater artifact identity is missing arm64');
  });
});
