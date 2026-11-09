// esbuild options for the o8 CLI bundle, shared by cli/esbuild.config.mjs and the tests that
// build their own CLI, so a test bundle is built the way the shipped one is (#5736).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliBundleAlias } from './bundle-alias.mjs';

const cliRoot = dirname(fileURLToPath(import.meta.url));
const sqliteRuntime = join(cliRoot, 'src', 'sqlite-runtime.ts');
const sqlitePlugin = {
  name: 'cli-sqlite-runtime',
  setup(build) {
    build.onResolve({ filter: /^better-sqlite3$/ }, ({ importer }) => {
      // The runtime keeps a bundled fallback for dependency-free CLI commands.
      if (importer !== sqliteRuntime) return { path: sqliteRuntime };
    });
  },
};

// esbuild rewrites CJS `require()` calls into a `__require` shim that checks
// `typeof require !== "undefined"`. With pure ESM output, that local `require`
// from createRequire doesn't reach the shim's scope, so any bundled CJS
// module (e.g. `ws` from #1037 mission_tail) throws "Dynamic require of X"
// on first call. Exposing `require` via globalThis lets the shim find it.
export const ESM_BANNER = `#!/usr/bin/env node
import { createRequire as __o8_createRequire } from "module";
import { fileURLToPath as __o8_fileURLToPath } from "url";
import { dirname as __o8_dirname } from "path";
const require = __o8_createRequire(import.meta.url);
globalThis.require = require;
const __filename = __o8_fileURLToPath(import.meta.url);
const __dirname = __o8_dirname(__filename);
`;

/** The CLI bundle's esbuild options, writing `outfile` and reporting `version` from `o8 version`. */
export function cliBuildOptions({ outfile, version }) {
  return {
    entryPoints: [join(cliRoot, 'src', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: ESM_BANNER },
    define: { __O8_CLI_VERSION__: JSON.stringify(version) },
    plugins: [sqlitePlugin],
    alias: cliBundleAlias,
    // The native route registry's dynamic imports reach the browser-automation route, which loads
    // playwright-core. No CLI command runs it, and its bundle requires optional packages the lock
    // does not install, so leave it as a runtime require instead of failing the build (#5736).
    external: ['playwright-core'],
    outfile,
  };
}
