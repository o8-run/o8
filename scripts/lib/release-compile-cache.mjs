import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { resolveReleaseBuildCacheRoot } from './release-build-cache.mjs';

function canonical(path) {
  if (existsSync(path)) return realpathSync(path);
  return join(canonical(dirname(path)), relative(dirname(path), path));
}

/** Configure only Cargo's environment; never execute a wrapper probe with release secrets. */
export function releaseCompileEnvironment(root, env = process.env) {
  const off = reason => {
    console.log(`[release-cache] Rust compile cache off (${reason})`);
    return env;
  };
  if (env.O8_RELEASE_SCCACHE === 'off') return off('disabled');
  const wrapper = (env.PATH || '').split(delimiter).map(dir => resolve(dir, 'sccache')).find(path => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  });
  if (!wrapper) return off('sccache unavailable');
  if (env.RUSTC_WRAPPER && env.RUSTC_WRAPPER !== wrapper) return off('existing RUSTC_WRAPPER');
  const directory = join(resolveReleaseBuildCacheRoot(env), 'sccache');
  const checkout = canonical(resolve(root));
  const cache = canonical(directory);
  if (cache === checkout || cache.startsWith(checkout + sep) || checkout.startsWith(cache + sep)) {
    throw new Error('Rust compile cache must be outside the checkout.');
  }
  console.log(`[release-cache] Rust compile cache on directory=${directory}`);
  return { ...env, RUSTC_WRAPPER: wrapper, SCCACHE_DIR: directory };
}
