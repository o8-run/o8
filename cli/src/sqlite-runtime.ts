import BundledDatabase from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeRequire = createRequire(import.meta.url);

function loadDatabase(): typeof BundledDatabase {
  const serverRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const loader = join(serverRoot, 'native-addon-runtime.cjs');
  if (existsSync(loader) && existsSync(join(serverRoot, 'server.js'))
    && existsSync(join(serverRoot, 'ws-server.mjs'))) {
    // Match the desktop and worker bootstrap before loading the shipped module.
    // Keeping its JavaScript external preserves the package's binding root.
    if (process.platform === 'darwin') runtimeRequire(loader).prepareBetterSqlite3(serverRoot);
    return runtimeRequire(join(serverRoot, 'node_modules', 'better-sqlite3'));
  }

  // Source checkouts and conventional standalone installs use their own module.
  // Commands that need no SQLite still work from the single-file CLI alone.
  let installed: string;
  try {
    installed = runtimeRequire.resolve('better-sqlite3');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    return BundledDatabase;
  }
  return runtimeRequire(installed);
}

export default loadDatabase();
