// @vitest-environment jsdom

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { act, createElement, useState, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { ProjectsSwitcher } from '@/components/desktop/agent-panel/ProjectsSwitcher';
import { broadcastProjectsUpdated, useProjects } from '@/components/desktop/repo-registry/useProjects';
import { GET as readLedger } from '@/app/api/panel/projects/route';
import { POST as activate } from '@/app/api/panel/projects/active/route';
import { GET as listProjects, POST as createProject } from '@/app/api/projects/route';
import { DELETE as deleteProject, GET as readProject, PATCH as editProject } from '@/app/api/projects/[id]/route';
import { POST as linkRepo } from '@/app/api/projects/[id]/repos/route';
import { DELETE as unlinkRepo } from '@/app/api/projects/[id]/repos/[repoId]/route';
import { listReposFresh } from '@/lib/repos/registry';
import { closeDb } from '@/lib/db';
import { invalidateFetchOnce } from '@/lib/panel/fetch-cache';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { ProjectWithRepos } from '@/lib/projects/types';

// Layout adapters only. Project UI, hooks, authenticated routes, registry,
// ledger and SQLite remain real; no provider or background dispatch is involved.
vi.mock('@/lib/theme/context', () => ({ useTheme: () => ({ workspaceGlass: true, surface: 'glass', paletteId: 'dark' }) }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: { children: ReactNode; style: unknown }) => createElement('div', { style: style as HTMLAttributes<HTMLDivElement>['style'] }, children) }));
vi.mock('framer-motion', () => ({
  useReducedMotion: () => true,
  motion: { div: ({ children, initial: _initial, animate: _animate, transition: _transition, ...props }: HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown; transition?: unknown }) => createElement('div', props, children) },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const dataDir = process.env.CORTEX_IDE_DATA_DIR!;
const fixture = realpathSync(mkdtempSync(path.join(tmpdir(), 'o8-project-picker-')));
let repos: RepoRegistryEntry[];
let root: Root;
let container: HTMLDivElement;
let failActivation: boolean;
let loseCreateResponse: boolean;
let creates: number;
let addRepo: ReturnType<typeof vi.fn<() => void>>;

async function routedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), 'http://localhost');
  const request = new NextRequest(url, { method: init?.method, body: init?.body, headers: { ...Object.fromEntries(new Headers(init?.headers)), host: 'localhost' } });
  if (url.pathname === '/api/panel/projects') return readLedger();
  if (url.pathname === '/api/panel/projects/active') {
    if (failActivation) { failActivation = false; return Response.json({ error: 'Unavailable' }, { status: 503 }); }
    return activate(request);
  }
  if (url.pathname === '/api/projects') {
    if (init?.method !== 'POST') return listProjects(request);
    creates += 1;
    const response = await createProject(request);
    if (loseCreateResponse) { loseCreateResponse = false; throw new Error('Response lost after durable create'); }
    return response;
  }
  const parts = url.pathname.split('/');
  const context = { params: Promise.resolve({ id: parts[3], repoId: parts[5] }) };
  if (parts[2] === 'projects' && parts[4] === 'repos') return init?.method === 'DELETE' ? unlinkRepo(request, context) : linkRepo(request, context);
  if (parts[2] === 'projects') return init?.method === 'PATCH' ? editProject(request, context) : readProject(request, context);
  throw new Error(`Unexpected request ${url.pathname}`);
}

function Harness() {
  const projects = useProjects();
  const [repoPath, setRepoPath] = useState<string | null>(null);
  return createElement(ProjectsSwitcher, {
    projects: projects.ledger?.projects ?? [], activeProjectId: projects.ledger?.activeProjectId ?? null,
    selectedRepoPath: repoPath, registeredRepoByPath: new Map(repos.map((repo) => [repo.localPath, repo])),
    onProjectSelect: (project) => projects.switchActive(project.id),
    onRepoSelect: (_project, value) => { setRepoPath(value); },
    onManageProjects: () => {}, onAddRepo: addRepo,
  });
}
function button(label: string) {
  const node = [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label);
  expect(node, `button ${label}`).toBeDefined(); return node!;
}
async function click(label: string) { await act(async () => { button(label).focus(); button(label).click(); }); }
async function type(label: string, text: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  expect(input).not.toBeNull();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function until(check: () => boolean) {
  for (let i = 0; i < 80 && !check(); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  expect(check()).toBe(true);
}
async function saved(name: string) {
  const { projects } = await (await listProjects(new NextRequest('http://localhost/api/projects', { headers: { host: 'localhost' } }))).json() as { projects: ProjectWithRepos[] };
  return projects.filter((project) => project.name === name);
}
async function newGroup(name: string) {
  await click('Switch project'); await click('New project'); await type('Project name', name);
  await click(repos[0].name); await click(repos[1].name);
}

beforeAll(async () => {
  const entries = ['App', 'Site', 'Security'].map((name, index) => ({ id: `picker-repo-${index}`, name, localPath: path.join(fixture, name), remoteUrl: null }));
  for (const entry of entries) { mkdirSync(entry.localPath); writeFileSync(path.join(entry.localPath, 'README.md'), `# ${entry.name}\n`); }
  writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({ version: 1, repos: entries }));
  repos = await listReposFresh();
});
beforeEach(async () => {
  failActivation = false; loseCreateResponse = false; creates = 0; addRepo = vi.fn();
  invalidateFetchOnce('/api/panel/projects');
  vi.stubGlobal('fetch', routedFetch);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(createElement(Harness)));
  await until(() => button('Switch project').textContent !== 'Projects');
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
afterAll(() => { closeDb(); rmSync(fixture, { recursive: true, force: true }); });

it('creates and activates a two-repo group, reloads it, searches it and opens either repo', async () => {
  await newGroup('Product'); await click('Create project');
  await until(() => !document.querySelector('[role="dialog"]') && button('Switch project').textContent?.includes('Product') === true);
  closeDb(); // A fresh DB read and fresh UI must observe the saved group.
  const [project] = await saved('Product');
  expect(project.repos.map((link) => link.repoId)).toEqual([repos[0].id, repos[1].id]);
  expect(project.repos.every((link) => link.role === null)).toBe(true);
  expect(JSON.parse(readFileSync(path.join(dataDir, 'projects.json'), 'utf8')).activeProjectId).toBe(project.id);
  await act(async () => { root.render(createElement(Harness, { key: 'reloaded' })); });
  await until(() => button('Switch project').textContent?.includes('Product') === true);
  // The unmeasured layout keeps one chip visible and discloses the rest.
  expect(document.querySelector('button[aria-label="Open Site repository"]')).toBeNull();
  await click('1 more repositories');
  await click('Open Site repository');
  expect(button('Open Site repository').getAttribute('aria-pressed')).toBe('true');
  await click('Switch project'); await type('Search projects', 'site');
  expect(document.querySelector('[data-project-choice]')?.textContent).toContain('Product');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Search projects');
  await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
  expect(document.activeElement).toBe(button('Switch project'));
});

it('retains a created group across activation failure and retries without a second create', async () => {
  await newGroup('Retry activation'); failActivation = true; await click('Create project');
  await until(() => document.querySelector('[role="alert"]')?.textContent?.includes('Project saved') === true);
  expect(creates).toBe(1); await click('Open project');
  await until(() => !document.querySelector('[role="dialog"]'));
  expect(creates).toBe(1); expect(await saved('Retry activation')).toHaveLength(1);
});

it('refreshes externally created projects when the drawer opens', async () => {
  const name = 'Connected externally';
  const response = await createProject(new NextRequest('http://localhost/api/projects', {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ name, repoIds: [repos[2].id] }),
  }));
  expect(response.status).toBe(201);
  await click('Switch project');
  await until(() => [...document.querySelectorAll('[data-project-choice]')].some((entry) => entry.textContent?.includes(name)));
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Search projects');
});

it('reconciles a lost create response instead of saving a duplicate group', async () => {
  await newGroup('Lost response'); loseCreateResponse = true; await click('Create project');
  await until(() => !document.querySelector('[role="dialog"]'));
  expect(creates).toBe(1); expect(await saved('Lost response')).toHaveLength(1);
});

it('keeps a deleted organize target unavailable and reserves creation for explicit New project', async () => {
  await newGroup('Deleted while organizing'); await click('Create project');
  await until(() => !document.querySelector('[role="dialog"]'));
  const [project] = await saved('Deleted while organizing');
  const keeper = await createProject(new NextRequest('http://localhost/api/projects', {
    method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ name: 'Keep deleted dialog repos', repoIds: [repos[0].id, repos[1].id] }),
  }));
  expect(keeper.status).toBe(201);
  await click('Switch project'); await click('Organize Deleted while organizing');
  const createsBeforeDelete = creates;
  await act(async () => {
    const response = await deleteProject(new NextRequest(`http://localhost/api/projects/${project.id}`, {
      method: 'DELETE', headers: { host: 'localhost' },
    }), { params: Promise.resolve({ id: project.id }) });
    expect(response.status).toBe(200);
    broadcastProjectsUpdated();
  });
  await until(() => !button('Switch project').textContent?.includes(project.name));
  await act(async () => { document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  expect(creates).toBe(createsBeforeDelete); expect(await saved(project.name)).toHaveLength(0);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('no longer available');
  expect(button('Save').disabled).toBe(true);
  await click('Save'); expect(creates).toBe(createsBeforeDelete);
  await click('Cancel');
  await newGroup('Explicit replacement'); await click('Create project');
  await until(() => !document.querySelector('[role="dialog"]'));
  expect(creates).toBe(createsBeforeDelete + 1); expect(await saved('Explicit replacement')).toHaveLength(1);
});

it('saves the named grouping before opening repository sources so an unfinished draft is retained', async () => {
  await newGroup('More repositories'); await click('Create & add repo');
  // #4845: the add entry opens the add-repository flow directly, once the grouping is saved.
  await until(() => addRepo.mock.calls.length > 0);
  expect(await saved('More repositories')).toHaveLength(1);
  expect(button('Switch project').textContent).toContain('More repositories');
  expect(addRepo).toHaveBeenCalledTimes(1);
});

it('removes only a membership and preserves the connected repo, files and another project', async () => {
  await newGroup('Remove membership'); await click('Create project');
  await until(() => !document.querySelector('[role="dialog"]'));
  const [project] = await saved('Remove membership');
  const other = await createProject(new NextRequest('http://localhost/api/projects', { method: 'POST', headers: { host: 'localhost' }, body: JSON.stringify({ name: 'Keep membership', repoIds: [repos[1].id], roles: ['site'] }) }));
  expect(other.status).toBe(201);
  await click('Switch project'); await click('Organize Remove membership'); await click('Remove Site from project');
  await until(() => button('Site').getAttribute('aria-checked') === 'false');
  closeDb();
  expect((await saved('Remove membership'))[0].repos.map((link) => link.repoId)).toEqual([repos[0].id]);
  expect((await saved('Keep membership'))[0].repos[0].role).toBe('site');
  expect((await listReposFresh()).map((repo) => repo.id)).toContain(repos[1].id);
  expect(readFileSync(path.join(repos[1].localPath, 'README.md'), 'utf8')).toBe('# Site\n');
  await click('Site'); await click('Save');
  await until(() => !document.querySelector('[role="dialog"]'));
  expect((await saved(project.name))[0].repos).toHaveLength(2);
});
