import { accessSync, constants, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function executableO8d(binary: string): boolean {
  try { accessSync(binary, constants.X_OK); return statSync(binary).isFile(); }
  catch { return false; }
}

/** Same trusted Resources/server to Contents/MacOS lookup as the Pi helper. */
export function o8dBinaryPath(env: Record<string, string | undefined> = process.env, moduleUrl = import.meta.url): string {
  const configured = env.O8D_BINARY;
  if (configured) {
    if (!isAbsolute(configured) && !/[\\/]/.test(configured)) {
      throw new Error('O8D_BINARY must be an explicit executable path');
    }
    return resolve(configured);
  }
  const entry = dirname(fileURLToPath(moduleUrl));
  let contents: string | undefined;
  for (let directory = entry, depth = 0; depth < 8; depth++) {
    if (basename(directory) === 'Contents' && entry.startsWith(join(directory, 'Resources') + '/')) {
      contents = directory;
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const bundled = env.O8_PACKAGED_APP === '1' || contents
    ? [join(entry, 'o8d'), ...(contents ? [join(contents, 'MacOS', 'o8d')] : [])] : [];
  return bundled.find(executableO8d) ?? join(process.cwd(), 'crates/o8d/target/release',
    process.platform === 'win32' ? 'o8d.exe' : 'o8d');
}
