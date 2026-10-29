import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
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


function parseConfig(contents, toml = false) {
  try { return toml ? parseToml(contents) : JSON.parse(contents); }
  catch { throw new Error('Native cache configuration could not be parsed.'); }
}

function embeddedInput(path) {
  if (!existsSync(path)) return 'missing';
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error('Embedded frontend input is a symbolic link.');
  if (metadata.isFile()) return hash(readFileSync(path));
  if (!metadata.isDirectory()) throw new Error('Embedded frontend input is not a regular file or directory.');
  return hash(JSON.stringify(readdirSync(path).sort().map(name => [name, embeddedInput(join(path, name))])));
}

export function nativeBuildSettings(root, buildOptions = {}, env = process.env) {
  const args = buildOptions.cargoTauriArgs ?? [];
  const configs = [];
  let effective = {};
  const merge = (base, override) => {
    for (const [key, value] of Object.entries(override)) {
      base[key] = value && typeof value === 'object' && !Array.isArray(value)
        ? merge(base[key] && typeof base[key] === 'object' && !Array.isArray(base[key]) ? base[key] : {}, value) : value;
    }
    return base;
  };
  function apply(config) {
    effective = merge(effective, config);
  }
  function readConfig(path) {
    const contents = readFileSync(path, 'utf8');
    return parseConfig(contents, path.endsWith('.toml'));
  }
  const tauri = join(root, 'src-tauri');
  apply(readConfig(join(tauri, 'tauri.conf.json')));
  const targetIndex = args.indexOf('--target');
  const target = targetIndex >= 0 ? args[targetIndex + 1] : args.find(arg => arg.startsWith('--target='))?.slice(9);
  const platform = target ? target.includes('apple') ? 'macos' : target.includes('windows') ? 'windows' : 'linux'
    : process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  for (const name of [`tauri.${platform}.conf.json`, `tauri.${platform}.conf.json5`, `Tauri.${platform}.toml`]) {
    if (existsSync(join(tauri, name))) { apply(readConfig(join(tauri, name))); break; }
  }
  let hasOverrides = false;
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    const arg = args[index];
    const config = arg === '--config' || arg === '-c' ? args[++index] : arg.startsWith('--config=') ? arg.slice(9) : null;
    if (config) {
      hasOverrides = true;
      if (config.trimStart().startsWith('{')) apply(parseConfig(config));
      else {
        const path = resolve(root, config);
        configs.push(hash(readFileSync(path)));
        apply(readConfig(path));
      }
    }
  }
  if (!hasOverrides && env.TAURI_CONFIG) apply(parseConfig(env.TAURI_CONFIG));
  // The executable reads its version at runtime; the bundle step stamps it.
  delete effective.version;
  const frontendDist = effective.build?.frontendDist;
  const files = Array.isArray(frontendDist);
  const embedded = (files ? frontendDist : frontendDist ? [frontendDist] : [])
    .map(path => !files && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) ? 'url' : embeddedInput(resolve(tauri, path)));
  const icons = [...(effective.bundle?.icon ?? []), ...(effective.app?.trayIcon?.iconPath ? [effective.app.trayIcon.iconPath] : [])]
    .map(path => embeddedInput(resolve(tauri, path)));
  const canonical = value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : Array.isArray(value) ? value.map(canonical) : value;
  return { optionsSha256: hash(JSON.stringify(buildOptions)), configs, embedded, icons,
    effectiveConfigSha256: hash(JSON.stringify(canonical(effective))) };
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
