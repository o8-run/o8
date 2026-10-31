#!/usr/bin/env node
/** Build review artifacts only. This script never signs, uploads or releases. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLinuxGlibc } from '../ci/check-linux-glibc.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PAYLOAD_BUDGET = 512 * 1024 * 1024;
const ARTIFACT_BUDGET = 256 * 1024 * 1024;
const XKB_LIBRARIES = [
  ['libxkbcommon.so.0', 'libxkbcommon0'],
  ['libxkbcommon-x11.so.0', 'libxkbcommon-x11-0'],
  ['libxcb-xkb.so.1', 'libxcb-xkb1'],
];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
  return result.stdout;
}
function files(directory) {
  return readdirSync(directory).sort().flatMap(name => {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) return files(path);
    if (!stat.isFile()) throw new Error(`Unsupported payload entry: ${path}`);
    return [{ path, bytes: stat.size }];
  });
}
function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Build on Linux x64');
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--stage', '--output', '--appimagetool', '--runtime'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Expected --stage, --output, --appimagetool and --runtime');
    options[args[i]] = resolve(args[i + 1]);
  }
  if (Object.keys(options).length !== 4) throw new Error('All four packaging inputs are required');
  const stage = options['--stage'];
  const output = options['--output'];
  if (existsSync(output)) throw new Error('Output already exists; choose a new directory');
  const payloadFiles = files(stage);
  let payloadBytes = payloadFiles.reduce((sum, file) => sum + file.bytes, 0);
  if (payloadBytes > PAYLOAD_BUDGET) throw new Error(`Exceeded payload size budget: ${payloadBytes} > ${PAYLOAD_BUDGET}`);
  for (const name of ['usr/bin/o8', 'usr/lib/o8/node', 'usr/lib/o8/o8-next', 'usr/lib/o8/server/cli/desktop.mjs']) {
    if (!existsSync(join(stage, name))) throw new Error(`Incomplete stage: ${name}`);
  }
  const channel = JSON.parse(readFileSync(join(stage, 'usr/lib/o8/server/o8-build-channel.json'), 'utf8'));
  if (channel.schema !== 'o8/build-channel/v1' || channel.channel !== 'beta' || !/^\d+\.\d+\.\d+$/.test(channel.version)) throw new Error('Expected a versioned beta server export');
  const abi = checkLinuxGlibc([stage], { max: '2.39' });
  if (abi.failures.length) throw new Error(abi.failures.join('\n'));
  const scratch = mkdtempSync(join(tmpdir(), 'o8-linux-packages-'));
  try {
    const appdir = join(scratch, 'o8.AppDir');
    cpSync(stage, appdir, { recursive: true });
    cpSync(join(repository, 'scripts/linux/appimage-launch.mjs'), join(appdir, 'usr/lib/o8/appimage-launch.mjs'));
    const libraries = join(appdir, 'usr/lib/o8/lib');
    mkdirSync(libraries);
    for (const [name, distributionPackage] of XKB_LIBRARIES) {
      const source = run('cc', [`-print-file-name=${name}`]).trim();
      if (!isAbsolute(source) || !existsSync(source)) throw new Error(`Missing build-host runtime library: ${name}`);
      const file = realpathSync(source);
      if (!statSync(file).isFile()) throw new Error(`Expected a runtime library file: ${name}`);
      cpSync(file, join(libraries, name));
      cpSync(`/usr/share/doc/${distributionPackage}/copyright`, join(appdir, 'usr/share/doc/o8', `${distributionPackage}-copyright`));
    }
    const libraryAbi = checkLinuxGlibc([libraries], { max: '2.39' });
    if (libraryAbi.failures.length) throw new Error(libraryAbi.failures.join('\n'));
    const identity = createHash('sha256');
    for (const file of files(join(appdir, 'usr'))) identity.update(file.path.slice(appdir.length) + '\0' + file.bytes + '\0').update(readFileSync(file.path));
    const payloadId = identity.digest('hex');
    writeFileSync(join(appdir, 'AppRun'), `#!/bin/sh\nset -eu\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$DIR/usr/lib/o8/node" "$DIR/usr/lib/o8/appimage-launch.mjs" ${payloadId} "$@"\n`, { mode: 0o755 });
    chmodSync(join(appdir, 'AppRun'), 0o755);
    cpSync(join(appdir, 'usr/share/applications/o8.desktop'), join(appdir, 'o8.desktop'));
    cpSync(join(appdir, 'usr/share/icons/hicolor/256x256/apps/o8.png'), join(appdir, 'o8.png'));
    cpSync(join(appdir, 'o8.png'), join(appdir, '.DirIcon'));
    payloadBytes = files(appdir).reduce((sum, file) => sum + file.bytes, 0);
    if (payloadBytes > PAYLOAD_BUDGET) throw new Error(`Exceeded payload size budget: ${payloadBytes} > ${PAYLOAD_BUDGET}`);
    const debroot = join(scratch, 'deb');
    mkdirSync(join(debroot, 'DEBIAN'), { recursive: true });
    cpSync(join(appdir, 'usr'), join(debroot, 'usr'), { recursive: true });
    const dependencies = 'libc6 (>= 2.39), libgcc-s1, libstdc++6, libx11-6, libxcb1, libxkbcommon0, libxkbcommon-x11-0, libvulkan1, libfontconfig1, libfreetype6, libasound2t64, util-linux';
    writeFileSync(join(debroot, 'DEBIAN/control'), `Package: o8\nVersion: ${channel.version}\nArchitecture: amd64\nMaintainer: o8\nSection: devel\nPriority: optional\nDepends: ${dependencies}\nDescription: o8 next with the bundled o8 server\n`);
    const rpm = join(scratch, 'rpm');
    for (const dir of ['BUILD', 'BUILDROOT', 'RPMS', 'SOURCES', 'SPECS', 'SRPMS']) mkdirSync(join(rpm, dir), { recursive: true });
    cpSync(join(appdir, 'usr'), join(rpm, 'SOURCES/usr'), { recursive: true });
    const spec = join(rpm, 'SPECS/o8.spec');
    writeFileSync(spec, `Name: o8\nVersion: ${channel.version}\nRelease: 1\nSummary: o8 next with the bundled o8 server\nLicense: MIT\nBuildArch: x86_64\nAutoReqProv: no\nRequires: glibc >= 2.39, libgcc, libstdc++, libX11, libxcb, libxkbcommon, libxkbcommon-x11, vulkan-loader, fontconfig, freetype, alsa-lib, util-linux\n%description\no8 next and its bundled Node server.\n%prep\n%build\n%install\nmkdir -p %{buildroot}\ncp -a %{_sourcedir}/usr %{buildroot}/usr\n%files\n/usr/bin/o8\n/usr/lib/o8\n/usr/share/applications/o8.desktop\n/usr/share/icons/hicolor/256x256/apps/o8.png\n/usr/share/doc/o8\n`);
    mkdirSync(output); // Exclusive; never replace an operator's directory.
    const prefix = `o8_${channel.version}`;
    const artifacts = [
      { format: 'appimage', name: `${prefix}_linux_amd64_preview.AppImage` },
      { format: 'deb', name: `${prefix}_amd64.deb` },
      { format: 'rpm', name: `o8-${channel.version}-1.x86_64.rpm` },
    ];
    run(options['--appimagetool'], ['--appimage-extract-and-run', '--no-appstream', '--runtime-file', options['--runtime'], appdir, join(output, artifacts[0].name)],
      { env: { ...process.env, ARCH: 'x86_64' } });
    run('dpkg-deb', ['--build', '--root-owner-group', '-Zxz', debroot, join(output, artifacts[1].name)]);
    run('rpmbuild', ['-bb', '--define', `_topdir ${rpm}`, '--define', '__os_install_post %{nil}', '--define', 'debug_package %{nil}', '--define', '_binary_payload w6.gzdio', spec]);
    cpSync(join(rpm, 'RPMS/x86_64', artifacts[2].name), join(output, artifacts[2].name));
    for (const artifact of artifacts) {
      const file = join(output, artifact.name);
      artifact.bytes = statSync(file).size;
      if (artifact.bytes > ARTIFACT_BUDGET) throw new Error(`Exceeded artifact size budget: ${artifact.name}`);
      artifact.sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
    const receipt = { schema: 'o8/linux-downloads/v1', application: 'o8-next', channel: 'beta', version: channel.version,
      platform: 'linux-x86_64', published: false, maxGlibc: '2.39', payloadBytes, payloadId,
      budgets: { payloadBytes: PAYLOAD_BUDGET, artifactBytes: ARTIFACT_BUDGET }, artifacts };
    writeFileSync(join(output, 'linux-downloads.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(JSON.stringify(receipt));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
try { main(); } catch (error) { console.error(`Linux packaging failed: ${error.message}`); process.exitCode = 1; }
