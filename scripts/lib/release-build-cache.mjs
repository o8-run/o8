import { captureRestoredWebCache } from './release-web-cache-ownership.mjs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  existsSync, lstatSync, readFileSync, readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { beginCacheStaging, cacheDestinationOccupied, finalizeCacheReceipt, ensurePrivateDirectory, tarArguments } from './release-build-cache-staging.mjs';
import { compilerEnvironment, nativeBuildSettings, nativeCacheConfig, nativeSourceInputs, sameCachedTree, SPEECH_HELPERS } from './release-native-inputs.mjs';
import { normalizeReleaseBuildCacheRecipeInput } from './release-build-cache-version-normalizer.mjs';

export const RELEASE_BUILD_CACHE_SCHEMA = 'o8/release-build-cache-entry/v1';
export const RELEASE_BUILD_CACHE_RECEIPT_SCHEMA = 'o8/release-build-cache-receipt/v1';
export const RELEASE_BUILD_CACHE_PHASES = Object.freeze(['web', 'speech', 'native']);

const CACHE_VERSION_DIR = 'release-v1';
const EXTERNAL_VOLUME_MARKER = '.o8-release-cache-volume';
const LOCAL_CACHE_BUDGET_BYTES = 4 * 1024 * 1024 * 1024;
const EXTERNAL_CACHE_BUDGET_BYTES = 20 * 1024 * 1024 * 1024;
const ENTRY_LIMIT = 1;
const COMPATIBILITY_LIMIT = 2;
const UNSAFE_PATH_ERROR_CODE = 'O8_RELEASE_CACHE_UNSAFE_PATH';
const WEB_ENVIRONMENT_PATTERNS = [
  /^NEXT_PUBLIC_/,
  /^CLERK_PUBLISHABLE_KEY$/,
  /^O8_APP_VERSION$/,
  /^O8_BYOK_REQUIRED$/,
  /^O8_EXPERIMENTAL_/,
  /^O8_LICENSE_PUBKEY$/,
  /^O8_SENTRY_DSN$/,
  /^SENTRY_DSN$/,
];
const WEB_ENVIRONMENT_FILES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.production.local',
];

const PHASE_CONFIG = Object.freeze({
  web: Object.freeze({
    targets: ['.next/cache'],
    excludes: [],
    recipeInputs: [
      'package.json',
      'package-lock.json',
      'next.config.ts',
      'tsconfig.json',
      'scripts/build.mjs',
      'scripts/bust-stale-patch-cache.mjs',
      'scripts/tauri-export.mjs',
      'scripts/tauri-prebuild.mjs',
      'scripts/lib/prebuild-continuation.mjs',
      'scripts/lib/registered-build.mjs', 'scripts/lib/release-web-cache-ownership.mjs',
      'src/lib/workspace/generated-output-build-ownership.ts',
      'scripts/lib/build-output-writer.cjs',
      'scripts/lib/build-output-entry-create.cjs',
      'scripts/lib/release-build-profile.mjs',
      'scripts/lib/generated-output-launch.mjs',
      'scripts/generated-output-run.ts',
      'src/lib/workspace/generated-output-producer.ts',
      'src/lib/workspace/generated-output-state.ts',
      'src/lib/workspace/generated-output-validation.ts',
      'src/lib/workspace/generated-output-disposal.ts',
      'scripts/postship-cleanup.mjs',
      'scripts/preship-cleanup.mjs',
      'scripts/lib/release-config.mjs',
      'scripts/lib/release-build-cache.mjs', 'scripts/lib/release-build-cache-staging.mjs',
      'src/lib/workspace/exact-parent-operation.ts', 'src/lib/workspace/exact-directory-purge.ts',
      'src/lib/worktree/materialization-execution.ts', 'src/lib/worktree/metadata-lock-process-identity.ts',
      'scripts/lib/release-build-cache-version-normalizer.mjs',
      'patches',
    ],
    toolchains: [['node', process.execPath, ['--version']], ['npm', 'npm', ['--version']]],
  }),
  speech: Object.freeze({
    targets: SPEECH_HELPERS,
    excludes: [],
    recipeInputs: [
      'src-tauri/sidecars/speech-local/Package.swift',
      'src-tauri/sidecars/speech-local/Sources',
      'src-tauri/sidecars/speech-local/Package.resolved',
      'scripts/build-speech-local.mjs',
      'scripts/tauri-prebuild.mjs',
      'scripts/lib/prebuild-continuation.mjs',
      'scripts/lib/registered-build.mjs',
      'scripts/lib/release-build-profile.mjs',
      'scripts/lib/generated-output-launch.mjs',
      'scripts/generated-output-run.ts',
      'src/lib/workspace/generated-output-producer.ts',
      'src/lib/workspace/generated-output-state.ts',
      'src/lib/workspace/generated-output-validation.ts',
      'src/lib/workspace/generated-output-disposal.ts',
      'scripts/postship-cleanup.mjs',
      'scripts/preship-cleanup.mjs',
      'scripts/lib/release-build-cache.mjs', 'scripts/lib/release-build-cache-staging.mjs',
      'src/lib/workspace/exact-parent-operation.ts', 'src/lib/workspace/exact-directory-purge.ts',
      'src/lib/worktree/materialization-execution.ts', 'src/lib/worktree/metadata-lock-process-identity.ts',
      'scripts/lib/release-build-cache-version-normalizer.mjs',
    ],
    toolchains: [['swift', 'swift', ['--version']], ['sdk', 'xcrun', ['--show-sdk-version']]],
  }),
  native: Object.freeze({
    targets: ['src-tauri/target/release'],
    excludes: [
      'src-tauri/target/release/bundle',
      'src-tauri/target/release/server',
      'src-tauri/target/release/build-cache-receipt.json',
    ],
    recipeInputs: [
      'src-tauri/Cargo.toml',
      'src-tauri/Cargo.lock',
      'src-tauri/build.rs',
      'src-tauri/tauri.conf.json',
      'src-tauri/tauri.macos.conf.json',
      'package.json',
      'scripts/tauri-build.mjs',
      'scripts/tauri-prebuild.mjs',
      'scripts/lib/prebuild-continuation.mjs',
      'scripts/lib/registered-build.mjs',
      'scripts/lib/release-build-profile.mjs',
      'scripts/lib/generated-output-launch.mjs',
      'scripts/generated-output-run.ts',
      'src/lib/workspace/generated-output-producer.ts',
      'src/lib/workspace/generated-output-state.ts',
      'src/lib/workspace/generated-output-validation.ts',
      'src/lib/workspace/generated-output-disposal.ts',
      'scripts/postship-cleanup.mjs',
      'scripts/preship-cleanup.mjs',
      'scripts/lib/release-build-cache.mjs', 'scripts/lib/release-build-cache-staging.mjs',
      'src/lib/workspace/exact-parent-operation.ts', 'src/lib/workspace/exact-directory-purge.ts',
      'src/lib/worktree/materialization-execution.ts', 'src/lib/worktree/metadata-lock-process-identity.ts',
      'scripts/lib/release-build-cache-version-normalizer.mjs',
    ],
    toolchains: [
      ['cargo', 'cargo', ['--version']],
      ['rustc', 'rustc', ['--version']],
      ['rustcHost', 'rustc', ['-vV']],
      ['swift', 'swift', ['--version']],
      ['sdk', 'xcrun', ['--show-sdk-version']],
    ],
  }),
});

function phaseConfig(phase, buildOptions = {}) {
  if (phase === 'native') return nativeCacheConfig(PHASE_CONFIG.native, buildOptions);
  return PHASE_CONFIG[phase];
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function nativeCheckoutIdentity(root) {
  // Native build scripts retain absolute permission/output paths. Do not
  // expose the path in receipts or mistake a relocated cache for reusable work.
  return sha256Text(stableJson({ path: resolve(root), realpath: realpathSync(root) }));
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function commandVersion(root, command, args, env) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    }).trim();
  } catch {
    return 'unavailable';
  }
}

function collectInputFiles(root, relativePath, results) {
  const absolute = join(root, relativePath);
  if (!existsSync(absolute)) {
    results.push({ path: relativePath, sha256: 'missing' });
    return;
  }
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink()) throw new Error(`cache recipe input is a symbolic link: ${relativePath}`);
  if (metadata.isFile()) {
    const normalizedPath = relativePath.split(sep).join('/');
    results.push({
      path: normalizedPath,
      sha256: sha256Text(normalizeReleaseBuildCacheRecipeInput(normalizedPath, readFileSync(absolute))),
    });
    return;
  }
  if (!metadata.isDirectory()) return;
  for (const name of readdirSync(absolute).sort()) {
    collectInputFiles(root, join(relativePath, name), results);
  }
}

function gitOutput(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function dirtyEntries(root) {
  return gitOutput(root, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !/^(?:[ MADRCU?!]{1,2} )?o8\.md$/.test(line));
}

function collectWebEnvironmentFiles(root) {
  return WEB_ENVIRONMENT_FILES.map((path) => {
    const absolute = join(root, path);
    return {
      path,
      sha256: existsSync(absolute) ? sha256Text(readFileSync(absolute)) : 'missing',
    };
  });
}

function localCacheRoot(env) {
  return resolve(env.O8_RELEASE_BUILD_CACHE_LOCAL_DIR?.trim()
    || join(homedir(), '.o8-build-cache', CACHE_VERSION_DIR));
}

function externalVolumeRoot(configuredRoot, env) {
  const explicit = env.O8_RELEASE_BUILD_CACHE_EXTERNAL_ROOT?.trim();
  if (explicit) return resolve(explicit);
  const match = configuredRoot.match(/^\/Volumes\/[^/]+(?:\/|$)/);
  return match ? match[0].replace(/\/$/, '') : null;
}

export function resolveReleaseBuildCacheRoot(env = process.env, options = {}) {
  const configured = env.O8_RELEASE_BUILD_CACHE_DIR?.trim();
  if (!configured) return localCacheRoot(env);
  const configuredRoot = resolve(configured);
  const volumeRoot = externalVolumeRoot(configuredRoot, env);
  if (!volumeRoot) return configuredRoot;
  const expectedVolumeId = env.O8_RELEASE_BUILD_CACHE_VOLUME_ID?.trim();
  const markerPath = join(volumeRoot, EXTERNAL_VOLUME_MARKER);
  let actualVolumeId = null;
  try {
    const markerMetadata = lstatSync(markerPath);
    if (markerMetadata.isFile() && !markerMetadata.isSymbolicLink()) {
      actualVolumeId = readFileSync(markerPath, 'utf8').trim();
    }
  } catch {}
  if (expectedVolumeId && actualVolumeId === expectedVolumeId
    && resolvedPathInside(realpathWithMissingSegments(configuredRoot), realpathWithMissingSegments(volumeRoot))) {
    return configuredRoot;
  }
  const fallback = localCacheRoot(env);
  const reason = !expectedVolumeId ? 'volume identity is not configured'
    : actualVolumeId === null ? 'mount marker is missing'
      : actualVolumeId !== expectedVolumeId ? 'mount identity changed'
        : 'cache directory is outside the external root';
  (options.warn ?? console.warn)(
    `[release-cache] external cache unavailable (${reason}); using local cache`,
  );
  return fallback;
}

function cacheBudgetBytes(env, cacheRoot) {
  const configured = env.O8_RELEASE_BUILD_CACHE_MAX_BYTES?.trim();
  if (configured) {
    const parsed = Number(configured);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error('O8_RELEASE_BUILD_CACHE_MAX_BYTES must be a non-negative integer');
    }
    return parsed;
  }
  const configuredRoot = env.O8_RELEASE_BUILD_CACHE_DIR?.trim()
    ? resolve(env.O8_RELEASE_BUILD_CACHE_DIR.trim())
    : null;
  return configuredRoot === cacheRoot && externalVolumeRoot(cacheRoot, env)
    ? EXTERNAL_CACHE_BUDGET_BYTES
    : LOCAL_CACHE_BUDGET_BYTES;
}

function operationCacheRoot(options) {
  const env = options.env ?? process.env;
  if (env.O8_RELEASE_BUILD_CACHE_DIR?.trim()) return resolveReleaseBuildCacheRoot(env);
  return options.cacheRoot ?? resolveReleaseBuildCacheRoot(env);
}

export function collectReleaseBuildCacheIdentity(root, phase, options = {}) {
  const config = phaseConfig(phase, options.buildOptions);
  if (!config) throw new Error(`unsupported release cache phase: ${phase}`);
  const inputs = [];
  const paths = new Set([...config.recipeInputs, 'scripts/lib/release-native-inputs.mjs']);
  if (phase === 'native') {
    for (const path of nativeSourceInputs(root)) paths.add(path);
    for (const path of ['scripts/release-cargo-runner.mjs', 'scripts/lib/release-cargo-target.mjs', 'scripts/lib/release-config.mjs', 'scripts/tauri-export.mjs', 'scripts/loader-verify.mjs']) paths.add(path);
  }
  for (const path of paths) collectInputFiles(root, path, inputs);
  inputs.sort((left, right) => left.path.localeCompare(right.path));
  const environment = phase === 'web'
    ? Object.fromEntries(Object.keys(options.env ?? process.env)
      .filter((key) => WEB_ENVIRONMENT_PATTERNS.some((pattern) => pattern.test(key)))
      .sort()
      .map((key) => [key, sha256Text(String((options.env ?? process.env)[key] ?? ''))]))
    : options.compilerEnvironment ?? compilerEnvironment(root, phase, options.env ?? process.env);
  const compatibility = {
    schema: 'o8/release-build-cache-compatibility/v1',
    phase,
    platform: process.platform,
    arch: process.arch,
    buildMode: 'release',
    buildOptions: phase === 'native' ? nativeBuildSettings(root, options.buildOptions, options.env ?? process.env) : options.buildOptions ?? {},
    targets: config.targets,
    excludes: config.excludes,
    toolchains: Object.fromEntries(config.toolchains.map(([name, command, args]) => [
      name,
      commandVersion(root, command, args, options.env ?? process.env),
    ])),
    inputs,
    environment,
    environmentFiles: phase === 'web' ? collectWebEnvironmentFiles(root) : [],
  };
  const source = {
    head: gitOutput(root, ['rev-parse', 'HEAD']),
    tree: gitOutput(root, ['rev-parse', 'HEAD^{tree}']),
    worktreeClean: dirtyEntries(root).length === 0,
  };
  const compatibilitySha256 = sha256Text(stableJson(compatibility));
  const sourceSha256 = sha256Text(stableJson(source));
  return {
    phase,
    compatibility,
    compatibilitySha256,
    source,
    sourceSha256,
    entrySha256: sha256Text(stableJson({ compatibilitySha256, sourceSha256 })),
  };
}

function entriesDirectory(cacheRoot, identity) {
  return join(cacheRoot, 'entries', identity.phase, identity.compatibilitySha256);
}

function manifestPathFor(directory, entrySha256) {
  return join(directory, `${entrySha256}.json`);
}

function archivePathFor(directory, entrySha256) {
  return join(directory, `${entrySha256}.tar`);
}

function normalizeArchivePath(value) {
  const slashPath = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!slashPath || slashPath.startsWith('/') || /^[A-Za-z]:\//.test(slashPath)) return null;
  const normalized = normalize(slashPath).split(sep).join('/');
  if (normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function pathInside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function realpathWithMissingSegments(path) {
  const segments = [];
  let existing = resolve(path);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return resolve(path);
    segments.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...segments);
}

function resolvedPathInside(candidate, boundary) {
  const remainder = relative(boundary, candidate);
  return remainder === ''
    || (remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

function assertOutsideProjectNodeModules(target, projectRoot) {
  const absoluteTarget = resolve(target);
  const resolvedTarget = realpathWithMissingSegments(absoluteTarget);
  const resolvedProjectRoot = realpathWithMissingSegments(projectRoot);
  const resolvedNodeModules = realpathWithMissingSegments(join(projectRoot, 'node_modules'));
  if (resolvedTarget !== resolvedProjectRoot
    && !resolvedPathInside(resolvedTarget, resolvedNodeModules)) return;

  const error = new Error(
    `release cache refused unsafe destructive path: ${absoluteTarget}`
    + ` (resolved to ${resolvedTarget}; project node_modules: ${resolvedNodeModules})`,
  );
  error.code = UNSAFE_PATH_ERROR_CODE;
  throw error;
}

function removeCachePath(target, options, projectRoot) {
  assertOutsideProjectNodeModules(target, projectRoot);
  rmSync(target, options);
}

export function isReleaseBuildCacheSafetyError(error) {
  return error?.code === UNSAFE_PATH_ERROR_CODE;
}

function pathAllowed(candidate, targets, excludes) {
  return targets.some((target) => pathInside(candidate, target))
    && !excludes.some((excluded) => pathInside(candidate, excluded));
}

function assertTreeHasNoLinks(path, root = path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error(`cache tree contains symbolic link: ${relative(root, path) || '.'}`);
  if (!metadata.isDirectory()) return;
  for (const name of readdirSync(path)) assertTreeHasNoLinks(join(path, name), root);
}

function listArchive(root, archivePath) {
  const output = execFileSync('tar', ['-tf', archivePath], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\n').filter(Boolean);
}

async function verifyCacheEntry(root, identity, manifestPath, config) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { valid: false, reason: 'manifest_invalid' };
  }
  if (manifest?.schema !== RELEASE_BUILD_CACHE_SCHEMA
    || manifest.phase !== identity.phase
    || manifest.compatibilitySha256 !== identity.compatibilitySha256
    || !manifest.archive?.name
    || !Array.isArray(manifest.targets)
    || !Array.isArray(manifest.excludes)) {
    return { valid: false, reason: 'manifest_mismatch' };
  }
  if (stableJson(manifest.targets) !== stableJson(config.targets)
    || stableJson(manifest.excludes) !== stableJson(config.excludes)) {
    return { valid: false, reason: 'target_contract_mismatch' };
  }
  if (identity.phase === 'native' && !config.portable) {
    if (!manifest.nativeCheckoutSha256) return { valid: false, reason: 'native_checkout_unverified' };
    if (manifest.nativeCheckoutSha256 !== nativeCheckoutIdentity(root)) {
      return { valid: false, reason: 'native_checkout_mismatch' };
    }
  }
  const archivePath = join(dirname(manifestPath), basename(manifest.archive.name));
  if (!existsSync(archivePath)) return { valid: false, reason: 'archive_missing' };
  const size = statSync(archivePath).size;
  if (size !== manifest.archive.size) return { valid: false, reason: 'archive_size_mismatch' };
  if (await sha256File(archivePath) !== manifest.archive.sha256) {
    return { valid: false, reason: 'archive_checksum_mismatch' };
  }
  let archivedPaths;
  try {
    archivedPaths = listArchive(root, archivePath);
  } catch {
    return { valid: false, reason: 'archive_unreadable' };
  }
  if (archivedPaths.length === 0) return { valid: false, reason: 'archive_empty' };
  for (const rawPath of archivedPaths) {
    const candidate = normalizeArchivePath(rawPath);
    if (!candidate || !pathAllowed(candidate, manifest.targets, manifest.excludes)) {
      return { valid: false, reason: 'archive_path_outside_contract' };
    }
  }
  return { valid: true, manifest, archivePath };
}

function isReleaseBuildCacheJsonCandidate(name) {
  // macOS AppleDouble sidecars (._*.json) are binary metadata, not cache JSON.
  return name.endsWith('.json') && !name.startsWith('._');
}

function isReleaseBuildCachePhaseReceiptName(name) {
  if (!isReleaseBuildCacheJsonCandidate(name)) return false;
  return RELEASE_BUILD_CACHE_PHASES.includes(basename(name, '.json'));
}

function cacheManifests(directory, preferredEntry) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => isReleaseBuildCacheJsonCandidate(name))
    .map((name) => join(directory, name))
    .sort((left, right) => {
      const leftPreferred = basename(left, '.json') === preferredEntry ? 1 : 0;
      const rightPreferred = basename(right, '.json') === preferredEntry ? 1 : 0;
      if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
      return statSync(right).mtimeMs - statSync(left).mtimeMs;
    });
}

export async function restoreReleaseBuildCache(root, phase, options = {}) {
  const started = Date.now();
  if ((options.env ?? process.env).O8_RELEASE_BUILD_CACHE === 'off') {
    return { phase, status: 'bypass', reason: 'disabled', durationMs: Date.now() - started };
  }
  const identity = options.identity ?? collectReleaseBuildCacheIdentity(root, phase, options);
  const config = phaseConfig(phase, options.buildOptions);
  const cacheRoot = operationCacheRoot(options);
  if (identity.source.worktreeClean === false) {
    return { phase, status: 'bypass', reason: 'dirty_worktree', durationMs: Date.now() - started };
  }
  const directory = entriesDirectory(cacheRoot, identity);
  const candidates = cacheManifests(directory, identity.entrySha256);
  if (candidates.length === 0) {
    return { phase, status: 'miss', reason: 'entry_missing', durationMs: Date.now() - started };
  }
  let lastReason = 'entry_invalid';
  for (const manifestPath of candidates) {
    const verified = await verifyCacheEntry(root, identity, manifestPath, config);
    if (!verified.valid) {
      lastReason = verified.reason;
      continue;
    }
    assertOutsideProjectNodeModules(cacheRoot, root);
    const destinations = verified.manifest.targets.map(target => join(root, target));
    destinations.forEach(target => assertOutsideProjectNodeModules(target, root));
    const occupied = cacheDestinationOccupied(destinations);
    if (occupied && !config.portable && phase !== 'speech') return { phase, status: 'miss', reason: 'destination_occupied', durationMs: Date.now() - started };
    const staging = await beginCacheStaging(cacheRoot, root, phase, identity, { ...options, action: 'restore' });
    const restoreRoot = staging.path;
    try {
      if (!occupied) await staging.destinations(destinations);
      await staging.populate(['-xf', verified.archivePath]);
      for (const target of verified.manifest.targets) {
        const extracted = join(restoreRoot, target);
        if (!existsSync(extracted)) throw new Error(`cache target missing after extraction: ${target}`);
        assertTreeHasNoLinks(extracted);
      }
      if (occupied && !(await Promise.all(verified.manifest.targets.map(target =>
        sameCachedTree(join(restoreRoot, target), join(root, target), sha256File)))).every(Boolean)) {
        await staging.clean(); lastReason = 'destination_occupied'; continue;
      }
      const webOwnership = phase === 'web' && !occupied ? await captureRestoredWebCache(join(restoreRoot, '.next/cache'), join(root, '.next/cache')) : undefined;
      if (!occupied) for (const target of verified.manifest.targets) {
        const extracted = join(restoreRoot, target);
        const destination = join(root, target);
        assertOutsideProjectNodeModules(destination, root);
        await staging.promote(extracted, destination, lstatSync(extracted).isDirectory() ? 'directory' : 'file');
      }
      await staging.clean();
      return {
        phase,
        status: verified.manifest.entrySha256 === identity.entrySha256 ? 'hit_exact' : 'hit_compatible',
        reason: 'verified', webOwnership,
        entrySha256: verified.manifest.entrySha256,
        producerSourceSha256: verified.manifest.sourceSha256,
        archiveBytes: verified.manifest.archive.size,
        estimatedSavedMs: verified.manifest.buildDurationMs ?? null,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      await staging.hold(error);
      if (isReleaseBuildCacheSafetyError(error)) throw error;
      lastReason = `restore_failed:${error instanceof Error ? error.message : String(error)}; staging=${staging.runId}/${staging.operationId}`;
    }
  }
  return { phase, status: 'miss', reason: lastReason, durationMs: Date.now() - started };
}

function pruneEntries(directory, keepEntry, projectRoot) {
  assertOutsideProjectNodeModules(directory, projectRoot);
  const manifests = readdirSync(directory)
    .filter((name) => isReleaseBuildCacheJsonCandidate(name))
    .map((name) => ({ name, mtimeMs: statSync(join(directory, name)).mtimeMs }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const ordered = [
    keepEntry,
    ...manifests
      .map(({ name }) => basename(name, '.json'))
      .filter((entry) => entry !== keepEntry),
  ];
  const keep = new Set(ordered.slice(0, ENTRY_LIMIT));
  for (const { name } of manifests) {
    const entry = basename(name, '.json');
    if (keep.has(entry)) continue;
    removeCachePath(join(directory, name), { force: true }, projectRoot);
    removeCachePath(archivePathFor(directory, entry), { force: true }, projectRoot);
  }
}

function pruneCompatibilityDirectories(cacheRoot, phase, keepCompatibility, projectRoot) {
  const phaseRoot = join(cacheRoot, 'entries', phase);
  if (!existsSync(phaseRoot)) return;
  assertOutsideProjectNodeModules(phaseRoot, projectRoot);
  const directories = readdirSync(phaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      mtimeMs: statSync(join(phaseRoot, entry.name)).mtimeMs,
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const ordered = [
    keepCompatibility,
    ...directories.map(({ name }) => name).filter((name) => name !== keepCompatibility),
  ];
  const keep = new Set(ordered.slice(0, COMPATIBILITY_LIMIT));
  for (const { name } of directories) {
    if (!keep.has(name)) {
      removeCachePath(join(phaseRoot, name), { recursive: true, force: true }, projectRoot);
    }
  }
}

function directoryUsage(path, root = path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) {
    throw new Error(`release cache budget refused symbolic link: ${relative(root, path) || '.'}`);
  }
  if (metadata.isFile()) return { bytes: metadata.size, oldestMtimeMs: metadata.mtimeMs };
  if (!metadata.isDirectory()) return { bytes: 0, oldestMtimeMs: metadata.mtimeMs };
  let bytes = 0;
  let oldestMtimeMs = metadata.mtimeMs;
  for (const name of readdirSync(path).sort()) {
    const usage = directoryUsage(join(path, name), root);
    bytes += usage.bytes;
    oldestMtimeMs = Math.min(oldestMtimeMs, usage.oldestMtimeMs);
  }
  return { bytes, oldestMtimeMs };
}

function pruneCacheToBudget(cacheRoot, budgetBytes, projectRoot) {
  const entriesRoot = join(cacheRoot, 'entries');
  if (!existsSync(entriesRoot)) return { removedBytes: 0, remainingBytes: 0, removedEntries: 0 };
  assertOutsideProjectNodeModules(entriesRoot, projectRoot);
  const entriesMetadata = lstatSync(entriesRoot);
  const resolvedCacheRoot = realpathWithMissingSegments(cacheRoot);
  const resolvedEntriesRoot = realpathWithMissingSegments(entriesRoot);
  if (entriesMetadata.isSymbolicLink()
    || !resolvedPathInside(resolvedEntriesRoot, resolvedCacheRoot)) {
    throw new Error('release cache budget refused entries root outside the cache root');
  }
  if (!entriesMetadata.isDirectory()) {
    throw new Error('release cache budget refused non-directory entries root');
  }
  const candidates = [];
  for (const phase of readdirSync(entriesRoot).sort()) {
    const phaseRoot = join(entriesRoot, phase);
    const phaseMetadata = lstatSync(phaseRoot);
    if (phaseMetadata.isSymbolicLink()) {
      throw new Error(`release cache budget refused symbolic link: ${relative(entriesRoot, phaseRoot)}`);
    }
    if (!phaseMetadata.isDirectory()) continue;
    for (const name of readdirSync(phaseRoot).sort()) {
      const path = join(phaseRoot, name);
      const usage = directoryUsage(path, entriesRoot);
      candidates.push({ path, relativePath: relative(entriesRoot, path), ...usage });
    }
  }
  let remainingBytes = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
  let removedBytes = 0;
  let removedEntries = 0;
  candidates.sort((left, right) => left.oldestMtimeMs - right.oldestMtimeMs
    || left.relativePath.localeCompare(right.relativePath));
  for (const entry of candidates) {
    if (remainingBytes <= budgetBytes) break;
    removeCachePath(entry.path, { recursive: true, force: true }, projectRoot);
    remainingBytes -= entry.bytes;
    removedBytes += entry.bytes;
    removedEntries += 1;
  }
  return { removedBytes, remainingBytes, removedEntries };
}

export async function captureReleaseBuildCache(root, phase, options = {}) {
  const started = Date.now();
  if ((options.env ?? process.env).O8_RELEASE_BUILD_CACHE === 'off') {
    return { phase, status: 'bypass', reason: 'disabled', durationMs: Date.now() - started };
  }
  const identity = options.identity ?? collectReleaseBuildCacheIdentity(root, phase, options);
  const config = phaseConfig(phase, options.buildOptions);
  const cacheRoot = operationCacheRoot(options);
  if (identity.source.worktreeClean === false) {
    return { phase, status: 'bypass', reason: 'dirty_worktree', durationMs: Date.now() - started };
  }
  const missing = config.targets.filter((target) => !existsSync(join(root, target)));
  if (missing.length > 0) {
    return { phase, status: 'miss', reason: `target_missing:${missing[0]}`, durationMs: Date.now() - started };
  }
  for (const target of config.targets) assertTreeHasNoLinks(join(root, target));
  const directory = entriesDirectory(cacheRoot, identity);
  assertOutsideProjectNodeModules(directory, root);
  ensurePrivateDirectory(directory);
  const finalManifestPath = manifestPathFor(directory, identity.entrySha256);
  const finalArchivePath = archivePathFor(directory, identity.entrySha256);
  if (existsSync(finalManifestPath) || existsSync(finalArchivePath)) {
    const verified = await verifyCacheEntry(root, identity, finalManifestPath, config);
    if (verified.valid) {
      return {
        phase,
        status: 'already_captured',
        reason: 'verified',
        entrySha256: identity.entrySha256,
        archiveBytes: verified.manifest.archive.size,
        durationMs: Date.now() - started,
      };
    }
    for (const path of [finalManifestPath, finalArchivePath].filter(existsSync)) {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error('Invalid cache entry is not a private regular file.');
      removeCachePath(path, { force: true }, root);
    }
  }
  const staging = await beginCacheStaging(cacheRoot, root, phase, identity, { ...options, action: 'capture' });
  const temporaryArchive = join(staging.path, 'archive.tar');
  try {
    await staging.destinations([finalArchivePath, finalManifestPath]);
    await staging.populate(tarArguments(root, config, '-'), 'archive.tar');
    const archive = {
      name: basename(finalArchivePath),
      size: statSync(temporaryArchive).size,
      sha256: await sha256File(temporaryArchive),
    };
    const manifest = {
      schema: RELEASE_BUILD_CACHE_SCHEMA,
      phase,
      createdAt: new Date().toISOString(),
      entrySha256: identity.entrySha256,
      compatibilitySha256: identity.compatibilitySha256,
      sourceSha256: identity.sourceSha256,
      source: identity.source,
      compatibility: identity.compatibility,
      ...(phase === 'native' && !config.portable ? { nativeCheckoutSha256: nativeCheckoutIdentity(root) } : {}),
      targets: config.targets,
      excludes: config.excludes,
      buildDurationMs: options.buildDurationMs ?? null,
      archive,
    };
    await staging.write('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
    await staging.promote(temporaryArchive, finalArchivePath, 'file');
    await staging.promote(join(staging.path, 'manifest.json'), finalManifestPath, 'file');
    await staging.clean();
    pruneEntries(directory, identity.entrySha256, root);
    pruneCompatibilityDirectories(cacheRoot, phase, identity.compatibilitySha256, root);
    const pruned = pruneCacheToBudget(
      cacheRoot,
      cacheBudgetBytes(options.env ?? process.env, cacheRoot),
      root,
    );
    if (pruned.removedEntries > 0) {
      console.log(`[release-cache] budget pruned=${pruned.removedEntries} bytes=${pruned.removedBytes}`);
    }
    return {
      phase,
      status: 'captured',
      reason: 'verified',
      entrySha256: identity.entrySha256,
      archiveBytes: archive.size,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    await staging.hold(error);
    if (isReleaseBuildCacheSafetyError(error)) throw error;
    return { phase, status: 'miss', reason: `capture_held:${error.message}; staging=${staging.runId}/${staging.operationId}`, durationMs: Date.now() - started };
  }
}

export { createReleaseBuildCacheRunId, writeReleaseBuildCachePhaseReceipt } from './release-build-cache-staging.mjs';

export async function finalizeReleaseBuildCacheReceipt(cacheRoot, runId, summary, options = {}) {
  assertOutsideProjectNodeModules(cacheRoot, options.projectRoot ?? process.cwd());
  return finalizeCacheReceipt(cacheRoot, runId, summary, options, {
    isReleaseBuildCachePhaseReceiptName, ensurePrivateDirectory,
  });
}

export const releaseBuildCacheInternals = {
  PHASE_CONFIG,
  assertOutsideProjectNodeModules,
  collectWebEnvironmentFiles,
  isReleaseBuildCacheJsonCandidate,
  isReleaseBuildCachePhaseReceiptName,
  normalizeArchivePath,
  pathAllowed,
  phaseConfig,
  pruneCacheToBudget,
  sha256File,
  stableJson,
};
