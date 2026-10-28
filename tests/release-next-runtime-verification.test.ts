import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertTauriExportInputsSafe } from '../scripts/lib/tauri-export-safety.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const app = mkdtempSync(join(tmpdir(), 'o8-runtime-gate-'));
  roots.push(app);
  const server = join(app, 'Contents/Resources/server');
  mkdirSync(join(server, '.next/server/app/api/health'), { recursive: true });
  mkdirSync(join(server, 'node_modules/next/dist/compiled/next-server'), { recursive: true });
  writeFileSync(join(server, 'node_modules/next/package.json'), '{"name":"next"}');
  writeFileSync(join(server, '.next/server/app/api/health/route.js'),
    'module.exports = require("next/dist/compiled/next-server/app-route.runtime.prod.js");');
  return { app, server };
}

it('release package verification refuses a route runtime missing from the sealed server tree', () => {
  const { app } = fixture();
  const result = spawnSync(process.execPath, ['scripts/next/verify-app-bundle.mjs', app], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Missing packaged Next runtime: next/dist/compiled/next-server/app-route.runtime.prod.js');
});

it('accepts every runtime required by route bundles and shared chunks, including extensionless imports', () => {
  const { server } = fixture();
  const runtimes = join(server, 'node_modules/next/dist/compiled/next-server');
  writeFileSync(join(runtimes, 'app-route.runtime.prod.js'), 'module.exports = {};');
  mkdirSync(join(server, '.next/server/chunks'), { recursive: true });
  writeFileSync(join(server, '.next/server/chunks/page.js'),
    'module.exports = require("next/dist/compiled/next-server/app-page.runtime.prod");');
  expect(() => assertTauriExportInputsSafe(server)).toThrow('app-page.runtime.prod');
  writeFileSync(join(runtimes, 'app-page.runtime.prod.js'), 'module.exports = {};');
  expect(() => assertTauriExportInputsSafe(server)).not.toThrow();
});

it('refuses a runtime link escaping the package even if the build checkout can resolve it', () => {
  const { server } = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'o8-runtime-outside-'));
  roots.push(outside);
  writeFileSync(join(outside, 'runtime.js'), 'module.exports = {};');
  symlinkSync(join(outside, 'runtime.js'),
    join(server, 'node_modules/next/dist/compiled/next-server/app-route.runtime.prod.js'));
  expect(() => assertTauriExportInputsSafe(server)).toThrow('link escapes the package');
});

it('refuses resolution from ancestor node_modules instead of accepting build-host dependencies', () => {
  const { app, server } = fixture();
  const fallback = join(app, 'node_modules/next/dist/compiled/next-server');
  mkdirSync(fallback, { recursive: true });
  writeFileSync(join(fallback, 'app-route.runtime.prod.js'), 'module.exports = {};');
  expect(() => assertTauriExportInputsSafe(server)).toThrow('Next runtime resolves outside the package');
});
