import { build, type Plugin } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cliBuildOptions } from '../../cli/build-options.mjs';

const sqliteRuntime = fileURLToPath(new URL('../../cli/src/sqlite-runtime.ts', import.meta.url));
// A test bundle is written to a temp directory, where the bundled better-sqlite3 cannot find its
// package root or native binding. Load the checkout's own module instead, as the runtime does
// in a source checkout.
const checkoutSqlite: Plugin = {
  name: 'test-checkout-sqlite',
  setup(bundle) {
    bundle.onResolve({ filter: /^better-sqlite3$/ }, ({ importer }) => importer === sqliteRuntime
      ? { path: createRequire(import.meta.url).resolve('better-sqlite3'), external: true }
      : undefined);
  },
};

/**
 * Builds the o8 CLI to `outfile` with the shipped bundle's own esbuild options, so a test's CLI
 * fails to build exactly when `npm run build:cli` does, and never on options of its own (#5736).
 * Only SQLite's native module loads from the checkout.
 */
export async function buildCliBundle(outfile: string, version = 'test'): Promise<void> {
  const options = cliBuildOptions({ outfile, version });
  await build({ ...options, plugins: [checkoutSqlite, ...(options.plugins ?? [])] });
}
