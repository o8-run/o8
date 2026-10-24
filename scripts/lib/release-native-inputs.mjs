import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveReleaseBuildEnvironment, resolveReleaseConfig } from './release-config.mjs';

export const NATIVE_ARTIFACT = 'src-tauri/target/.release-native-artifact';
export const SPEECH_HELPERS = ['', '-aarch64-apple-darwin', '-universal-apple-darwin', '-x86_64-apple-darwin']
  .map(suffix => `src-tauri/helpers/speech-local${suffix}`);

export async function sameCachedTree(left, right, hashFile) {
  if (!existsSync(right)) return false;
  const a = lstatSync(left); const b = lstatSync(right);
  if (a.isSymbolicLink() || b.isSymbolicLink() || a.isDirectory() !== b.isDirectory()) return false;
  if (a.isFile()) return b.isFile() && a.nlink === 1 && b.nlink === 1 && a.size === b.size
    && (a.mode & 0o777) === (b.mode & 0o777) && await hashFile(left) === await hashFile(right);
  if (!a.isDirectory()) return false;
  const names = readdirSync(left).sort();
  if (JSON.stringify(names) !== JSON.stringify(readdirSync(right).sort())) return false;
  for (const name of names) if (!await sameCachedTree(join(left, name), join(right, name), hashFile)) return false;
  return true;
}

export function nativeCacheConfig(base, buildOptions = {}) {
  if (buildOptions.nativeArtifact) return { ...base, portable: true, targets: [NATIVE_ARTIFACT], excludes: [] };
  const args = buildOptions.cargoTauriArgs ?? [];
  const beforeSeparator = args.slice(0, args.includes('--') ? args.indexOf('--') : args.length);
  const index = beforeSeparator.indexOf('--target');
  const target = index >= 0 ? beforeSeparator[index + 1] : beforeSeparator.find(arg => arg.startsWith('--target='))?.slice(9);
  const triples = target === 'universal-apple-darwin'
    ? ['x86_64-apple-darwin', 'aarch64-apple-darwin', 'universal-apple-darwin'] : target ? [target] : [];
  if (!triples.length) return base;
  const targets = triples.map(triple => `src-tauri/target/${triple}/release`);
  return { ...base, targets, excludes: targets.flatMap(dir => [`${dir}/bundle`, `${dir}/server`, `${dir}/build-cache-receipt.json`]) };
}

export function nativeSourceInputs(root) {
  // Tracked input enumeration excludes generated permissions, helpers and Cargo
  // state. Dirty/untracked inputs cause the public cache entry points to bypass.
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const crateRoots = tracked.filter(path => path.endsWith('/Cargo.toml') && path !== 'src-tauri/Cargo.toml' && !path.startsWith('src-tauri/sidecars/'))
    .map(path => path.slice(0, -'Cargo.toml'.length));
  return tracked.filter(path =>
    (path.startsWith('src-tauri/') && !path.startsWith('src-tauri/sidecars/'))
    || path.startsWith('crates/') || path.startsWith('tauri-plugin-mcp/')
    || crateRoots.some(prefix => path.startsWith(prefix)) || path.startsWith('.cargo/')
    || path === 'Cargo.toml' || path === 'Cargo.lock'
    || /^rust-toolchain(\.toml)?$/.test(path)
    || path === 'src/lib/prompts/v1/symon-native-system.txt'
    || path === 'src/lib/symon/confirm-tool-phrases.json');
}

const hash = value => createHash('sha256').update(value).digest('hex');
const COMPILER_ENV = /^(CARGO_|RUST|CC($|_)|CXX($|_)|AR($|_)|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|LIBRARY_PATH$|PKG_CONFIG|CMAKE|BINDGEN_|SDKROOT$|DEVELOPER_DIR$|MACOSX_DEPLOYMENT_TARGET$|IPHONEOS_DEPLOYMENT_TARGET$|SWIFT|TAURI_|O8_SENTRY_DSN$|SENTRY_DSN$|NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY$)/;

export function nativeBuildSettings(root, buildOptions = {}) {
  const args = buildOptions.cargoTauriArgs ?? [];
  const configs = [];
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    const arg = args[index];
    const config = arg === '--config' || arg === '-c' ? args[++index] : arg.startsWith('--config=') ? arg.slice(9) : null;
    if (config && !config.trimStart().startsWith('{')) {
      const path = resolve(root, config);
      configs.push(existsSync(path) ? hash(readFileSync(path)) : 'missing');
    }
  }
  return { optionsSha256: hash(JSON.stringify(buildOptions)), configs };
}

export function compilerEnvironment(root, phase, env) {
  const effective = resolveReleaseBuildEnvironment(root, env);
  effective.SENTRY_DSN = resolveReleaseConfig(root, env).sentryDsn;
  // Operational cache locations/receipts do not change executable bytes.
  const names = Object.keys(effective).filter(name => (phase === 'speech'
    ? /^(SWIFT|SDKROOT$|DEVELOPER_DIR$|MACOSX_DEPLOYMENT_TARGET$|O8_TAURI_BUILD_TARGET$|TAURI_ENV_TARGET_TRIPLE$)/.test(name)
    : COMPILER_ENV.test(name))
    && name !== 'CARGO_TARGET_DIR' && name !== 'TAURI_SIGNING_PRIVATE_KEY' && name !== 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD');
  if (phase === 'native') {
    for (const path of nativeSourceInputs(root).filter(path => path.endsWith('.rs'))) {
      const text = readFileSync(join(root, path), 'utf8');
      for (const match of text.matchAll(/(?:option_env|env)!\(\s*"([^"]+)"/g)) {
        if (!/^(CARGO_|OUT_DIR$)/.test(match[1])) names.push(match[1]);
      }
    }
  }
  const values = Object.fromEntries([...new Set(names)].sort().map(name => [name, hash(String(effective[name] ?? ''))]));
  // Cargo also reads configuration outside the source tree. Persist only hashes.
  for (const name of phase === 'native' ? ['config', 'config.toml'] : []) {
    const path = join(env.CARGO_HOME || join(homedir(), '.cargo'), name);
    if (existsSync(path)) values[`cargo-config:${name}`] = hash(readFileSync(path));
  }
  return values;
}
