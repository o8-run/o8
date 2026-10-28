import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { collectReleaseBuildCacheIdentity } from './release-build-cache.mjs';
import { compilerEnvironment } from './release-native-inputs.mjs';

export const RELEASE_ARTIFACT_MANIFEST = 'out/.o8-release-artifact-manifest.json';

const RECIPE_FILES = [
  'release-build.json',
  'scripts/lib/build-channel.mjs',
  'package-lock.json',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'src-tauri/tauri.macos.conf.json',
  'scripts/build.mjs',
  'scripts/build-speech-local.mjs',
  'scripts/build-pi-write.mjs',
  'scripts/next/build-sidecar.mjs',
  'scripts/next/build-identity.mjs',
  'native/o8-next/Cargo.lock',
  'src-tauri/sidecars/pi-write/Cargo.lock',
  'scripts/tauri-export.mjs',
  'scripts/tauri-prebuild.mjs',
  'scripts/lib/prebuild-continuation.mjs',
  'scripts/lib/registered-build.mjs',
  'scripts/lib/release-build-profile.mjs',
  'scripts/lib/generated-output-launch.mjs',
  'scripts/generated-output-run.ts',
  'src/lib/workspace/generated-output-producer.ts',
  'src/lib/workspace/generated-output-build-ownership.ts',
  'scripts/lib/build-output-writer.cjs',
  'scripts/lib/build-output-capture.c',
  'scripts/lib/build-output-entry-create.cjs',
  'src/lib/workspace/generated-output-state.ts',
  'src/lib/workspace/generated-output-validation.ts',
  'src/lib/workspace/generated-output-disposal.ts',
  'scripts/postship-cleanup.mjs',
  'scripts/preship-cleanup.mjs',
  'scripts/packaged-server-smoke.mjs',
  'scripts/lib/packaged-server-smoke.mjs',
  'scripts/lib/tauri-export-safety.mjs',
];

const SPEECH_ARTIFACTS = [
  'src-tauri/helpers/speech-local',
  'src-tauri/helpers/speech-local-aarch64-apple-darwin',
  'src-tauri/helpers/speech-local-universal-apple-darwin',
  'src-tauri/helpers/speech-local-x86_64-apple-darwin',
];

const NEXT_ARTIFACTS = ['', '-aarch64-apple-darwin', '-x86_64-apple-darwin', '-universal-apple-darwin', '-build.json']
  .map(suffix => `src-tauri/helpers/o8-next${suffix}`);

const PI_WRITE_ARTIFACTS = [
  'src-tauri/helpers/o8-pi-write',
  'src-tauri/helpers/o8-pi-write-aarch64-apple-darwin',
  'src-tauri/helpers/o8-pi-write-universal-apple-darwin',
  'src-tauri/helpers/o8-pi-write-x86_64-apple-darwin',
  'src-tauri/helpers/o8-pi-write-x86_64-unknown-linux-gnu',
  'src-tauri/helpers/o8-pi-write-aarch64-unknown-linux-gnu',
];

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function commandVersion(root, command, args) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    }).trim().split('\n')[0];
  } catch {
    return 'unavailable';
  }
}

function outputRoots(root) {
  return [
    { absolute: join(root, 'out'), relative: 'out' },
    ...[...SPEECH_ARTIFACTS, ...PI_WRITE_ARTIFACTS, ...NEXT_ARTIFACTS].map((path) => ({ absolute: join(root, path), relative: path })),
  ];
}

function walkFiles(root, target, results) {
  if (!existsSync(target)) return;
  const identity = lstatSync(target);
  if (identity.isSymbolicLink()) {
    results.push(target);
    return;
  }
  if (identity.isFile()) {
    results.push(target);
    return;
  }
  if (!identity.isDirectory()) return;
  for (const name of readdirSync(target).sort()) {
    const child = join(target, name);
    if (resolve(child) === resolve(join(root, RELEASE_ARTIFACT_MANIFEST))) continue;
    walkFiles(root, child, results);
  }
}

function checksumOutput(root, path) {
  const identity = lstatSync(path);
  const rel = relative(root, path).split(sep).join('/');
  if (identity.isSymbolicLink()) {
    return {
      path: rel,
      kind: 'symlink',
      sha256: createHash('sha256').update(readlinkSync(path)).digest('hex'),
      size: identity.size,
    };
  }
  return {
    path: rel,
    kind: 'file',
    sha256: sha256File(path),
    size: identity.size,
  };
}

export function collectReleaseArtifactRecipe(root, version, options = {}) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const dirtyEntries = execFileSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !/^(?:[ MADRCU?!]{1,2} )?o8\.md$/.test(line));
  const inputs = RECIPE_FILES.map((path) => {
    const absolute = join(root, path);
    return {
      path,
      sha256: existsSync(absolute) ? sha256File(absolute) : 'missing',
    };
  });
  // A verified artifact is only reusable under the exact web-build
  // environment that produced it. Without this, a release built without a
  // public client value can be reused after the value is configured, silently
  // compiling the corresponding UI path out of later signed builds.
  const webBuildCompatibilitySha256 = collectReleaseBuildCacheIdentity(root, 'web', {
    env: options.env ?? process.env,
  }).compatibilitySha256;
  // Whole-artifact reuse also skips native sidecar compilation. Use the native
  // compiler registry (including external Cargo config), without persisting its
  // values or depending on generated frontend files that prebuild recreates.
  const env = options.env ?? process.env;
  const nativeCompilerInputsSha256 = createHash('sha256').update(stableJson({
    environment: compilerEnvironment(root, 'native', env),
    sidecarTarget: env.O8_TAURI_BUILD_TARGET || env.TAURI_ENV_TARGET_TRIPLE || '',
  })).digest('hex');
  const recipe = {
    schema: 'o8/release-artifact-recipe/v1',
    head,
    version,
    platform: process.platform,
    arch: process.arch,
    worktreeClean: dirtyEntries.length === 0,
    buildOptions: {
      nextBundler: 'webpack',
      tauriFeatures: ['dev-mcp-plugin'],
      nodeEnv: 'production',
    },
    toolchains: {
      node: process.version,
      npm: commandVersion(root, 'npm', ['--version']),
      cargo: commandVersion(root, 'cargo', ['--version']),
      rustc: commandVersion(root, 'rustc', ['--version']),
      swift: process.platform === 'darwin' ? commandVersion(root, 'swift', ['--version']) : 'not-applicable',
    },
    inputs,
    webBuildCompatibilitySha256,
    nativeCompilerInputsSha256,
  };
  return {
    ...recipe,
    recipeSha256: createHash('sha256').update(stableJson(recipe)).digest('hex'),
  };
}

export function writeReleaseArtifactManifest(root, recipe) {
  const files = [];
  for (const output of outputRoots(root)) walkFiles(root, output.absolute, files);
  const outputs = files.sort().map((path) => checksumOutput(root, path));
  if (outputs.length === 0) throw new Error('release artifact output is empty');
  const manifest = {
    schema: 'o8/release-artifact-manifest/v1',
    createdAt: new Date().toISOString(),
    recipe,
    outputs,
  };
  const manifestPath = join(root, RELEASE_ARTIFACT_MANIFEST);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { manifestPath, manifest };
}

export function verifyReleaseArtifactManifest(root, recipe) {
  if (recipe.worktreeClean === false) return { reusable: false, reason: 'dirty_worktree' };
  const manifestPath = join(root, RELEASE_ARTIFACT_MANIFEST);
  if (!existsSync(manifestPath)) return { reusable: false, reason: 'manifest_missing' };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { reusable: false, reason: 'manifest_invalid' };
  }
  if (manifest?.schema !== 'o8/release-artifact-manifest/v1'
    || manifest?.recipe?.recipeSha256 !== recipe.recipeSha256) {
    return { reusable: false, reason: 'recipe_mismatch' };
  }

  const currentFiles = [];
  for (const output of outputRoots(root)) walkFiles(root, output.absolute, currentFiles);
  const currentPaths = currentFiles.sort().map((path) => relative(root, path).split(sep).join('/'));
  const recorded = Array.isArray(manifest.outputs) ? manifest.outputs : [];
  const recordedPaths = recorded.map((output) => output.path);
  if (currentPaths.length !== recordedPaths.length
    || currentPaths.some((path, index) => path !== recordedPaths[index])) {
    return { reusable: false, reason: 'output_set_mismatch' };
  }
  for (const output of recorded) {
    const absolute = join(root, output.path);
    if (!existsSync(absolute)) return { reusable: false, reason: `output_missing:${output.path}` };
    const actual = checksumOutput(root, absolute);
    if (actual.kind !== output.kind || actual.size !== output.size || actual.sha256 !== output.sha256) {
      return { reusable: false, reason: `checksum_mismatch:${output.path}` };
    }
  }
  return { reusable: true, reason: 'verified', manifest };
}

export const releaseArtifactInternals = {
  sha256File,
  stableJson,
  outputRoots,
};
