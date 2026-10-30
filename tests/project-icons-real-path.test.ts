/**
 * Adapted tests for T3 Code project icons (https://github.com/pingdotgg/t3code),
 * apps/server/src/project/ProjectFaviconResolver.test.ts, commit
 * f58fad04162165653bf06f0c987bbfb0074a8a4b. Copyright (c) 2026 T3 Tools Inc.
 * MIT; see licenses/t3code-MIT.txt. Adaptation: o8 HTTP routes and SQLite restart.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createFixtureChildLifetime } from './fixtures/fixture-child-lifetime.fixture';

type Icon = { resourceUrl: string | null; faviconPath: string | null; projectIcon: unknown };
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
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'tests/fixtures/project-icon-server.ts',
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
async function stop() {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close'); child.kill('SIGTERM'); await closed;
}
async function request(path: string, body?: unknown) {
  return fetch(new URL(path, origin), { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
}
async function icon(): Promise<Icon> {
  const response = await request('/api/panel/repos'); expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.repos[0].icon, 'repository listing must project its icon').toBeDefined();
  return result.repos[0].icon;
}
async function update(patch: object) {
  return request('/api/panel/repos', { action: 'update-icon', id: fixtureId, ...patch });
}
async function image(expected: string) {
  const projected = await icon(); expect(projected.resourceUrl).toBeTruthy();
  const response = await request(projected.resourceUrl!); expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('image/svg+xml');
  expect(await response.text()).toContain(`<title>${expected}</title>`);
  return projected;
}

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
});
afterEach(async () => { await lifetime.close(); rmSync(root, { recursive: true, force: true }); });

it('projects explicit, config, ordered well-known and HTML icons through the real routes', async () => {
  file('brand/explicit.svg', svg('explicit')); file('brand/config.svg', svg('config'));
  file('t3.json', JSON.stringify({ iconPath: 'brand/config.svg' }));
  file('favicon.svg', svg('well-known')); file('public/favicon.svg', svg('public'));
  file('public/custom.svg', svg('metadata'));
  file('index.html', '<link href="/custom.svg?v=1" rel="icon">');
  await image('config');
  expect((await update({ faviconPath: 'brand/explicit.svg' })).status).toBe(200);
  await image('explicit');
  rmSync(join(repo, 'brand/explicit.svg')); await image('config');
  rmSync(join(repo, 'brand/config.svg')); await image('well-known');
  rmSync(join(repo, 'favicon.svg')); await image('public');
  rmSync(join(repo, 'public/favicon.svg')); await image('metadata');
  rmSync(join(repo, 'public/custom.svg')); expect((await icon()).resourceUrl).toBeNull();
});

it('discovers router metadata after the ordered HTML sources', async () => {
  file('src/routes/__root.tsx', "const meta = { rel: 'icon', href: '/brand.svg' };");
  file('public/brand.svg', svg('router')); await image('router');
});

it('reads icon links from source documents larger than the image byte cap', async () => {
  file('index.html', `${' '.repeat(1024 * 1024 + 256)}<link rel="icon" href="/brand.svg">`);
  file('public/brand.svg', svg('large source')); await image('large source');
});

it.each([
  ['trimmed path', '{ "iconPath": "  brand/config.svg  " }'],
  ['comments and trailing comma', '{ /* project icon */ "iconPath": "brand/config.svg", // preferred over favicon\n }'],
])('accepts T3 configuration with %s before well-known icons', async (_label, config) => {
  file('brand/config.svg', svg('config')); file('favicon.svg', svg('fallback'));
  file('t3.json', config); await image('config');
});

it('persists separate file and normalized identity overrides across a server restart', async () => {
  file('chosen.svg', svg('chosen'));
  expect((await update({ faviconPath: 'chosen.svg' })).status).toBe(200);
  expect((await update({ projectIcon: { kind: 'monogram', text: ' ａｂ ', color: 'blue' } })).status).toBe(200);
  await stop(); await start();
  expect(await image('chosen')).toEqual(expect.objectContaining({ faviconPath: 'chosen.svg', projectIcon: { kind: 'monogram', text: 'AB', color: 'blue' } }));
  expect((await update({ projectIcon: { kind: 'emoji', emoji: '🌱' } })).status).toBe(200);
  expect((await icon()).faviconPath).toBe('chosen.svg');
  expect((await update({ projectIcon: { kind: 'lucide', name: 'folder-code', color: 'violet' } })).status).toBe(200);
  expect((await icon()).projectIcon).toEqual({ kind: 'lucide', name: 'folder-code', color: 'violet' });
  expect((await update({ projectIcon: null })).status).toBe(200);
  expect((await icon()).projectIcon).toBeNull();
  expect(readFileSync(join(data, 'cortex-ide.db')).length).toBeGreaterThan(0);
});

it('rejects outside override paths and symlinks without changing the saved icon', async () => {
  file('chosen.svg', svg('chosen'));
  expect((await update({ faviconPath: 'chosen.svg' })).status).toBe(200);
  const outside = join(root, 'outside.svg'); writeFileSync(outside, svg('outside'));
  symlinkSync(outside, join(repo, 'escape.svg'));
  for (const faviconPath of [outside, '../outside.svg', 'escape.svg']) {
    expect((await update({ faviconPath })).status).toBe(400);
    expect((await icon()).faviconPath).toBe('chosen.svg');
  }
  // Discovery uses the same realpath boundary, including configured candidates.
  expect((await update({ faviconPath: null })).status).toBe(200);
  file('t3.json', JSON.stringify({ iconPath: 'escape.svg' }));
  symlinkSync(outside, join(repo, 'favicon.svg'));
  expect((await icon()).resourceUrl).toBeNull();
});

it('refuses non-images and files larger than 1 MiB, and validates identity input', async () => {
  file('notes.txt', 'not an icon'); file('huge.svg', Buffer.alloc(1024 * 1024 + 1, 65));
  for (const faviconPath of ['notes.txt', 'huge.svg']) expect((await update({ faviconPath })).status).toBe(400);
  for (const projectIcon of [{ kind: 'monogram', text: 'ABC', color: 'blue' }, { kind: 'lucide', name: '../bad', color: 'blue' }, { kind: 'emoji', emoji: '' }]) {
    expect((await update({ projectIcon })).status).toBe(400);
  }
  expect((await icon()).resourceUrl).toBeNull();
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('recovers from an image read failure without retaining the failure', async () => {
  const selected = file('favicon.svg', svg('recovered')); const selectedIcon = await image('recovered');
  chmodSync(selected, 0);
  try { expect((await request(selectedIcon.resourceUrl!)).status).toBeGreaterThanOrEqual(400); }
  finally { chmodSync(selected, 0o600); }
  await image('recovered');
});
