import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assertNextRuntimeFilesPresent, assertTauriExportInputsSafe } from '../scripts/lib/tauri-export-safety.mjs';
import { stageRuntimeInputs } from './helpers/packaged-runtime-inputs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const app = mkdtempSync(join(tmpdir(), 'o8-runtime-gate-'));
  roots.push(app);
  const server = join(app, 'Contents/Resources/server');
  stageRuntimeInputs(server);
  mkdirSync(join(server, '.next/server/app/api/health'), { recursive: true });
  mkdirSync(join(server, 'node_modules/next/dist/compiled/next-server'), { recursive: true });
  writeFileSync(join(server, 'node_modules/next/package.json'), '{"name":"next"}');
  writeFileSync(join(server, '.next/server/app/api/health/route.js'),
    'module.exports = require("next/dist/compiled/next-server/app-route.runtime.prod.js");');
  return { app, server };
}

function completeFixture() {
  const result = fixture();
  writeFileSync(join(result.server, 'node_modules/next/dist/compiled/next-server/app-route.runtime.prod.js'),
    'module.exports = {};');
  return result;
}

it.each([
  ['.next/server', 'Missing packaged compiled server directory'],
  ['node_modules/bindings', 'Missing packaged runtime dependency: bindings'],
  ['node_modules/file-uri-to-path', 'Missing packaged runtime dependency: file-uri-to-path'],
  ['node_modules/better-sqlite3/lib/index.js', 'Missing packaged runtime dependency: better-sqlite3'],
  ['node_modules/better-sqlite3/lib/database.js', 'Missing packaged runtime dependency: ./database'],
])('rejects missing %s through both guards and the release verifier CLI', (missing, error) => {
  const { app, server } = completeFixture();
  rmSync(join(server, missing), { recursive: true });
  expect(() => assertNextRuntimeFilesPresent(server)).toThrow(error);
  expect(() => assertTauriExportInputsSafe(server)).toThrow(error);
  const result = spawnSync(process.execPath, ['scripts/next/verify-app-bundle.mjs', app], { encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(error);
});

it('accepts a complete package through both guards and reaches sidecar verification', () => {
  const { app, server } = completeFixture();
  expect(() => assertNextRuntimeFilesPresent(server)).not.toThrow();
  expect(() => assertTauriExportInputsSafe(server)).not.toThrow();
  const result = spawnSync(process.execPath, ['scripts/next/verify-app-bundle.mjs', app], { encoding: 'utf8' });
  expect(result.stderr).toContain('o8 next sidecar is missing');
});

it('refuses ancestor fallback for the SQLite loader chain', () => {
  const { app, server } = completeFixture();
  rmSync(join(server, 'node_modules/bindings'), { recursive: true });
  mkdirSync(join(app, 'node_modules/bindings'), { recursive: true });
  writeFileSync(join(app, 'node_modules/bindings/index.js'), 'module.exports = {};');
  expect(() => assertNextRuntimeFilesPresent(server)).toThrow('runtime dependency resolves outside the package: bindings');
});

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
