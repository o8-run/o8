// @vitest-environment jsdom

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { act, createElement, Fragment, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ProjectsSwitcher } from '@/components/desktop/agent-panel/ProjectsSwitcher';
import { AddRepoFlowHost } from '@/components/desktop/repo-registry/AddRepoFlowHost';
import { useProjects } from '@/components/desktop/repo-registry/useProjects';
import { GET as readLedger } from '@/app/api/panel/projects/route';
import { PATCH as editLedgerProject } from '@/app/api/panel/projects/[id]/route';
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
let clonePosts: number;
let failLink: number;
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
  if (url.pathname.startsWith('/api/panel/projects/')) {
    if (failLink > 0) { failLink -= 1; return Response.json({ error: 'Project link unavailable' }, { status: 503 }); }
    return editLedgerProject(req, { params: Promise.resolve({ id: decodeURIComponent(url.pathname.split('/')[4]) }) });
  }
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
    if (failLink > 0) { failLink -= 1; return Response.json({ error: 'Project link unavailable' }, { status: 503 }); }
    return linkRepo(req, context);
  }
  if (parts[2] === 'projects') return init?.method === 'PATCH' ? editProject(req, context) : readProject(req, context);
  throw new Error(`Unexpected request ${url.pathname}`);
}
function Harness() {
  const projects = useProjects(); const [inventory, setInventory] = useState(repos);
  const refresh = async () => { setInventory(await listReposFresh()); };
  // Add repository opens the dashboard's add flow the way AgentPanel does (#4845).
  const addRepo = (localPath?: string) => { window.dispatchEvent(new CustomEvent('o8:open-add-repo-flow', { detail: { localPath } })); };
  return createElement(Fragment, null, createElement(ProjectsSwitcher, {
    projects: projects.ledger?.projects ?? [], activeProjectId: projects.ledger?.activeProjectId ?? null,
    selectedRepoPath: null, registeredRepoByPath: new Map(inventory.map((repo) => [repo.localPath, repo])),
    onProjectSelect: (selected) => projects.switchActive(selected.id), onRepoSelect: () => {}, onManageProjects: () => {}, onAddRepo: addRepo,
    onRepositoryConnected: refresh,
  }), createElement(AddRepoFlowHost, { onRepoAdded: refresh }));
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
// #4845: the Connected repositories and New repository sources live in the Switch project popover.
async function openSource(entry: 'Connected repositories' | 'New repository') {
  await click('Switch project');
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent?.trim() === entry);
  expect(item, entry).toBeDefined(); await act(async () => item!.click());
}
// #4845 removed the Git URL source; a Git URL pasted on Add repository opens the add flow with it.
async function pasteGitUrl(value: string) {
  const paste = Object.assign(new Event('paste', { bubbles: true, cancelable: true }), { clipboardData: { getData: (type: string) => type === 'text/plain' ? value : '' } });
  await act(async () => { button('Add repository').dispatchEvent(paste); });
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
  for (const name of ['source', 'another']) { const folder = makeRepo(name); const bare = path.join(served, `${name}.git`); git(['clone', '--bare', folder, bare], fixture.home); git(['update-server-info'], bare); }
  server = createServer((req, response) => {
    const relative = new URL(req.url!, 'http://localhost').pathname;
    if (relative.includes('..')) { response.writeHead(400).end(); return; }
    try { response.end(readFileSync(path.join(served, relative))); } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  sourceUrl = `http://127.0.0.1:${port}/source.git`; secondUrl = `http://127.0.0.1:${port}/another.git`;
});
beforeEach(async () => {
  clonePosts = 0; failLink = 0; loseCloneResponse = false; githubAuthenticated = true;
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
  await openSource('Connected repositories'); await until(() => !![...document.querySelectorAll('button')].find((node) => node.textContent?.includes('fixture/library')));
  await click('Choose fixture/library'); await click('Add repository');
  await until(() => !document.querySelector('[role="dialog"]'));
  expect(clonePosts).toBe(0); expect((await listReposFresh()).filter((repo) => repo.id === repos[0].id)).toHaveLength(1);
  expect((await savedProject()).repos.find((link) => link.repoId === repos[0].id)?.role).toBe('backend');
});

it('clones a Git URL to disk and retries a failed project link without another clone', async () => {
  // The add flow retries a failed link once by itself before it offers Retry (#4845).
  failLink = 2; await pasteGitUrl(sourceUrl);
  await until(() => [...document.querySelectorAll('[role="dialog"] [role="status"]')].some((node) => node.textContent === 'Cloned. Link pending.'));
  expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
  const clone = (await listReposFresh()).find((repo) => repo.remoteUrl === sourceUrl)!;
  expect(clone).toBeDefined(); expect(readFileSync(path.join(clone.localPath, 'README.md'), 'utf8')).toBe('# source\n');
  expect(existsSync(path.join(clone.localPath, '.git'))).toBe(true); expect((await savedProject()).repos.some((link) => link.repoId === clone.id)).toBe(false);
  await click('Retry'); await until(() => !document.querySelector('[role="dialog"]'));
  expect(clonePosts).toBe(1); expect((await savedProject()).repos.find((link) => link.repoId === clone.id)?.role).toBeNull();
});

it('recovers a durable clone whose response was lost without duplicating the checkout', async () => {
  // GitHub is unreachable from the fixture, so the checkout the clone writes is already at its destination; the clone route reuses and registers it.
  const remote = 'https://github.com/fixture/another.git'; const checkout = path.join(fixture.home, 'Developer', 'another');
  git(['clone', path.join(fixture.home, 'served', 'another.git'), checkout], fixture.home); git(['remote', 'set-url', 'origin', remote], checkout);
  await openSource('Connected repositories'); await type('Repository URL', remote); loseCloneResponse = true; await click('Add repository');
  await until(() => !document.querySelector('[role="dialog"]'));
  const matches = (await listReposFresh()).filter((repo) => repo.remoteUrl === remote);
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
  await openSource('Connected repositories'); await until(() => document.querySelector('[role="dialog"]')?.textContent?.includes('Connect GitHub to browse') === true);
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
  // Registry reads adopt a checkout's actual origin (#4754), so a changed entry that reaches the connect
  // flow is a folder that no longer holds a Git checkout. Neither entry's remote is cloned.
  const folder = path.join(fixture.home, `${kind}-checkout`);
  if (kind === 'changed') { mkdirSync(folder); writeFileSync(path.join(folder, 'README.md'), '# replaced\n'); }
  const remote = `https://github.com/fixture/${kind === 'changed' ? 'stale' : 'missing'}.git`;
  const before = await listReposFresh();
  writeFileSync(path.join(process.env.CORTEX_IDE_DATA_DIR!, 'repos.json'), JSON.stringify({ version: 1, repos: [...before, { id: `stale-${kind}`, name: kind, localPath: folder, remoteUrl: remote }] }));
  await listReposFresh();
  await openSource('Connected repositories'); await type('Repository URL', remote); await click('Add repository');
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
