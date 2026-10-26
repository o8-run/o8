#!/usr/bin/env node
// Bundles cli/src/index.ts into cli/dist/o8.mjs as a single-file ESM Node binary.
// Mirrors the standalone-bundle pattern in scripts/tauri-export.mjs.

import * as esbuild from 'esbuild';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, 'src', 'index.ts');
const workerOutputIndex = process.argv.indexOf('--worker-output');
const workerOutput = workerOutputIndex < 0 ? null : process.argv[workerOutputIndex + 1];
if (workerOutputIndex >= 0 && !workerOutput) throw new Error('--worker-output requires a destination');
const outFile = workerOutput ? resolve(workerOutput) : join(__dirname, 'dist', 'o8.mjs');
mkdirSync(dirname(outFile), { recursive: true });

// Inject the app version (repo-root package.json, kept in sync by
// scripts/sync-version.mjs) so the bundled `o8 version` reports what it
// shipped with instead of the dev placeholder.
const rootPkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const cliVersion = rootPkg.version ?? '0.0.0-dev';

// esbuild rewrites CJS `require()` calls into a `__require` shim that checks
// `typeof require !== "undefined"`. With pure ESM output, that local `require`
// from createRequire doesn't reach the shim's scope, so any bundled CJS
// module (e.g. `ws` from #1037 mission_tail) throws "Dynamic require of X"
// on first call. Exposing `require` via globalThis lets the shim find it.
const ESM_BANNER = `#!/usr/bin/env node
import { createRequire as __o8_createRequire } from "module";
import { fileURLToPath as __o8_fileURLToPath } from "url";
import { dirname as __o8_dirname } from "path";
const require = __o8_createRequire(import.meta.url);
globalThis.require = require;
const __filename = __o8_fileURLToPath(import.meta.url);
const __dirname = __o8_dirname(__filename);
`;

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: ESM_BANNER },
  define: { __O8_CLI_VERSION__: JSON.stringify(cliVersion) },
  outfile: outFile,
});

chmodSync(outFile, 0o755);
// Worker launches build only their run-owned CLI from current source inputs.
if (workerOutput) process.exit(0);
// Keep the private PTY setup flow in a separate bundle. It can use the server's
// encrypted storage implementation without adding native modules to every CLI command.
await esbuild.build({
  entryPoints: [join(__dirname, '..', 'scripts', 'connect-native-worker.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: ESM_BANNER },
  alias: {
    '@': join(__dirname, '..', 'src'),
    'server-only': join(__dirname, '..', 'scripts', 'server-only-stub.js'),
  },
  external: ['node-pty'],
  outfile: join(__dirname, 'dist', 'worker-login.mjs'),
});
console.log(`built ${outFile}`);
