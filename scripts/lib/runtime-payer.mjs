// Source-run maintenance helpers use the application's payer boundary too.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const priorConfig = process.env.TSX_TSCONFIG_PATH;
let environment;
let processes;
try {
  // Helpers can run from a fixture/repository other than this source checkout.
  process.env.TSX_TSCONFIG_PATH = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));
  const { register } = await import('tsx/cjs/api');
  const unregister = register();
  try {
    const require = createRequire(import.meta.url);
    environment = require('../../src/lib/providers/spawn-environment.ts');
    processes = require('../../src/lib/providers/child-process.ts');
  } finally { unregister(); }
} finally {
  if (priorConfig === undefined) delete process.env.TSX_TSCONFIG_PATH;
  else process.env.TSX_TSCONFIG_PATH = priorConfig;
}
export const { childEnvironment, configuredMcpEnvironment } = environment;
export const { spawn, spawnSync, execFile, execFileSync } = processes;
