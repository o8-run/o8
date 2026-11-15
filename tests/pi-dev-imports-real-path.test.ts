import { cliBuildOptions } from '../cli/build-options.mjs';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { bundlePiSdk } from '../scripts/lib/pi-sdk-bundle.mjs';

const execute = promisify(execFile);

it.each(['development', 'packaged'] as const)('runs a Pi lead and reopens a durable conversation in the %s host', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'o8-pi-dev-'));
  try {
    const env = { ...process.env, CORTEX_IDE_DATA_DIR: root };
    let args = ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'tests/fixtures/pi-dev-host.ts', root];
    if (mode === 'packaged') {
      const bundle = join(root, 'host.mjs');
      const requireFromRoot = createRequire(resolve('package.json'));
      // The export's Node/ESM shape, server-only alias and native exclusions.
      // Native modules resolve from the checkout, standing in for exported node_modules.
      await build({ entryPoints: ['tests/fixtures/pi-dev-host.ts'], outfile: bundle,
        bundle: true, platform: 'node', format: 'esm',
        alias: { 'server-only': resolve('scripts/server-only-stub.js') },
        external: ['node-pty', 'better-sqlite3', 'bindings', ...cliBuildOptions({ outfile: bundle, version: 'test' }).external!], logLevel: 'silent',
        plugins: [{ name: 'fixture-native-resolution', setup(builder) {
          builder.onResolve({ filter: /^(node-pty|better-sqlite3|bindings)$/ }, args => ({
            path: requireFromRoot.resolve(args.path), external: true,
          }));
        } }],
        banner: { js: 'import { createRequire as __o8_createRequire } from "node:module";'
          + `const require = __o8_createRequire(${JSON.stringify(resolve('package.json'))});`
          + 'import { fileURLToPath as __o8_fileURLToPath } from "node:url"; import { dirname as __o8_dirname } from "node:path";'
          + 'const __filename = __o8_fileURLToPath(import.meta.url); const __dirname = __o8_dirname(__filename);' },
      });
      const piDir = join(root, 'pi-sdk');
      bundlePiSdk({ root: process.cwd(), outDir: piDir });
      Object.assign(env, { O8_PACKAGED_APP: '1', O8_PI_SDK_DIR: piDir });
      args = [bundle, root];
    }
    const { stdout } = await execute(process.execPath, args, { cwd: process.cwd(), timeout: 30_000, env });
    expect(JSON.parse(stdout.trim())).toEqual({ transportCalls: 1, reply: 'Dev answer.', retained: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
