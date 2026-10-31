import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { stagePackagedNativeAddons } from './helpers/packaged-native-addons';

const root = mkdtempSync(join(tmpdir(), 'o8-download-packages-'));
const stage = join(root, 'stage');
const packager = resolve('scripts/linux/package-payload.mjs');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
function run(file: string, args: string[], env = process.env) {
  return spawnSync(file, args, { env, encoding: 'utf8', timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
}
function packagePayload(input: string, output: string) {
  return run(process.execPath, [packager, '--stage', input, '--output', output,
    '--appimagetool', process.env.O8_APPIMAGETOOL || join(process.env.HOME!, 'linux-dl-cache/appimagetool-1.9.1-x86_64.AppImage'),
    '--runtime', process.env.O8_APPIMAGE_RUNTIME || join(process.env.HOME!, 'linux-dl-cache/type2-runtime-fedfad51-x86_64')]);
}
beforeAll(() => {
  const server = join(root, 'server');
  const runtime = join(root, 'node');
  mkdirSync(join(server, 'bin'), { recursive: true });
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  cpSync(process.execPath, join(runtime, 'bin/node'));
  writeFileSync(join(runtime, 'LICENSE'), 'fixture runtime license');
  const cli = run(process.execPath, ['cli/esbuild.config.mjs']);
  expect(cli.status, cli.stderr).toBe(0);
  cpSync('cli/dist/o8.mjs', join(server, 'bin/o8.mjs'));
  stagePackagedNativeAddons({ projectRoot: process.cwd(), serverRoot: server });
  writeFileSync(join(server, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(join(server, 'o8-build-channel.json'), JSON.stringify({ schema: 'o8/build-channel/v1', channel: 'beta', version }));
  writeFileSync(join(server, 'server.js'), `
    if (process.env.O8_FIXTURE_REQUIRE_BUNDLED_XKB) {
      const path = require('node:path');
      const probe = require('node:child_process').spawnSync(path.join(__dirname, '../o8-next'), [], {
        encoding: 'utf8', env: { ...process.env, LD_DEBUG: 'libs' },
      });
      const libraries = ['libxkbcommon-x11.so.0', 'libxkbcommon.so.0', 'libxcb-xkb.so.1'];
      if (probe.status !== 0 || !libraries.every(name => probe.stderr.split('\\n').some(line =>
        line.includes('calling init:') && line.trim().endsWith(path.join(__dirname, '../lib', name))))) {
        throw new Error('Native process did not load the bundled XKB runtime: ' + probe.stderr);
      }
    }
    require('node:http').createServer((req,res)=>res.end(JSON.stringify({product:'o8'})))
      .listen(Number(process.env.PORT), '127.0.0.1');
  `);
  writeFileSync(join(server, 'ws-server.mjs'), `
    import { createServer } from 'node:net';
    createServer(s=>s.end()).listen(Number(process.env.O8_WS_PORT), '127.0.0.1');
  `);
  const source = join(root, 'next.c');
  const next = join(root, 'o8-next');
  writeFileSync(source, 'extern int xkb_x11_get_core_keyboard_device_id(void*); int (*volatile dependency)(void*) = xkb_x11_get_core_keyboard_device_id; int main(void) { return dependency == 0; }');
  expect(run('cc', [source, '-o', next, '-l:libxkbcommon-x11.so.0']).status).toBe(0);
  const staged = run(process.execPath, ['scripts/linux/stage-payload.mjs', '--server', server,
    '--node-root', runtime, '--next-binary', next, '--output', stage]);
  expect(staged.status, staged.stderr).toBe(0);
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('initializes Next build telemetry with the workflow environment without creating compiler settings', () => {
  const workflow = parse(readFileSync('.github/workflows/linux-downloads.yml', 'utf8'));
  const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true' };
  delete env.NEXT_TELEMETRY_DISABLED;
  Object.assign(env, workflow.jobs.build.env);
  const output = join(root, 'next-build-output');
  mkdirSync(output);
  const initialized = run(process.execPath, ['-e',
    "new (require('next/dist/telemetry/storage').Telemetry)({ distDir: process.argv[1] });", output], env);
  expect(initialized.status, initialized.stderr).toBe(0);
  // Next's telemetry settings use an atomic writer outside the compiler's
  // receipt path. A build must not leave those settings in its reserved tree.
  expect(readdirSync(join(output, 'cache'))).toEqual([]);
});

it.skipIf(process.platform !== 'linux' || process.env.O8_LINUX_PACKAGE_TESTS !== 'true')('builds and runs three real package formats; AppImage daemon survives runtime cleanup and relocation', () => {
  const output = join(root, 'packages');
  const built = packagePayload(stage, output);
  expect(built.status, built.stderr + built.stdout).toBe(0);
  const receipt = JSON.parse(readFileSync(join(output, 'linux-downloads.json'), 'utf8'));
  expect(receipt).toMatchObject({ application: 'o8-next', channel: 'beta', version, published: false,
    platform: 'linux-x86_64', maxGlibc: '2.39' });
  expect(receipt.artifacts).toHaveLength(3);
  for (const artifact of receipt.artifacts) {
    const file = join(output, artifact.name);
    const bytes = readFileSync(file);
    expect(bytes.length).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(artifact.bytes).toBe(bytes.length);
    const extracted = join(root, artifact.format);
    mkdirSync(extracted);
    const extraction = artifact.format === 'deb' ? run('dpkg-deb', ['-x', file, extracted])
      : artifact.format === 'rpm' ? { status: 0, stderr: '' }
        : spawnSync(file, ['--appimage-extract'], { cwd: extracted, encoding: 'utf8' });
    // rpm2cpio's consumer must have an explicit extraction cwd.
    if (artifact.format === 'rpm') {
      const cpio = spawnSync('rpm2cpio', [file], { maxBuffer: 512 * 1024 * 1024 });
      expect(cpio.status).toBe(0);
      expect(spawnSync('cpio', ['-idm', '--quiet'], { cwd: extracted, input: cpio.stdout }).status).toBe(0);
    } else expect(extraction.status, String(extraction.stderr)).toBe(0);
    const installed = artifact.format === 'appimage' ? join(extracted, 'squashfs-root') : extracted;
    expect(run(join(installed, 'usr/bin/o8'), ['version']).stdout).toContain(version);
    expect(createHash('sha256').update(readFileSync(join(installed, 'usr/lib/o8/node'))).digest('hex'))
      .toBe(createHash('sha256').update(readFileSync(join(stage, 'usr/lib/o8/node'))).digest('hex'));
    expect(createHash('sha256').update(readFileSync(join(installed, 'usr/lib/o8/o8-next'))).digest('hex'))
      .toBe(createHash('sha256').update(readFileSync(join(stage, 'usr/lib/o8/o8-next'))).digest('hex'));
  }
  const abi = run(process.execPath, ['scripts/ci/check-linux-glibc.mjs', '--max', '2.39',
    ...receipt.artifacts.map((a: { name: string }) => join(output, a.name))]);
  expect(abi.status, abi.stderr).toBe(0);
  expect(abi.stdout.match(/ELF files/g)).toHaveLength(3);
  const appimage = join(output, receipt.artifacts.find((a: { format: string }) => a.format === 'appimage').name);
  const env = { ...process.env, HOME: join(root, 'home'), XDG_DATA_HOME: join(root, 'home/data'),
    O8_DATA_DIR: join(root, 'profile'), CORTEX_IDE_DATA_DIR: join(root, 'profile'),
    APPIMAGE_EXTRACT_AND_RUN: '1', O8_FIXTURE_REQUIRE_BUNDLED_XKB: '1' };
  const moved = join(root, 'moved.AppImage');
  cpSync(appimage, moved);
  try {
    const started = run(appimage, ['serve'], env);
    expect(started.status, started.stderr + started.stdout).toBe(0);
    const first = JSON.parse(run(appimage, ['serve', 'status'], env).stdout);
    expect(first.healthy).toBe(true);
    const second = JSON.parse(run(moved, ['serve', 'status'], env).stdout);
    expect(second.healthy).toBe(true);
    expect(second.pid).toBe(first.pid);
    expect(readdirSync(join(env.XDG_DATA_HOME, 'o8/appimage'))).toHaveLength(1);
  } finally { expect(run(moved, ['serve', 'stop'], env).status).toBe(0); }
}, 180_000);

it.skipIf(process.platform !== 'linux')('rejects an oversized payload before building or creating output', () => {
  const oversized = join(root, 'oversized');
  cpSync(stage, oversized, { recursive: true });
  writeFileSync(join(oversized, 'large'), '');
  truncateSync(join(oversized, 'large'), 513 * 1024 * 1024);
  const output = join(root, 'oversized-output');
  const result = packagePayload(oversized, output);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('payload size budget');
  expect(existsSync(output)).toBe(false);
});

it.skipIf(process.platform !== 'linux')('preserves an existing output directory', () => {
  const output = join(root, 'existing-output');
  mkdirSync(output);
  writeFileSync(join(output, 'keep'), 'operator-owned');
  const result = packagePayload(stage, output);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Output already exists');
  expect(readFileSync(join(output, 'keep'), 'utf8')).toBe('operator-owned');
});

it.skipIf(process.platform !== 'linux')('rejects a shipped ELF above the Ubuntu 24.04 glibc ceiling', () => {
  const input = join(root, 'newer-glibc');
  cpSync(stage, input, { recursive: true });
  const source = join(root, 'future.c');
  const versions = join(root, 'future.map');
  writeFileSync(source, 'int future(void) { return 1; }');
  writeFileSync(versions, 'GLIBC_99.0 { global: future; };');
  expect(run('cc', ['-shared', '-fPIC', source, `-Wl,--version-script=${versions}`,
    '-o', join(input, 'usr/lib/o8/future.so')]).status).toBe(0);
  const output = join(root, 'newer-glibc-output');
  const result = packagePayload(input, output);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('needs GLIBC_99.0');
  expect(existsSync(output)).toBe(false);
});
