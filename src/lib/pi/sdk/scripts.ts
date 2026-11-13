import { existsSync, readFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PiSdkScript = 'worker.mjs';

const SOURCE: Record<PiSdkScript, () => URL> = {
  'worker.mjs': () => new URL('../../../../scripts/pi-sdk/worker.mjs', import.meta.url),
};

/**
 * The packaged server runs from Resources/server, where the desktop export puts
 * the bundled worker in pi-sdk/ (#3255). Source checkouts run the scripts in place.
 */
export function piSdkScriptPath(name: PiSdkScript, env: Record<string, string | undefined> = process.env): string {
  const file = env.O8_PACKAGED_APP === '1'
    ? join(env.O8_PI_SDK_DIR || join(process.cwd(), 'pi-sdk'), name)
    : fileURLToPath(SOURCE[name]());
  if (!existsSync(file)) throw new Error(`Pi SDK ${name} is missing from this build`);
  return file;
}

/** Shared native supervision/write binary, resolved from trusted server resources, never packet cwd. */
export function nativeProcessHelperPath(env: Record<string, string | undefined> = process.env, moduleUrl = import.meta.url): string {
  if (env.O8_PI_WRITE_BIN) {
    if (!existsSync(env.O8_PI_WRITE_BIN)) throw new Error('Native process helper override is missing from this build');
    return env.O8_PI_WRITE_BIN;
  }
  const entry = dirname(fileURLToPath(moduleUrl));
  const roots: string[] = [];
  for (let directory = entry, depth = 0; depth < 8; depth++) {
    roots.push(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  // Packaged stdio tools may have no shell-injected helper environment.
  const contents = roots.find(directory => basename(directory) === 'Contents'
    && entry.startsWith(join(directory, 'Resources') + '/'));
  const bundled = [join(entry, 'o8-pi-write'), ...(contents ? [join(contents, 'MacOS', 'o8-pi-write')] : [])];
  const shipped = bundled.find(file => existsSync(file));
  if (shipped) return shipped;
  if (env.O8_PACKAGED_APP !== '1') for (const directory of roots) {
    let name: unknown;
    try { name = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name; } catch { continue; }
    if (name !== 'o8') continue;
    const file = join(directory, 'src-tauri', 'sidecars', 'pi-write', 'target', 'release', 'o8-pi-write');
    if (existsSync(file)) return file;
    break;
  }
  throw new Error('Native process helper is missing from this build');
}

/** Pi approved writes use the same binary as shared installer supervision. */
export function piWriteHelperPath(env: Record<string, string | undefined> = process.env, moduleUrl = import.meta.url): string {
  try { return nativeProcessHelperPath(env, moduleUrl); }
  catch { throw new Error('Pi write helper is missing from this build'); }
}
