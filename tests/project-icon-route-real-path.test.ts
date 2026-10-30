/**
 * Adapted tests for T3 Code project icons (https://github.com/pingdotgg/t3code),
 * apps/server/src/project/ProjectFaviconResolver.test.ts, commit
 * f58fad04162165653bf06f0c987bbfb0074a8a4b. Copyright (c) 2026 T3 Tools Inc.
 * MIT; see licenses/t3code-MIT.txt. Adaptation: o8 HTTP routes and SQLite restart.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createFixtureChildLifetime } from './fixtures/fixture-child-lifetime.fixture';

const token = 'project-icon-test-token';
const lifetime = createFixtureChildLifetime();
let root: string, data: string, repo: string, origin: string, child: ChildProcess;
const fixtureId = 'project-icon-fixture';
const svg = (label: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><title>${label}</title><rect width="16" height="16" fill="blue"/></svg>`;
function file(name: string, content: string | Buffer) {
  const target = join(repo, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); return target;
}
async function start() {
  child = lifetime.track(spawn(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'tests/fixtures/project-icon-route-server.ts',
  ], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, HOME: root, O8_DATA_DIR: data, CORTEX_IDE_DATA_DIR: data, WS_TOKEN: token },
  }));
  let diagnostics = '';
  child.stderr!.on('data', chunk => { diagnostics += String(chunk); });
  const [{ port }] = await Promise.race([
    once(child, 'message') as Promise<[{ port: number }]>,
    once(child, 'exit').then(() => { throw new Error(`Icon fixture exited: ${diagnostics.slice(-1500)}`); }),
  ]);
  origin = `http://127.0.0.1:${port}`;
}
async function request(path: string, body?: unknown) {
  return fetch(new URL(path, origin), { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
}
async function image(expected: string) {
  const response = await request(`/api/panel/repo-icon?id=${fixtureId}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('image/svg+xml');
  expect(await response.text()).toContain(`<title>${expected}</title>`);
}

// Cold tsx imports initialize the production route graph before any request is
// measured. Allow shared runners to finish startup; request budgets remain 20s.
beforeEach(async () => {
  lifetime.begin(); root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-project-icons-')));
  data = join(root, 'data'); repo = join(root, 'repo');
  mkdirSync(data); mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(data, 'repos.json'), JSON.stringify({ version: 1, repos: [{
    id: fixtureId, name: 'Icon fixture', localPath: repo, remoteUrl: null, defaultBranch: 'main', isGitRepo: true,
    addedAt: new Date(0).toISOString(), lastOpenedAt: null, storagePressureParkingDisabled: false,
    setup: { envMode: 'skip', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
      buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null, workspaceIsolationPreference: 'auto' },
  }] }));
  await start();
}, 90_000);
afterEach(async () => { await lifetime.close(); rmSync(root, { recursive: true, force: true }); });

it('serves the resolved config and stored image with its image type and bytes', async () => {
  file('brand/config.svg', svg('config')); file('t3.json', JSON.stringify({ iconPath: 'brand/config.svg' }));
  await image('config');
  file('brand/explicit.svg', svg('explicit'));
  expect((await request('/api/panel/repos', { action: 'update-icon', id: fixtureId, faviconPath: 'brand/explicit.svg' })).status).toBe(200);
  await image('explicit');
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('recovers from an image read failure without retaining the failure', async () => {
  const selected = file('favicon.svg', svg('recovered')); await image('recovered');
  chmodSync(selected, 0);
  try { expect((await request(`/api/panel/repo-icon?id=${fixtureId}`)).status).toBeGreaterThanOrEqual(400); }
  finally { chmodSync(selected, 0o600); }
  await image('recovered');
});
