#!/usr/bin/env node
// Assembles the macOS app with the launcher as its main program, without the
// classic shell (#6130). It writes the bundle where the classic build does, so
// signing, notarization and the release checks run on it unchanged.
//
//   node scripts/native-app-build.mjs [--skip-prebuild | --candidate]
//
// --candidate builds for this machine only and keeps work between runs: one
// chip, incremental compiles, and the packaged server is reused while its
// sources are unchanged. Run it in a checkout that is kept between builds.
//
// Nothing in the release pipeline selects this script yet.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

export const APP_BUNDLE = 'src-tauri/target/universal-apple-darwin/release/bundle/macos/o8.app';
const ARCHES = ['x86_64', 'aarch64'];
const WEB_INPUTS = ['src', 'public', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'scripts/tauri-export.mjs'];
const HELPERS = ['o8-next', 'o8-pi-write', 'speech-local'];

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
 * One chip, incremental. The whole prebuild runs only when the packaged server's
 * sources changed; otherwise only the two Rust programs are brought up to date.
 */
function candidatePrebuild(root, triple, compile) {
  const env = { ...compile, O8_TAURI_BUILD_TARGET: triple };
  const keyFile = join(root, 'out/.candidate-web-key');
  const key = webKey(root);
  const current = existsSync(join(root, 'out/server/server.js')) && existsSync(keyFile)
    && readFileSync(keyFile, 'utf8').trim() === key;
  if (current) {
    console.log('[native-app] packaged server reused: its sources are unchanged');
    timed('write helper', () => run(process.execPath, ['scripts/build-pi-write.mjs'], { env }));
    timed('native window', () => run(process.execPath, ['scripts/next/build-sidecar.mjs'], { env }));
    return;
  }
  rmSync(keyFile, { force: true });
  timed('prebuild', () => run('npm', ['run', 'tauri:prebuild'], { env }));
  if (webKey(root) === key) writeFileSync(keyFile, `${key}\n`);
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

function main() {
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
    candidatePrebuild(root, staged, compile);
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
  console.log(`[native-app] ${APP_BUNDLE} assembled for v${version}${candidate ? ` (candidate, ${arches[0]})` : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    console.error(`[native-app] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
