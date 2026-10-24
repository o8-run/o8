import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MARKER = '.o8-release-cargo-target';
const SCHEMA = 'o8/release-cargo-target/v1';
const DEFAULT_BUDGET = 20 * 1024 ** 3;
const inside = (path, root) => path === root || path.startsWith(root + sep);

function canonical(path) {
  if (existsSync(path)) return realpathSync(path);
  return join(canonical(dirname(path)), relative(dirname(path), path));
}

/** The release wrapper and runner use this; tauri dev keeps Cargo's own target. */
export function releaseCargoTarget(root, cacheRoot, env = process.env) {
  const selected = env.O8_RELEASE_CARGO_TARGET_DIR || join(cacheRoot, 'cargo-target');
  if (!isAbsolute(selected)) throw new Error('Release Cargo target must be absolute.');
  const requested = resolve(selected);
  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) throw new Error('Release Cargo target is redirected.');
  const target = canonical(requested);
  const checkout = realpathSync(root);
  if (inside(target, checkout) || inside(checkout, target)
    || (env.CARGO_TARGET_DIR && canonical(resolve(root, 'src-tauri', env.CARGO_TARGET_DIR)) === target)) {
    throw new Error('Release Cargo target must be outside the checkout and separate from development Cargo output.');
  }
  const budget = env.O8_RELEASE_CARGO_TARGET_MAX_BYTES === undefined
    ? DEFAULT_BUDGET : Number(env.O8_RELEASE_CARGO_TARGET_MAX_BYTES);
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error('Release Cargo target budget must be a non-negative integer.');
  const marker = join(target, MARKER);
  if (existsSync(target)) {
    if (!lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) throw new Error('Release Cargo target is redirected.');
    if (!existsSync(marker) && readdirSync(target).length) throw new Error('Release Cargo target contains unowned output.');
  } else mkdirSync(target, { recursive: true, mode: 0o700 });
  if (!existsSync(marker)) writeFileSync(marker, SCHEMA, { flag: 'wx', mode: 0o600 });
  const stat = lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || readFileSync(marker, 'utf8') !== SCHEMA)
    throw new Error('Release Cargo target ownership marker is invalid.');
  return { path: target, budget };
}

function bytes(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + bytes(join(path, name)), 0);
}

/** Whole compiler state is disposable, only after Cargo has exited. Keep ownership. */
export function pruneReleaseCargoTarget(target) {
  const before = lstatSync(target.path);
  const entries = readdirSync(target.path).filter(name => name !== MARKER && name !== '.o8-release-cargo-lock');
  const usage = entries.reduce((sum, name) => sum + bytes(join(target.path, name)), 0);
  if (usage <= target.budget) return;
  const after = lstatSync(target.path);
  if (before.dev !== after.dev || before.ino !== after.ino || after.isSymbolicLink())
    throw new Error('Release Cargo target identity changed before cleanup.');
  for (const name of entries) rmSync(join(target.path, name), { recursive: true, force: true });
  console.log(`[release-cache] Cargo target pruned bytes=${usage} budget=${target.budget}`);
}
