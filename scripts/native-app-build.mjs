#!/usr/bin/env node
// Assembles the macOS app with the launcher as its main program, without the
// classic shell (#6130). It writes the bundle where the classic build does, so
// signing, notarization and the release checks run on it unchanged.
//
//   node scripts/native-app-build.mjs [--skip-prebuild | --candidate [--sign]]
//
// --candidate builds for this machine only and keeps work between runs: one
// chip, incremental compiles, and the packaged server is reused while its
// sources are unchanged. Run it in a checkout that is kept between builds, has
// no `.env` file and has never run the release prebuild; otherwise the packaged
// server falls back to the release prebuild, which is several times slower.
//
// --sign signs a candidate with the identity in APPLE_SIGNING_IDENTITY so it
// keeps the installed app's permissions and stored items. It is not notarized,
// so it is for the machine that built it, never for distribution.
//
// Nothing in the release pipeline selects this script yet.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

export const APP_BUNDLE = 'src-tauri/target/universal-apple-darwin/release/bundle/macos/o8.app';
const ARCHES = ['x86_64', 'aarch64'];
const WEB_INPUTS = ['src', 'public', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'scripts/tauri-export.mjs'];
const HELPERS = ['o8-next', 'o8-pi-write', 'o8d', 'speech-local'];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args[0] ?? ''} exited with ${result.status}`);
}

function timed(label, step) {
  const started = Date.now();
  console.log(`[native-app] ${label} started`);
  const value = step();
  console.log(`[native-app] ${label} completed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return value;
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The keys the classic bundler wrote, then the repository's own additions on top. */
export function writeInfoPlist(root, file, version) {
  const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const minimum = config.bundle?.macOS?.minimumSystemVersion ?? '14.0';
  const strings = {
    CFBundleDevelopmentRegion: 'English',
    CFBundleDisplayName: config.productName,
    CFBundleExecutable: 'o8',
    CFBundleIconFile: 'icon.icns',
    CFBundleIdentifier: config.identifier,
    CFBundleInfoDictionaryVersion: '6.0',
    CFBundleName: config.productName,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: minimum,
  };
  const body = Object.entries(strings)
    .map(([key, value]) => `\t<key>${key}</key>\n\t<string>${escapeXml(String(value))}</string>`)
    .join('\n');
  writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
\t<key>CFBundleURLTypes</key>
\t<array>
\t\t<dict>
\t\t\t<key>CFBundleURLName</key>
\t\t\t<string>${escapeXml(config.identifier)}.auth</string>
\t\t\t<key>CFBundleURLSchemes</key>
\t\t\t<array>
\t\t\t\t<string>o8</string>
\t\t\t</array>
\t\t</dict>
\t</array>
\t<key>CSResourcesFileMapped</key>
\t<true/>
\t<key>LSRequiresCarbon</key>
\t<true/>
\t<key>NSHighResolutionCapable</key>
\t<true/>
</dict>
</plist>
`);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Merge ${join(root, 'src-tauri/Info.plist')}`, file], { stdio: 'pipe' });
  execFileSync('plutil', ['-lint', file], { stdio: 'pipe' });
}

function buildLauncher(root, work, arches, env) {
  const crate = join(root, 'crates/o8-launcher');
  const target = process.env.CARGO_TARGET_DIR ?? join(crate, 'target');
  for (const arch of arches) {
    run('cargo', ['build', '--release', '--locked', '--target', `${arch}-apple-darwin`], { cwd: crate, env });
  }
  const output = join(work, 'o8');
  run('lipo', ['-create', ...arches.map(arch => join(target, `${arch}-apple-darwin/release/o8-launcher`)), '-output', output]);
  return output;
}

/** Tracked content plus uncommitted edits of everything the packaged server is built from. */
function webKey(root) {
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  return createHash('sha256')
    .update(git(['ls-files', '-s', '--', ...WEB_INPUTS]))
    .update(git(['diff', 'HEAD', '--', ...WEB_INPUTS]))
    .update(git(['ls-files', '--others', '--exclude-standard', '--', ...WEB_INPUTS]))
    .digest('hex');
}

/**
 * Why this checkout cannot use the plain server build, or null when it can. The
 * release prebuild binds a checkout to its own build profile; from then on the
 * build tools accept only the prebuild there. The profile path mirrors
 * `releaseBuildProfile` in scripts/lib/release-build-profile.mjs.
 */
function releasePrebuildReason(root) {
  if (existsSync(join(root, '.env'))) return 'this checkout has a .env file';
  const profile = join(realpathSync(homedir()), '.o8-release-build-profiles',
    createHash('sha256').update(realpathSync(root)).digest('hex'));
  if (existsSync(join(root, '.o8-generated-output-store')) || existsSync(join(profile, 'cortex-ide.db'))) {
    return 'this checkout has run the release prebuild';
  }
  return null;
}

/**
 * One chip, incremental. The two Rust programs are always brought up to date; the
 * packaged server is rebuilt only when its sources changed.
 *
 * The server is built with the plain build and export, which take a few minutes.
 * The release prebuild adds checksums and a cache capture that a local build does
 * not need. The plain build refuses to strip a checkout's `.env` out of the
 * packaged server, so a checkout that has one uses the release prebuild instead.
 */
async function candidatePrebuild(root, triple, compile) {
  const env = { ...compile, O8_TAURI_BUILD_TARGET: triple };
  const node = process.execPath;
  const keyFile = join(root, 'out/.candidate-web-key');
  const key = webKey(root);
  const current = existsSync(join(root, 'out/server/server.js')) && existsSync(keyFile)
    && readFileSync(keyFile, 'utf8').trim() === key;
  const slow = current ? null : releasePrebuildReason(root);
  if (slow) {
    console.log(`[native-app] ${slow}, so the packaged server uses the release prebuild`);
    rmSync(keyFile, { force: true });
    timed('prebuild', () => run('npm', ['run', 'tauri:prebuild'], { env }));
    if (webKey(root) === key) writeFileSync(keyFile, `${key}\n`);
    return;
  }
  if (!existsSync(join(root, 'src-tauri/helpers', `speech-local-${triple}`))) {
    timed('speech sidecar', () => run(node, ['scripts/build-speech-local.mjs'], { env }));
  }
  timed('daemon', () => run(node, ['scripts/build-o8d.mjs'], { env }));
  timed('write helper', () => run(node, ['scripts/build-pi-write.mjs'], { env }));
  timed('native window', () => run(node, ['scripts/next/build-sidecar.mjs'], { env }));
  if (current) {
    console.log('[native-app] packaged server reused: its sources are unchanged');
    return;
  }
  // Each build gets an empty data folder and an empty output folder, so the build
  // tools keep no record of an earlier output to reconcile with.
  const data = mkdtempSync(join(tmpdir(), 'o8-candidate-build-'));
  const web = { ...env, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data };
  rmSync(keyFile, { force: true });
  rmSync(join(root, '.next'), { recursive: true, force: true });
  try {
    timed('web build', () => run('npm', ['run', 'build'], { env: web }));
    timed('server export', () => run(node, ['scripts/tauri-export.mjs'], { env: web }));
    if (existsSync(join(root, 'out/server/.env'))) throw new Error('The packaged server contains a .env file.');
    timed('packaged server smoke', () => run(node, ['scripts/packaged-server-smoke.mjs'], { env: web }));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
  if (webKey(root) === key) writeFileSync(keyFile, `${key}\n`);
}

function machOFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) machOFiles(full, found);
    else if (entry.isFile() && (/\.(node|dylib)$/.test(entry.name) || entry.name === 'spawn-helper')
      && execFileSync('file', [full], { encoding: 'utf8' }).includes('Mach-O')) found.push(full);
  }
  return found;
}

/** The release signing order and options, without a timestamp server or notarization. */
function signCandidate(root, app) {
  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  if (!identity) throw new Error('--sign needs APPLE_SIGNING_IDENTITY.');
  const sign = (target, extra = []) => execFileSync('codesign',
    ['--force', '--options', 'runtime', '--timestamp=none', '--sign', identity, ...extra, target], { stdio: 'inherit' });
  for (const file of machOFiles(join(app, 'Contents/Resources/server/node_modules'))) sign(file);
  sign(join(app, 'Contents/MacOS/speech_recognizer'), ['--entitlements', join(root, 'src-tauri/entitlements.speech.plist')]);
  sign(app, ['--deep', '--entitlements', join(root, 'src-tauri/entitlements.plist')]);
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
}

/** The same two slices and embedded plist the classic build script produced. */
function buildSpeechRecognizer(root, work, arches) {
  const source = join(root, 'src-tauri/helpers/speech_recognizer.swift');
  const plist = join(root, 'src-tauri/helpers/speech_recognizer_info.plist');
  const deployment = process.env.MACOSX_DEPLOYMENT_TARGET ?? '11.0';
  const slices = arches.map((arch) => {
    const slice = join(work, `speech_recognizer-${arch}`);
    run('swiftc', [
      '-O', '-target', `${arch === 'aarch64' ? 'arm64' : arch}-apple-macosx${deployment}`, '-o', slice, source,
      '-framework', 'Speech', '-framework', 'AVFoundation',
      '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist,
    ]);
    return slice;
  });
  const output = join(work, 'speech_recognizer');
  run('lipo', ['-create', ...slices, '-output', output]);
  return output;
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('The native app bundle is assembled on macOS.');
  const root = process.cwd();
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const started = Date.now();
  const candidate = process.argv.includes('--candidate');
  const arches = candidate ? [process.arch === 'arm64' ? 'aarch64' : 'x86_64'] : ARCHES;
  const staged = candidate ? `${arches[0]}-apple-darwin` : 'universal-apple-darwin';
  // Finer-grained reuse between runs, at the cost of a slightly larger program.
  const compile = candidate
    ? { ...process.env, CARGO_PROFILE_RELEASE_INCREMENTAL: 'true', CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '256' }
    : process.env;
  if (candidate) {
    await candidatePrebuild(root, staged, compile);
  } else if (!process.argv.includes('--skip-prebuild')) {
    // The helper builds read this to produce both chips, as the classic build asked them to.
    const env = { ...process.env, O8_TAURI_BUILD_TARGET: 'universal-apple-darwin' };
    timed('prebuild', () => run('npm', ['run', 'tauri:prebuild'], { env }));
  }
  const server = join(root, 'out/server');
  if (!existsSync(join(server, 'server.js'))) throw new Error('out/server is missing; run the prebuild first.');
  const work = join(root, 'src-tauri/target/native-app');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const launcher = timed('launcher', () => buildLauncher(root, work, arches, compile));
  const recognizer = timed('speech recognizer', () => buildSpeechRecognizer(root, work, arches));

  timed('assemble', () => {
    const app = join(root, APP_BUNDLE);
    rmSync(app, { recursive: true, force: true });
    const macos = join(app, 'Contents/MacOS');
    const resources = join(app, 'Contents/Resources');
    mkdirSync(macos, { recursive: true });
    mkdirSync(resources, { recursive: true });
    copyFileSync(launcher, join(macos, 'o8'));
    copyFileSync(recognizer, join(macos, 'speech_recognizer'));
    for (const name of HELPERS) {
      const source = join(root, 'src-tauri/helpers', `${name}-${staged}`);
      if (!statSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error(`${name} was not staged by the prebuild.`);
      copyFileSync(source, join(macos, name));
    }
    for (const name of ['o8', 'speech_recognizer', ...HELPERS]) chmodSync(join(macos, name), 0o755);
    copyFileSync(join(root, 'src-tauri/icons/icon.icns'), join(resources, 'icon.icns'));
    copyFileSync(join(root, 'src-tauri/helpers/o8-next-build.json'), join(resources, 'o8-next-build.json'));
    cpSync(server, join(resources, 'server'), { recursive: true, verbatimSymlinks: true });
    writeInfoPlist(root, join(app, 'Contents/Info.plist'), version);
  });
  if (process.argv.includes('--sign')) {
    if (!candidate) throw new Error('--sign is for --candidate builds; releases use the release signing step.');
    timed('sign', () => signCandidate(root, join(root, APP_BUNDLE)));
  }
  console.log(`[native-app] ${APP_BUNDLE} assembled for v${version}${candidate ? ` (candidate, ${arches[0]})` : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(`[native-app] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
