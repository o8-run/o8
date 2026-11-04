// @vitest-environment jsdom

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { act, createElement, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ProjectsSwitcher } from '@/components/desktop/agent-panel/ProjectsSwitcher';
import { useProjects } from '@/components/desktop/repo-registry/useProjects';
import { GET as readLedger } from '@/app/api/panel/projects/route';
import { POST as activate } from '@/app/api/panel/projects/active/route';
import { GET as listProjects, POST as createProject } from '@/app/api/projects/route';
import { GET as readProject, PATCH as editProject } from '@/app/api/projects/[id]/route';
import { POST as linkRepo } from '@/app/api/projects/[id]/repos/route';
import { GET as listRegistry, POST as editRegistry } from '@/app/api/panel/repos/route';
import { POST as initRepository } from '@/app/api/panel/repos/init/route';
import { listReposFresh } from '@/lib/repos/registry';
import { closeDb } from '@/lib/db';
import { invalidateFetchOnce } from '@/lib/panel/fetch-cache';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { ProjectWithRepos } from '@/lib/projects/types';
import { OPEN_SETTINGS_TAB_EVENT } from '@/lib/desktop/events';

const fixture = vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const paths = process.getBuiltinModule('node:path');
  return { home: fs.realpathSync(fs.mkdtempSync(paths.join(os.tmpdir(), 'o8-repository-sources-'))) };
});
// Isolate the clone root without replacing the process's HOME. Git, routes,
// registry, project ledger and SQLite stay real. Only visual adapters and
// external GitHub listing/background scans are stubbed; no provider calls.
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os') & { default: typeof import('node:os') }>();
  return { ...os, homedir: () => fixture.home, default: { ...os.default, homedir: () => fixture.home } };
});
vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: true, surface: 'glass', paletteId: 'dark' }) }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: { children: ReactNode; style: unknown }) => createElement('div', { style: style as HTMLAttributes<HTMLDivElement>['style'] }, children) }));
vi.mock('framer-motion', () => ({ useReducedMotion: () => true, motion: { div: ({ children, initial: _initial, animate: _animate, transition: _transition, ...props }: HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown; transition?: unknown }) => createElement('div', props, children) } }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let repos: RepoRegistryEntry[];
let project: ProjectWithRepos;
let server: Server;
let sourceUrl: string;
let secondUrl: string;
let staleUrl: string;
let missingUrl: string;
let clonePosts: number;
let failLink: boolean;
let loseCloneResponse: boolean;
let githubAuthenticated: boolean;

function git(args: string[], cwd: string) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim(); }
function makeRepo(name: string) {
  const folder = path.join(fixture.home, name); mkdirSync(folder);
  git(['init', '--initial-branch=main'], folder); writeFileSync(path.join(folder, 'README.md'), `# ${name}\n`);
  git(['add', 'README.md'], folder); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-m', 'initial'], folder);
  return folder;
}
function request(url: string, init?: RequestInit) {
  return new NextRequest(new URL(url, 'http://localhost'), { method: init?.method, body: init?.body, headers: { ...Object.fromEntries(new Headers(init?.headers)), host: 'localhost' } });
}
async function routedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost'); const req = request(url.href, init);
  if (url.pathname === '/api/panel/github-status') return Response.json({ authenticated: githubAuthenticated });
  if (url.searchParams.get('source') === 'github') return Response.json({ repos: [{ full_name: 'fixture/library', clone_url: 'https://github.com/fixture/library.git', private: true }] });
  if (url.pathname === '/api/panel/projects') return readLedger();
  if (url.pathname === '/api/panel/projects/active') return activate(req);
  if (url.pathname === '/api/panel/repos/init') return initRepository(req);
  if (url.pathname === '/api/panel/repos') {
    if (init?.method !== 'POST') return listRegistry(req);
    const isClone = JSON.parse(String(init?.body)).action === 'clone';
    if (isClone) clonePosts += 1;
    const response = await editRegistry(req);
    if (isClone && loseCloneResponse && response.ok) { loseCloneResponse = false; throw new Error('Response lost after registration'); }
    return response;
  }
  if (url.pathname === '/api/projects') return init?.method === 'POST' ? createProject(req) : listProjects(req);
  const parts = url.pathname.split('/'); const context = { params: Promise.resolve({ id: parts[3] }) };
  if (parts[2] === 'projects' && parts[4] === 'repos') {
    if (failLink) { failLink = false; return Response.json({ error: 'Project link unavailable' }, { status: 503 }); }
    return linkRepo(req, context);
  }
  if (parts[2] === 'projects') return init?.method === 'PATCH' ? editProject(req, context) : readProject(req, context);
  throw new Error(`Unexpected request ${url.pathname}`);
}
function Harness() {
  const projects = useProjects(); const [inventory, setInventory] = useState(repos);
  return createElement(ProjectsSwitcher, {
    projects: projects.ledger?.projects ?? [], activeProjectId: projects.ledger?.activeProjectId ?? null,
    selectedRepoPath: null, registeredRepoByPath: new Map(inventory.map((repo) => [repo.localPath, repo])),
    onProjectSelect: (selected) => projects.switchActive(selected.id), onRepoSelect: () => {}, onManageProjects: () => {}, onAddRepo: () => {},
    onRepositoryConnected: async () => { setInventory(await listReposFresh()); },
  });
}
function button(label: string) {
  const scope = document.querySelector('[role="dialog"]') ?? document;
  const node = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label);
  expect(node, `button ${label}`).toBeDefined(); return node!;
}
async function click(label: string) { await act(async () => { button(label).focus(); button(label).click(); }); }
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  expect(check()).toBe(true);
}
async function type(label: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; expect(input).not.toBeNull();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
// #4845: Add repository opens the folder flow directly; GitHub and New sources moved to the Switch project popover.
const SOURCE_ENTRY: Record<string, string> = { 'GitHub repository': 'Connected repositories', 'New repository': 'New repository' };
async function openSource(label: string) {
  await click('Switch project');
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent?.startsWith(SOURCE_ENTRY[label] ?? label))!;
  expect(item).toBeDefined(); await act(async () => item.click());
}
async function savedProject() {
  closeDb(); return (await (await readProject(request(`/api/projects/${project.id}`), { params: Promise.resolve({ id: project.id }) })).json() as { project: ProjectWithRepos }).project;
}

beforeAll(async () => {
  const library = makeRepo('library'); git(['remote', 'add', 'origin', 'git@github.com:fixture/library.git'], library);
  writeFileSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'repos.json'), JSON.stringify({ version: 1, repos: [{ id: 'source-library', name: 'Library', localPath: library, remoteUrl: 'git@github.com:fixture/library.git' }] }));
  repos = await listReposFresh();
  project = (await (await createProject(request('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Sources', repoIds: [repos[0].id], roles: ['backend'] }) }))).json()).project;
  await activate(request('/api/panel/projects/active', { method: 'POST', body: JSON.stringify({ projectId: project.id }) }));
  const served = path.join(fixture.home, 'served'); mkdirSync(served);
  for (const name of ['source', 'another', 'stale', 'missing']) { const folder = makeRepo(name); const bare = path.join(served, `${name}.git`); git(['clone', '--bare', folder, bare], fixture.home); git(['update-server-info'], bare); }
  server = createServer((req, response) => {
    const relative = new URL(req.url!, 'http://localhost').pathname;
    if (relative.includes('..')) { response.writeHead(400).end(); return; }
    try { response.end(readFileSync(path.join(served, relative))); } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  sourceUrl = `http://127.0.0.1:${port}/source.git`; secondUrl = `http://127.0.0.1:${port}/another.git`;
  staleUrl = `http://127.0.0.1:${port}/stale.git`; missingUrl = `http://127.0.0.1:${port}/missing.git`;
});
beforeEach(async () => {
  clonePosts = 0; failLink = false; loseCloneResponse = false; githubAuthenticated = true;
  repos = await listReposFresh(); invalidateFetchOnce('/api/panel/projects');
  vi.stubGlobal('fetch', routedFetch); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
  await until(() => button('Switch project').textContent?.includes('Sources') === true);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); closeDb(); rmSync(fixture.home, { recursive: true, force: true }); });

it('browses GitHub and reuses the connected SSH checkout without cloning or resetting its role', async () => {
  await openSource('GitHub repository'); await until(() => !![...document.querySelectorAll('button')].find((node) => node.textContent?.includes('fixture/library')));
  await click('Choose fixture/library'); await click('Add repository');
  await until(() => !document.querySelector('[role="dialog"]'));
  expect(clonePosts).toBe(0); expect((await listReposFresh()).filter((repo) => repo.id === repos[0].id)).toHaveLength(1);
  expect((await savedProject()).repos.find((link) => link.repoId === repos[0].id)?.role).toBe('backend');
});

it('clones a Git URL to disk and retries a failed project link without another clone', async () => {
  await openSource('Git URL'); await type('Repository URL', sourceUrl); failLink = true;
  await click('Add repository'); await until(() => document.querySelector('[role="alert"]')?.textContent === 'Project link unavailable');
  const clone = (await listReposFresh()).find((repo) => repo.remoteUrl === sourceUrl)!;
  expect(clone).toBeDefined(); expect(readFileSync(path.join(clone.localPath, 'README.md'), 'utf8')).toBe('# source\n');
  expect(existsSync(path.join(clone.localPath, '.git'))).toBe(true); expect((await savedProject()).repos.some((link) => link.repoId === clone.id)).toBe(false);
  await click('Retry connection'); await until(() => !document.querySelector('[role="dialog"]'));
  expect(clonePosts).toBe(1); expect((await savedProject()).repos.find((link) => link.repoId === clone.id)?.role).toBeNull();
});

it('recovers a durable clone whose response was lost without duplicating the checkout', async () => {
  await openSource('Git URL'); await type('Repository URL', secondUrl); loseCloneResponse = true; await click('Add repository');
  await until(() => !document.querySelector('[role="dialog"]'));
  const matches = (await listReposFresh()).filter((repo) => repo.remoteUrl === secondUrl);
  expect(matches).toHaveLength(1); expect(clonePosts).toBe(1); expect((await savedProject()).repos.some((link) => link.repoId === matches[0].id)).toBe(true);
});

it('creates a local Git repository from the source dialog and persists its project membership', async () => {
  await openSource('New repository'); const folder = path.join(fixture.home, 'new-app'); await type('New repository folder', folder); await click('Create repository');
  await until(() => !document.querySelector('[role="dialog"]'));
  const created = (await listReposFresh()).find((repo) => repo.localPath === folder)!;
  expect(created).toBeDefined(); expect(existsSync(path.join(folder, '.git'))).toBe(true);
  expect(git(['rev-parse', '--verify', 'HEAD'], folder)).toMatch(/^[a-f0-9]{40}$/);
  expect((await savedProject()).repos.some((link) => link.repoId === created.id)).toBe(true);
});

it('rejects malformed addresses before any clone and offers the real connections settings when GitHub is disconnected', async () => {
  githubAuthenticated = false; const settings = vi.fn(); window.addEventListener(OPEN_SETTINGS_TAB_EVENT, settings);
  await openSource('GitHub repository'); await until(() => document.querySelector('[role="dialog"]')?.textContent?.includes('Connect GitHub to browse') === true);
  await type('Repository URL', 'https://gitlab.com/team/app'); await click('Add repository');
  await until(() => document.querySelector('[role="alert"]')?.textContent?.includes('GitHub repository URL') === true);
  expect(clonePosts).toBe(0); await click('GitHub connections');
  expect(settings).toHaveBeenCalledOnce(); expect((settings.mock.calls[0][0] as CustomEvent).detail.tab).toBe('git-prs');
  window.removeEventListener(OPEN_SETTINGS_TAB_EVENT, settings);
});

it('refuses a clone destination occupied by another repository and leaves its files and origin intact', async () => {
  const conflict = path.join(fixture.home, 'Developer', 'collision'); mkdirSync(conflict, { recursive: true });
  git(['init', '--initial-branch=main'], conflict); git(['remote', 'add', 'origin', sourceUrl], conflict); writeFileSync(path.join(conflict, 'keep.txt'), 'existing work');
  const response = await editRegistry(request('/api/panel/repos', { method: 'POST', body: JSON.stringify({ action: 'clone', cloneUrl: secondUrl, name: 'collision' }) }));
  expect(response.status).toBe(409); expect((await response.json()).error).toContain('different repository');
  expect(readFileSync(path.join(conflict, 'keep.txt'), 'utf8')).toBe('existing work'); expect(git(['remote', 'get-url', 'origin'], conflict)).toBe(sourceUrl);
  expect((await listReposFresh()).some((repo) => repo.localPath === conflict)).toBe(false);
});

it.each(['changed', 'missing'])('verifies the actual checkout before reusing a %s registry entry', async (kind) => {
  const folder = kind === 'changed' ? makeRepo('changed-checkout') : path.join(fixture.home, 'missing-checkout');
  const remote = kind === 'changed' ? staleUrl : missingUrl;
  if (kind === 'changed') git(['remote', 'add', 'origin', sourceUrl], folder);
  const before = await listReposFresh();
  writeFileSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'repos.json'), JSON.stringify({ version: 1, repos: [...before, { id: `stale-${kind}`, name: kind, localPath: folder, remoteUrl: remote }] }));
  await listReposFresh();
  await openSource('Git URL'); await type('Repository URL', remote); await click('Add repository');
  await until(() => document.querySelector('[role="alert"]')?.textContent?.includes('Local folder') === true);
  expect(clonePosts).toBe(0); expect((await savedProject()).repos.some((link) => link.repoId === `stale-${kind}`)).toBe(false);
  expect(existsSync(path.join(fixture.home, 'Developer', kind === 'changed' ? 'stale' : 'missing'))).toBe(false);
});

it('rejects a new repository nested inside a checkout before creating a folder or linking its parent', async () => {
  const library = repos.find((repo) => repo.id === 'source-library')!;
  await openSource('New repository'); const nested = path.join(library.localPath, 'new-child'); await type('New repository folder', nested); await click('Create repository');
  await until(() => document.querySelector('[role="alert"]')?.textContent?.includes('outside an existing repository') === true);
  expect(existsSync(nested)).toBe(false); expect(readFileSync(path.join(library.localPath, 'README.md'), 'utf8')).toBe('# library\n');
  expect((await listReposFresh()).some((repo) => repo.localPath === nested)).toBe(false);
});

it('does not conflate account-relative SSH repositories on a custom host', async () => {
  const folder = path.join(fixture.home, 'Developer', 'account-repo'); mkdirSync(folder, { recursive: true });
  git(['init', '--initial-branch=main'], folder); git(['remote', 'add', 'origin', 'alice@custom-host:project.git'], folder);
  const response = await editRegistry(request('/api/panel/repos', { method: 'POST', body: JSON.stringify({ action: 'clone', cloneUrl: 'bob@custom-host:project.git', name: 'account-repo' }) }));
  expect(response.status).toBe(409); expect(git(['remote', 'get-url', 'origin'], folder)).toBe('alice@custom-host:project.git');
});
