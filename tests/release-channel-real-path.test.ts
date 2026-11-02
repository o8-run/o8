import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveReleaseChannel } from '../scripts/lib/release-channel.mjs';
import { bundleContentSha256, resolveMacosCpuArtifacts } from '../scripts/lib/macos-release-artifacts.mjs';
import { copyRuntimeArchive, runtimeFixtureUpdaterKey } from './helpers/signed-runtime-archive';

const roots: string[] = [];
const releaseScript = join(process.cwd(), 'scripts/release.mjs');
const speechBuildScript = join(process.cwd(), 'scripts/build-speech-local.mjs');
const signedFixtures = join(process.cwd(), 'tests/fixtures/release-channel');
const realReleaseRangeModule = pathToFileURL(join(process.cwd(), 'scripts/lib/fixed-reports.mjs')).href + '?fixture-real-range';
const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

function thinMachO(cpuType: number) {
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(cpuType, 4);
  return binary;
}

/** Extend public fixture bytes with the server inputs required by verification. */
function copySignedArchive(channel: 'stable' | 'preview', variant: string, archive: string, signature: string) {
  const source = join(signedFixtures, `${channel}-${variant}.tar.gz`);
  copyRuntimeArchive(source, archive, signature);
}

function fixture(version = '0.1.741-preview.1', variant = 'universal') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-release-channel-')));
  roots.push(root);
  const bundle = join(root, 'src-tauri/target/universal-apple-darwin/release/bundle');
  mkdirSync(join(bundle, 'macos'), { recursive: true });
  mkdirSync(join(bundle, 'dmg'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(bundle, 'dmg', `o8_${version}_universal.dmg`), 'fixture');
  const channel = version.includes('-preview.') ? 'preview' : 'stable';
  const archive = join(bundle, 'macos/o8.app.tar.gz');
  copySignedArchive(channel, variant, archive, archive + '.sig');
  const extracted = spawnSync('tar', ['xzf', archive, '-C', join(bundle, 'macos')]);
  if (extracted.status !== 0) throw new Error(`failed to extract public updater fixture: ${extracted.stderr}`);
  mkdirSync(join(root, 'src-tauri/helpers'), { recursive: true });
  copyFileSync(join(signedFixtures, 'next-build.json'), join(root, 'src-tauri/helpers/o8-next-build.json'));
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({
    plugins: { updater: { pubkey: runtimeFixtureUpdaterKey } },
  }));
  const dmgApp = join(root, 'dmg-fixture', 'o8.app');
  mkdirSync(join(dmgApp, '..'), { recursive: true });
  // Preserve archived directory modes as well as bytes in the simulated DMG.
  const copied = spawnSync('cp', ['-pR', join(bundle, 'macos', 'o8.app'), dmgApp]);
  if (copied.status !== 0) throw new Error(`DMG fixture copy failed: ${copied.stderr}`);
  const log = join(root, 'effects.jsonl');
  const prelude = `import { appendFileSync } from 'node:fs';
const record = (name, args = []) => appendFileSync(process.env.O8_CHANNEL_TEST_LOG, JSON.stringify({name, args}) + '\\n');`;
  const childProcess = `${prelude}
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const realChildProcess = process.getBuiltinModule('node:child_process');
export function execFileSync(command, args = [], options = {}) {
  if (command === 'tar') return realChildProcess.execFileSync(command, args, options);
  if (command === 'bash') record('changelogSource', [options.env?.O8_CHANGELOG_SOURCE_REF ?? process.env.O8_CHANGELOG_SOURCE_REF ?? 'origin/main']);
  if (args.includes('--sign') || args.includes('-s') || command === 'cargo' || (command === 'xcrun' && !args.includes('validate'))) {
    throw new Error('Tests cannot build, sign, or notarize');
  }
  record(command, args);
  if (command === 'codex') {
    writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ summary: 'Clearer workspace feedback.', entries: [{ text: 'Workspace feedback is easier to follow.', sourceIndices: [0] }] }));
    return '';
  }
  if (command.endsWith('hdiutil')) {
    if (args[0] === 'attach') {
      const mountpoint = args[args.indexOf('-mountpoint') + 1];
      const cpuApps = JSON.parse(process.env.O8_CHANNEL_TEST_CPU_DMG_APPS || '{}');
      const source = cpuApps[basename(args.at(-1))] || process.env.O8_CHANNEL_TEST_DMG_APP;
      realChildProcess.execFileSync('cp', ['-pR', source, join(mountpoint, 'o8.app')]);
      return '<plist><dict><key>system-entities</key><array><dict><key>dev-entry</key><string>/dev/disk99</string></dict></array></dict></plist>';
    }
    return '';
  }
  if (command.endsWith('codesign')) return '';
  if (command === 'xcrun' && args[0] === 'stapler' && process.env.O8_CHANNEL_TEST_FAIL_CPU_NOTARY === '1') {
    throw new Error('CPU notarization ticket unavailable');
  }
  if (command.endsWith('plutil')) {
    if (args[0] === '-convert') return JSON.stringify({ 'system-entities': [{ 'dev-entry': '/dev/disk99' }] });
    const plist = readFileSync(args[args.length - 1], 'utf8');
    const value = plist.match(/<key>CFBundleShortVersionString<\\/key>\\s*<string>([^<]+)<\\/string>/)?.[1];
    if (!value) throw new Error('missing fixture version');
    return value + '\\n';
  }
  if (command === 'gh' && args[0] === 'api') {
    if (process.env.O8_CHANNEL_TEST_NO_BASELINE === '1') throw new Error('published evidence unavailable');
    return JSON.stringify({ tag_name: 'v0.1.740', draft: false, prerelease: false, published_at: '2026-09-01T00:00:00Z' });
  }
  if (command === 'gh' && args[0] === 'release' && args[1] === 'view') {
    if (args.includes('--json')) return '2026-09-07T00:00:00Z';
    if (process.env.O8_CHANNEL_TEST_EXISTING === '1') return '{}';
    throw new Error('release not found');
  }
  if (command === 'gh' && args[1] === 'create' && args.includes('hurttlocker/o8-releases') && process.env.O8_CHANNEL_TEST_FAIL_MIRROR === '1') throw new Error('mirror unavailable');
  if (command === 'git' && args[0] === 'rev-parse') return (args.includes('refs/tags/v0.1.740^{commit}') ? 'b' : 'a').repeat(40);
  if (command === 'git' && args[0] === 'describe') return 'v' + process.env.O8_CHANNEL_TEST_VERSION;
  if (command === 'git' && args[0] === 'ls-remote') return 'a'.repeat(40) + '\\trefs/tags/v' + process.env.O8_CHANNEL_TEST_VERSION;
  if (command === 'git' && args[0] === 'log') return args.includes('--format=%H%x09%s') ? 'a'.repeat(40) + '\\tfix: improve workspace feedback' : 'fix: improve workspace feedback';
  return '';
}
export const spawn = () => { throw new Error('unexpected spawn'); };
export function spawnSync(command, args) {
  if (args.includes('--sign') || args.includes('-s')) throw new Error('Tests cannot sign');
  if (command === 'codesign') return { status: 0, stdout: '', stderr: 'TeamIdentifier=FIXTURE\\nCodeDirectory flags=0x10000(runtime)' };
  if (command !== '/usr/bin/codesign') throw new Error('unexpected spawnSync');
  if (args.includes('--verbose=4')) return { status: 0, stdout: '', stderr: 'Identifier=fixture\\nTeamIdentifier=not set\\nCodeDirectory flags=0x10000(runtime)\\nRuntime Version=15.0.0' };
  return { status: 0, stdout: args.includes('-r') ? 'designated => identifier fixture' : '', stderr: '' };
}`;
  const modules: Record<string, string> = {
    'node:child_process': childProcess,
    '/scripts/native-bundle.mjs': 'export function verifyNativeBundle() {}',
    '/scripts/sync-reports.mjs': `${prelude}\nexport async function syncReports() { record('syncReports'); return { status: 'disabled', fresh: [] }; }`,
    '/scripts/publish-fixed.mjs': `${prelude}\nexport async function publishFixed() { record('publishFixed'); }`,
    '/scripts/lib/fixed-reports.mjs': `${prelude}
export { releaseRange } from '${realReleaseRangeModule}';
export function resolveNewFixes() { record('resolveNewFixes'); return { entries: [{ id: 'fixture-report' }], missing: [] }; }
export function readPublished() { record('readPublished'); return []; }
export const buildManifest = (fixed) => ({ fixed });`,
  };
  // Only platform/provider edges are simulated. The actual release entry point,
  // channel policy, manifest writer, and publication control flow run unchanged.
  writeFileSync(join(root, 'loader.mjs'), `const modules = ${JSON.stringify(modules)};
export async function load(url, context, nextLoad) {
  if (url.endsWith('/scripts/lib/stable-release-effects.mjs') && process.env.O8_CHANNEL_TEST_CHANGELOG_BASELINE) {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL(url), 'utf8');
    const baseline = readFileSync(process.env.O8_CHANNEL_TEST_CHANGELOG_BASELINE, 'utf8');
    const start = source.indexOf('  function publishPublicRelease(');
    const end = source.indexOf('\\n  async function announceRelease()', start);
    if (start < 0 || end < 0) throw new Error('Missing changelog publisher boundary');
    return { format: 'module', shortCircuit: true, source: source.slice(0, start) + baseline + source.slice(end) };
  }
  const key = Object.keys(modules).find(key => url === key || url.endsWith(key));
  return key ? { format: 'module', shortCircuit: true, source: modules[key] } : nextLoad(url, context);
}`);
  writeFileSync(join(root, 'register.mjs'), `${prelude}
import { register } from 'node:module';
register(new URL('./loader.mjs', import.meta.url));
globalThis.fetch = async () => { record('announceRelease'); return { ok: true }; };`);
  return { root, bundle, dmgApp, log, version };
}

function run(f: ReturnType<typeof fixture>, channel: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', join(f.root, 'register.mjs'), releaseScript, ...args], {
    cwd: f.root,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH,
      HOME: f.root,
      O8_DATA_DIR: join(f.root, 'data'),
      CORTEX_IDE_DATA_DIR: join(f.root, 'data'),
      O8_RELEASE_CHANNEL: channel,
      O8_RELEASE_FEED_LOCK: join(f.root, 'publication.lock'),
      O8_RELEASE_SUMMARY_CACHE_DIR: join(f.root, 'summary-cache'),
      O8_CHANNEL_TEST_VERSION: f.version,
      O8_CHANNEL_TEST_LOG: f.log,
      O8_CHANNEL_TEST_DMG_APP: f.dmgApp,
      O8_RELEASES_WEBHOOK_URL: 'https://fixture.invalid/webhook',
      ...extraEnv,
    },
  });
}

function effects(f: ReturnType<typeof fixture>): Array<{ name: string; args: string[] }> {
  return existsSync(f.log) ? readFileSync(f.log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

function expectNoPublicationMutation(f: ReturnType<typeof fixture>) {
  const calls = effects(f);
  expect(calls.some(c => c.name === 'gh' && ['create', 'edit', 'upload'].includes(c.args[1])))
    .toBe(false);
  expect(calls.some(c => ['syncReports', 'publishFixed', 'announceRelease', 'bash'].includes(c.name)))
    .toBe(false);
  expect(existsSync(join(f.bundle, 'macos', 'latest.json'))).toBe(false);
}

function addCpuFixtures(f: ReturnType<typeof fixture>, architectures: Array<'x86_64' | 'arm64'> = ['x86_64', 'arm64']) {
  const source = join(f.bundle, 'macos/o8.app');
  const dmgApps: Record<string, string> = {};
  for (const architecture of architectures) {
    const cpu = resolveMacosCpuArtifacts(f.root, f.version, architecture);
    mkdirSync(join(cpu.app, '..'), { recursive: true });
    copySignedArchive(f.version.includes('-preview.') ? 'preview' : 'stable', architecture, cpu.updaterArchive, cpu.updaterSignature);
    const archive = spawnSync('tar', ['xzf', cpu.updaterArchive, '-C', join(cpu.app, '..')]);
    if (archive.status !== 0) throw new Error(`CPU archive fixture extraction failed: ${archive.stderr}`);
    mkdirSync(join(cpu.dmg, '..'), { recursive: true });
    writeFileSync(cpu.dmg, 'fixture');
    dmgApps[cpu.dmg.split('/').at(-1)!] = cpu.app;
  }
  writeFileSync(join(f.bundle, 'cpu/derivation.json'), JSON.stringify({
    schema: 'o8/macos-cpu-derivation/v1', version: f.version, sourceBundleSha256: bundleContentSha256(source),
  }));
  return { O8_MACOS_CPU_PACKAGES: '1', O8_CHANNEL_TEST_CPU_DMG_APPS: JSON.stringify(dmgApps) };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('release channels through the publication entry point', () => {
  it.each(['HEAD', undefined])('keeps the origin/main direct-publication changelog source with override %s', sourceRef => {
    const baseline = fixture('0.1.741');
    const current = fixture('0.1.741');
    const env: Record<string, string> = sourceRef ? { O8_CHANGELOG_SOURCE_REF: sourceRef } : {};
    // Run the captured origin/main publisher inside the same real direct-release
    // entry point, without requiring remote-tracking refs in a shallow CI checkout.
    const before = run(baseline, 'stable', [], { ...env,
      O8_CHANNEL_TEST_CHANGELOG_BASELINE: join(signedFixtures, 'origin-main-public-changelog.txt') });
    const after = run(current, 'stable', [], env);
    expect(before.status, before.stdout + before.stderr).toBe(0);
    expect(after.status, after.stdout + after.stderr).toBe(0);
    const sources = (f: ReturnType<typeof fixture>) => effects(f).filter(call => call.name === 'changelogSource').map(call => call.args);
    expect(sources(baseline)).toEqual([[sourceRef ?? 'origin/main']]);
    expect(sources(current)).toEqual(sources(baseline));
  });
  it.each(['app', 'updater', 'installer'] as const)('refuses publication when the required o8 next binary is missing from the %s', (distribution) => {
    const f = fixture('0.1.741');
    if (distribution === 'updater') {
      const archive = join(f.bundle, 'macos/o8.app.tar.gz');
      copySignedArchive('stable', 'missing-next', archive, archive + '.sig');
    } else {
      const app = distribution === 'app' ? join(f.bundle, 'macos/o8.app') : f.dmgApp;
      rmSync(join(app, 'Contents/MacOS/o8-next'), { force: true });
    }
    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    const prefix = distribution === 'updater' ? 'archived ' : distribution === 'installer' ? 'DMG ' : '';
    expect(result.stderr).toContain(`${prefix}Contents/MacOS/o8-next is missing from the macOS app bundle`);
    expectNoPublicationMutation(f);
  });

  it.each(['hash', 'commit'] as const)('refuses matching stale app, archive and DMG with an old sidecar %s before publication', kind => {
    const f = fixture('0.1.741', `stale-next-${kind}`);
    const result = run(f, 'stable');
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toMatch(/o8 next.*current build/);
    expectNoPublicationMutation(f);
  });

  it.each([
    { channel: 'stable', version: '0.1.741', manifest: 'latest.json' },
    { channel: 'preview', version: '0.1.741-preview.1', manifest: 'preview.json' },
  ])('publishes Intel-only delivery through the $channel fixture without requiring an arm64 package', ({ channel, version, manifest }) => {
    const f = fixture(version);
    const env = { ...addCpuFixtures(f, ['x86_64']), O8_MACOS_CPU_PACKAGES: 'x86_64' };
    const result = run(f, channel, [], env);
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(readFileSync(join(f.bundle, 'macos', manifest), 'utf8'));
    expect(plan.platforms['darwin-x86_64'].url).toMatch(/o8_x86_64\.app\.tar\.gz$/);
    expect(plan.platforms['darwin-aarch64']).toEqual({
      url: `https://github.com/hurttlocker/o8-releases/releases/download/v${version}/o8.app.tar.gz`,
      signature: readFileSync(join(f.bundle, 'macos/o8.app.tar.gz.sig'), 'utf8').trim(),
    });
    const uploads = effects(f).filter(c => c.name === 'gh' && ['create', 'upload'].includes(c.args[1]));
    expect(uploads.some(c => c.args.some(arg => arg.endsWith('/o8.app.tar.gz')))).toBe(true);
    expect(uploads.some(c => c.args.some(arg => arg.endsWith('/o8_x86_64.app.tar.gz')))).toBe(true);
    expect(uploads.some(c => c.args.some(arg => arg.includes('/cpu/arm64/')))).toBe(false);
    if (channel === 'preview') expect(existsSync(join(f.bundle, 'macos/latest.json'))).toBe(false);
  });

  it('does not route or upload an unselected arm64 package during Intel-only delivery', () => {
    const f = fixture('0.1.741');
    const env = { ...addCpuFixtures(f), O8_MACOS_CPU_PACKAGES: 'x86_64' };
    const arm = resolveMacosCpuArtifacts(f.root, f.version, 'arm64');
    writeFileSync(arm.updaterSignature, 'unaccepted arm64 package');
    const result = run(f, 'stable', [], env);
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(readFileSync(join(f.bundle, 'macos/latest.json'), 'utf8'));
    expect(plan.platforms['darwin-aarch64'].url).toMatch(/\/o8\.app\.tar\.gz$/);
    expect(effects(f).some(c => c.args.some(arg => arg.includes('/cpu/arm64/')))).toBe(false);
  });

  it.each(['missing', 'wrong-cpu', 'changed-runtime', 'bad-signature', 'not-notarized'])('refuses Intel-only publication for %s before any publication write', (failure) => {
    const f = fixture('0.1.741');
    const env: Record<string, string> = { ...addCpuFixtures(f, ['x86_64']), O8_MACOS_CPU_PACKAGES: 'x86_64' };
    const cpu = resolveMacosCpuArtifacts(f.root, f.version, 'x86_64');
    if (failure === 'missing') rmSync(cpu.updaterArchive);
    if (failure === 'wrong-cpu') writeFileSync(join(cpu.app, 'Contents/MacOS/speech-local'), thinMachO(CPU_TYPE_ARM64));
    if (failure === 'changed-runtime') writeFileSync(join(cpu.app, 'Contents/runtime.txt'), 'changed runtime');
    if (failure === 'bad-signature') writeFileSync(cpu.updaterSignature, 'invalid signature');
    if (failure === 'not-notarized') env.O8_CHANNEL_TEST_FAIL_CPU_NOTARY = '1';
    const result = run(f, 'stable', [], env);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('CPU package verification failed');
    expectNoPublicationMutation(f);
  });

  it.each([
    { channel: 'stable', version: '0.1.741', manifest: 'latest.json' },
    { channel: 'preview', version: '0.1.741-preview.1', manifest: 'preview.json' },
  ])('publishes verified CPU entries through the $channel fixture path and keeps universal uploads', ({ channel, version, manifest }) => {
    const f = fixture(version);
    const env = addCpuFixtures(f);
    const result = run(f, channel, [], env);
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(readFileSync(join(f.bundle, 'macos', manifest), 'utf8'));
    expect(plan.platforms['darwin-x86_64'].url).toMatch(/o8_x86_64\.app\.tar\.gz$/);
    expect(plan.platforms['darwin-aarch64'].url).toMatch(/o8_arm64\.app\.tar\.gz$/);
    const uploads = effects(f).filter(c => c.name === 'gh' && ['create', 'upload'].includes(c.args[1]));
    expect(uploads.some(c => c.args.some(arg => arg.endsWith('/o8.app.tar.gz')))).toBe(true);
    expect(uploads.some(c => c.args.some(arg => arg.endsWith('/o8_arm64.app.tar.gz')))).toBe(true);
    if (channel === 'preview') expect(existsSync(join(f.bundle, 'macos/latest.json'))).toBe(false);
  });

  it.each([
    { channel: 'stable', version: '0.1.741', manifest: 'latest.json' },
    { channel: 'preview', version: '0.1.741-preview.1', manifest: 'preview.json' },
  ])('generates the $channel feed from all three macOS distributions and retains every download', ({ channel, version, manifest }) => {
    const f = fixture(version);
    const result = run(f, channel, [], addCpuFixtures(f));
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(readFileSync(join(f.bundle, 'macos', manifest), 'utf8'));
    const uploads = effects(f).filter(c => c.name === 'gh' && ['create', 'upload'].includes(c.args[1]));
    const uploaded = new Set(uploads.flatMap(c => c.args.map(arg => arg.split('/').at(-1))));
    for (const name of [`o8_${version}_universal.dmg`, 'o8.app.tar.gz', 'o8.app.tar.gz.sig']) {
      expect(uploaded.has(name), name).toBe(true);
    }
    for (const [architecture, platform] of [['x86_64', 'darwin-x86_64'], ['arm64', 'darwin-aarch64']] as const) {
      const cpu = resolveMacosCpuArtifacts(f.root, version, architecture);
      expect(plan.platforms[platform].url).toMatch(new RegExp(`/o8_${architecture}\\.app\\.tar\\.gz$`));
      expect(plan.platforms[platform].signature).toBe(readFileSync(cpu.updaterSignature, 'utf8').trim());
      for (const name of [`o8_${version}_${architecture}.dmg`, `o8_${architecture}.app.tar.gz`, `o8_${architecture}.app.tar.gz.sig`]) {
        expect(uploaded.has(name), name).toBe(true);
      }
    }
  });

  it.each([
    { channel: 'stable', version: '0.1.741', manifest: 'latest.json' },
    { channel: 'preview', version: '0.1.741-preview.1', manifest: 'preview.json' },
  ])('generates an Apple Silicon-only $channel feed without requiring an Intel package', ({ channel, version, manifest }) => {
    const f = fixture(version);
    const result = run(f, channel, [], { ...addCpuFixtures(f, ['arm64']), O8_MACOS_CPU_PACKAGES: 'arm64' });
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(readFileSync(join(f.bundle, 'macos', manifest), 'utf8'));
    expect(plan.platforms['darwin-aarch64'].url).toMatch(/o8_arm64\.app\.tar\.gz$/);
    expect(plan.platforms['darwin-x86_64']).toMatchObject({
      signature: readFileSync(join(f.bundle, 'macos/o8.app.tar.gz.sig'), 'utf8').trim(),
      url: expect.stringMatching(/\/o8\.app\.tar\.gz$/),
    });
    const uploads = effects(f).filter(c => c.name === 'gh' && ['create', 'upload'].includes(c.args[1]));
    expect(uploads.some(c => c.args.some(arg => /o8_[^/]*x86_64/.test(arg)))).toBe(false);
  });

  it.each(['missing', 'wrong-cpu', 'changed-code', 'changed-runtime', 'bad-signature', 'not-notarized'])('refuses CPU publication for %s before any publication write', (failure) => {
    const f = fixture('0.1.741');
    const env: Record<string, string> = addCpuFixtures(f);
    const cpu = resolveMacosCpuArtifacts(f.root, f.version, 'arm64');
    if (failure === 'missing') rmSync(cpu.updaterArchive);
    if (failure === 'wrong-cpu') writeFileSync(join(cpu.app, 'Contents/MacOS/speech-local'), thinMachO(CPU_TYPE_X86_64));
    if (failure === 'changed-code') {
      const bytes = thinMachO(CPU_TYPE_ARM64);
      bytes[28] = 1;
      writeFileSync(join(cpu.app, 'Contents/MacOS/o8'), bytes);
    }
    if (failure === 'changed-runtime') writeFileSync(join(cpu.app, 'Contents/runtime.txt'), 'changed runtime');
    if (failure === 'bad-signature') writeFileSync(cpu.updaterSignature, 'invalid signature');
    if (failure === 'not-notarized') env.O8_CHANNEL_TEST_FAIL_CPU_NOTARY = '1';
    const result = run(f, 'stable', [], env);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('CPU package verification failed');
    expectNoPublicationMutation(f);
  });

  it('publishes two immutable prereleases without reaching any stable surface', () => {
    const f = fixture();
    const result = run(f, 'preview');
    expect(result.status, result.stderr).toBe(0);
    const calls = effects(f);
    const creates = calls.filter(c => c.name === 'gh' && c.args[1] === 'create');
    expect(creates).toHaveLength(2);
    expect(creates.map(call => call.args[call.args.indexOf('-R') + 1]))
      .toEqual(['o8-run/o8', 'hurttlocker/o8-releases']);
    expect(calls.filter(call => call.name === 'codex')).toHaveLength(1);
    expect(calls.findIndex(call => call.name === 'codex')).toBeLessThan(calls.findIndex(call => call.name === 'gh' && call.args[1] === 'create'));
    const mirror = creates.find(call => call.args.includes('hurttlocker/o8-releases'))!;
    expect(mirror.args[mirror.args.indexOf('--notes') + 1]).toContain('## What’s changed\n\nClearer workspace feedback.');
    expect(JSON.parse(readFileSync(join(f.root, 'summary-cache', `${f.version}.json`), 'utf8')).status).toBe('generated');
    for (const call of creates) {
      expect(call.args).toContain('--prerelease');
      expect(call.args).toContain('--latest=false');
      expect(call.args).toContain(join(f.bundle, 'macos', 'preview.json'));
      expect(call.args.some(arg => arg.endsWith('/latest.json') || arg.endsWith('/fixed.json'))).toBe(false);
    }
    expect(calls.some(c => ['syncReports', 'resolveNewFixes', 'readPublished', 'publishFixed', 'announceRelease', 'bash'].includes(c.name))).toBe(false);
    expect(existsSync(join(f.bundle, 'macos', 'latest.json'))).toBe(false);
    expect(existsSync(join(f.bundle, 'macos', 'fixed.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(f.bundle, 'macos', 'preview.json'), 'utf8'))).toMatchObject({ version: f.version });
    expect(result.stdout).not.toContain('installed o8.app will pick up');
  });

  it('retains stable publication, receipts and announcements without pushing source archives', () => {
    const f = fixture('0.1.741');
    mkdirSync(join(f.root, 'release-notes'));
    writeFileSync(join(f.root, 'release-notes', 'next.md'), '- Improve workspace feedback.\n');
    const result = run(f, 'stable');
    expect(result.status, result.stderr).toBe(0);
    const calls = effects(f);
    expect(calls.some(c => c.name === 'gh' && c.args[0] === 'api')).toBe(true);
    expect(calls.some(c => c.name === 'git' && c.args[0] === 'merge-base'
      && c.args.includes('b'.repeat(40)) && c.args.includes('a'.repeat(40)))).toBe(true);
    expect(calls.filter(c => c.name === 'gh' && c.args[1] === 'create')).toHaveLength(2);
    expect(calls.some(c => c.args.includes('--prerelease'))).toBe(false);
    for (const name of ['syncReports', 'resolveNewFixes', 'publishFixed', 'announceRelease', 'bash']) {
      expect(calls.some(c => c.name === name), name).toBe(true);
    }
    expect(existsSync(join(f.bundle, 'macos', 'latest.json'))).toBe(true);
    expect(existsSync(join(f.bundle, 'macos', 'fixed.json'))).toBe(true);
    expect(existsSync(join(f.root, 'release-notes', 'next.md'))).toBe(true);
    expect(calls.some(c => c.name === 'git' && ['add', 'commit', 'push'].includes(c.args[0]))).toBe(false);
  });

  it('refuses Stable publication when its real published-ancestor lookup has no evidence', () => {
    const f = fixture('0.1.741');
    const result = run(f, 'stable', [], { O8_CHANNEL_TEST_NO_BASELINE: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot read published release evidence');
    expectNoPublicationMutation(f);
  });

  it('refuses publication when the app backing the arm64 updater entry is x86_64-only', () => {
    const f = fixture('0.1.741');
    writeFileSync(join(f.bundle, 'macos', 'o8.app', 'Contents', 'MacOS', 'o8'), thinMachO(CPU_TYPE_X86_64));

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing required Mach-O architecture arm64');
    expect(effects(f).some(c => c.name === 'gh' && ['create', 'edit', 'upload'].includes(c.args[1])))
      .toBe(false);
    expect(existsSync(join(f.bundle, 'macos', 'latest.json'))).toBe(false);
  });

  it('refuses publication when the separately staged updater archive is thin', () => {
    const f = fixture('0.1.741');
    const archive = join(f.bundle, 'macos/o8.app.tar.gz');
    copySignedArchive('stable', 'thin-main', archive, archive + '.sig');

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('archived Contents/MacOS/o8 is missing required Mach-O architecture arm64');
    expect(effects(f).some(c => c.name === 'gh' && ['create', 'edit', 'upload'].includes(c.args[1])))
      .toBe(false);
  });

  it('refuses publication when the separately staged updater archive is stale', () => {
    const f = fixture('0.1.741');
    writeFileSync(join(f.bundle, 'macos', 'o8.app', 'Contents', 'release-identity.txt'), 'new build');

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('updater archive contents do not match the inspected macOS app bundle');
    expect(effects(f).some(c => c.name === 'gh' && ['create', 'edit', 'upload'].includes(c.args[1])))
      .toBe(false);
  });

  it('refuses publication when the updater signature is invalid', () => {
    const f = fixture('0.1.741');
    writeFileSync(join(f.bundle, 'macos', 'o8.app.tar.gz.sig'), 'not-a-signature');

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('updater signature does not verify against the configured public key');
    expectNoPublicationMutation(f);
  });

  it('refuses publication when the signature covers stale updater bytes', () => {
    const f = fixture('0.1.741');
    const archivePath = join(f.bundle, 'macos', 'o8.app.tar.gz');
    const previousArchive = readFileSync(archivePath);
    const main = join(f.bundle, 'macos', 'o8.app', 'Contents', 'MacOS', 'o8');
    const changedTime = new Date('2026-09-29T12:00:00.000Z');
    utimesSync(main, changedTime, changedTime);
    const archive = spawnSync('tar', ['czf', archivePath, '-C', join(f.bundle, 'macos'), 'o8.app']);
    if (archive.status !== 0) throw new Error(`failed to replace updater fixture: ${archive.stderr}`);
    expect(readFileSync(archivePath)).not.toEqual(previousArchive);

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('updater signature does not verify against the configured public key');
    expectNoPublicationMutation(f);
  });

  it('refuses publication when the DMG app is thin', () => {
    const f = fixture('0.1.741');
    writeFileSync(join(f.dmgApp, 'Contents', 'MacOS', 'o8'), thinMachO(CPU_TYPE_X86_64));

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DMG Contents/MacOS/o8 is missing required Mach-O architecture arm64');
    expectNoPublicationMutation(f);
  });

  it('refuses publication when the DMG app differs from the updater app', () => {
    const f = fixture('0.1.741');
    writeFileSync(join(f.dmgApp, 'Contents', 'installer-only.txt'), 'stale installer');

    const result = run(f, 'stable');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DMG app contents do not match the inspected macOS app bundle');
    expectNoPublicationMutation(f);
  });

  it.skipIf(process.platform !== 'darwin')('invalidates a stale universal speech helper when only the thin fallback succeeds', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-speech-fallback-')));
    roots.push(root);
    const scripts = join(root, 'scripts');
    const helpers = join(root, 'src-tauri', 'helpers');
    const armBuild = join(root, 'src-tauri', 'sidecars', 'speech-local', '.build', 'arm64-apple-macosx', 'release');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(helpers, { recursive: true });
    mkdirSync(armBuild, { recursive: true });
    copyFileSync(speechBuildScript, join(scripts, 'build-speech-local.mjs'));
    writeFileSync(join(helpers, 'speech-local'), 'old-generic');
    writeFileSync(join(helpers, 'speech-local-aarch64-apple-darwin'), 'old-arm');
    writeFileSync(join(helpers, 'speech-local-universal-apple-darwin'), 'old-universal');
    writeFileSync(join(helpers, 'speech-local-x86_64-apple-darwin'), 'old-intel');
    writeFileSync(join(armBuild, 'speech-local'), 'new-arm');
    writeFileSync(join(root, 'loader.mjs'), `export async function load(url, context, nextLoad) {
  if (url !== 'node:child_process') return nextLoad(url, context);
  return { format: 'module', shortCircuit: true, source: \`export function execSync(command) {
    if (command.includes('arm64 --arch x86_64')) throw new Error('forced universal failure');
    return Buffer.from('');
  }\` };
}`);

    const result = spawnSync(process.execPath, ['--experimental-loader', join(root, 'loader.mjs'), join(scripts, 'build-speech-local.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, O8_TAURI_BUILD_TARGET: 'universal-apple-darwin' },
    });

    expect(result.status).toBe(1);
    expect(readFileSync(join(helpers, 'speech-local'), 'utf8')).toBe('new-arm');
    expect(readFileSync(join(helpers, 'speech-local-aarch64-apple-darwin'), 'utf8')).toBe('new-arm');
    expect(readFileSync(join(helpers, 'speech-local-x86_64-apple-darwin'), 'utf8')).toBe('old-intel');
    expect(existsSync(join(helpers, 'speech-local-universal-apple-darwin'))).toBe(false);
  });

  it.each([
    { environment: 'stable', version: '0.1.741-preview.1', channel: 'preview', manifest: 'preview.json' },
    { environment: 'preview', version: '0.1.741', channel: 'stable', manifest: 'latest.json' },
    { environment: 'nightly', version: '0.1.741-preview.1', channel: 'preview', manifest: 'preview.json' },
  ])('uses signed $channel artifact identity despite the $environment environment', ({ environment, version, channel, manifest }) => {
    const f = fixture(version);
    const result = run(f, environment);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(f.bundle, 'macos', manifest), 'utf8'))).toMatchObject({ version, channel });
    if (channel === 'preview') {
      expect(existsSync(join(f.bundle, 'macos/latest.json'))).toBe(false);
      expect(effects(f).some(call => ['syncReports', 'publishFixed', 'announceRelease', 'bash'].includes(call.name))).toBe(false);
    }
  });

  it.each([
    ['0.1.741', '0.1.741-preview.1'],
    ['0.1.741-preview.1', '0.1.741'],
  ])('refuses relabelling the signed %s archive as %s', (artifactVersion, requestedVersion) => {
    const f = fixture(artifactVersion);
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ version: requestedVersion }));
    const result = run(f, requestedVersion.includes('-preview.') ? 'preview' : 'stable');
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('Signed build channel identity does not match this publisher.');
    expectNoPublicationMutation(f);
  });

  it('refuses preview clobber before artifact or publication effects', () => {
    const f = fixture();
    const result = run(f, 'preview', [], { O8_RELEASE_CLOBBER: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Preview artifacts are immutable');
    expect(effects(f)).toEqual([]);
  });

  it('prints a write-free preview plan through dry-run', () => {
    const f = fixture();
    const result = run(f, 'preview', ['--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ channel: 'preview', publishStableEffects: false, manifestName: 'preview.json' });
    expect(effects(f)).toEqual([]);
  });

  it('refuses manual stable announcements for a preview', () => {
    const f = fixture();
    expect(run(f, 'preview', ['--announce']).status).toBe(1);
    expect(effects(f)).toEqual([]);
  });

  it('refuses to replace an existing candidate', () => {
    const f = fixture();
    expect(run(f, 'preview', [], { O8_CHANNEL_TEST_EXISTING: '1' }).status).toBe(1);
    expect(effects(f).some(c => c.name === 'gh' && ['create', 'edit', 'upload'].includes(c.args[1]))).toBe(false);
  });

  it('reports mirror failure without claiming a usable preview', () => {
    const f = fixture();
    const result = run(f, 'preview', [], { O8_CHANNEL_TEST_FAIL_MIRROR: '1' });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('Preview published for explicit');
    expect(effects(f).some(c => ['publishFixed', 'announceRelease', 'bash'].includes(c.name))).toBe(false);
  });

  it('keeps ordinary stable versions as the default policy', () => {
    expect(resolveReleaseChannel('0.1.741', {})).toMatchObject({ channel: 'stable', githubFlags: [], manifestName: 'latest.json' });
  });

  it('keeps the manual hosted fallback draft-only and preview-only', () => {
    const workflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
    expect(workflow).toContain("github.ref_type == 'tag'");
    expect(workflow).toContain('O8_RELEASE_CHANNEL: preview');
    expect(workflow).toContain('needs: validate-preview');
    expect(workflow).toContain('Could not verify release absence.');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('releaseDraft: true');
    expect(workflow).toContain('prerelease: true');
    expect(workflow).not.toContain('schedule:');
  });
});
