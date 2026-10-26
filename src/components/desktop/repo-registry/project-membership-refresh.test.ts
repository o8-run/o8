// @vitest-environment jsdom

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { CustomizePage } from '../CustomizePage';
import { useLeftPanelProjectFocus } from '../repo-focus/useLeftPanelProjectFocus';
import { AddRepoDialog } from './AddRepoDialog';
import { useProjects } from './useProjects';

const repo: RepoRegistryEntry = {
  id: 'repo-fixture', name: 'Fixture repo', localPath: '/fixture/repo',
  remoteUrl: null, defaultBranch: 'main', addedAt: '', lastOpenedAt: null,
  storagePressureParkingDisabled: false,
  setup: { envMode: 'skip', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
    buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null,
    workspaceIsolationPreference: 'auto' },
};
const otherRepo = { ...repo, id: 'other-repo', name: 'Other project repo', localPath: '/fixture/other' };
const registeredRepos = [repo, otherRepo];
let host: HTMLDivElement;
let root: Root;
let members: string[];
let linkFailures: number;
let holdNextRead: boolean;
let releaseOldRead: (() => void) | undefined;
let registrations: number;

function SidebarAdd() {
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  return createElement('div', null,
    createElement('button', { onClick: () => setOpen(true) }, 'Add repository'),
    createElement(AddRepoDialog, {
      open, initialMode: 'scratch', onClose: () => setOpen(false), projects: projects.ledger?.projects ?? [],
      activeProjectId: 'workspace', onProjectsChanged: projects.refresh,
    }),
  );
}

function DashboardCustomize() {
  const projects = useProjects();
  const focus = useLeftPanelProjectFocus({ registeredRepos, ledger: projects.ledger });
  return createElement('div', null,
    createElement('button', { onClick: () => { void projects.refresh(); } }, 'Refresh project context'),
    createElement(CustomizePage, { project: focus.view?.project ?? projects.activeProject, registeredRepos }),
  );
}

function button(text: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === text);
  expect(result, text).toBeDefined();
  return result!;
}

async function settle(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assertion();
  });
}

async function mount() {
  await act(async () => root.render(createElement('div', null,
    createElement(SidebarAdd), createElement(DashboardCustomize))));
  await settle(() => expect(host.textContent).toContain('Workspace · 0 repositories'));
  await act(async () => button('Plugins').click());
  await settle(() => expect(host.querySelector<HTMLButtonElement>('[aria-label="Choose action repository"]')?.disabled).toBe(true));
}

async function addRepository() {
  await act(async () => button('Add repository').click());
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('#add-repo-path')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, repo.localPath);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Open').click());
}

async function expectRepositoryAvailable() {
  await settle(() => {
    expect(host.textContent).toContain('Workspace · 1 repository');
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Choose action repository"]')?.disabled).toBe(false);
  });
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Choose action repository"]')!.click());
  expect(host.querySelector('[id][aria-label="Action repository choices"]')?.textContent).toContain('Fixture repo');
  expect(host.querySelector('[aria-label="Action repository choices"]')?.textContent).not.toContain('Other project repo');
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.startsWith('Fixture repo'))!.click());
  expect(host.textContent).toContain('Selected repository: /fixture/repo');
}

beforeEach(async () => {
  // Let the preceding test's settled fetchOnce dedup tail expire.
  await new Promise((resolve) => setTimeout(resolve, 160));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  members = []; linkFailures = 0; registrations = 0; holdNextRead = false; releaseOldRead = undefined;
  window.localStorage.setItem('o8:left-panel:focused-project', 'workspace');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost');
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url.pathname === '/api/panel/projects') {
      const snapshot = Response.json({ activeProjectId: 'workspace', projects: [
        { id: 'workspace', name: 'Workspace', repoPaths: [...members], createdAt: '' },
        { id: 'other', name: 'Other', repoPaths: [otherRepo.localPath], createdAt: '' },
      ] });
      if (holdNextRead) {
        holdNextRead = false;
        return new Promise((resolve) => { releaseOldRead = () => resolve(snapshot); });
      }
      return snapshot;
    }
    if (url.pathname === '/api/panel/repos' && body.action === 'validate') return Response.json({ repo: { ...repo, isGitRepo: true } });
    if (url.pathname === '/api/panel/repos' && body.action === 'add') { registrations += 1; return Response.json({ repo }); }
    if (url.pathname === '/api/panel/projects/workspace' && init?.method === 'PATCH') {
      if (linkFailures-- > 0) return Response.json({ error: 'Temporary link failure' }, { status: 503 });
      members = [repo.localPath];
      return Response.json({ ok: true });
    }
    if (url.pathname === '/api/projects') return Response.json({ projects: [{ id: 'workspace', name: 'Workspace' }] });
    if (url.pathname === '/api/projects/workspace/repos') {
      expect(body.repoId).toBe(repo.id); members = [repo.localPath]; return Response.json({ ok: true });
    }
    if (url.pathname === '/api/customize/actions') return Response.json({ installed: [], damaged: [], receipts: [] });
    if (url.pathname === '/api/customize/inventory') return Response.json({ ok: true, agents: [], hooks: [], skills: [] });
    if (url.pathname === '/api/cortex/directives') return Response.json({ directives: [] });
    if (url.pathname === '/api/setup/mcp-servers') return Response.json({ servers: [] });
    if (url.pathname === '/api/projects/context') return Response.json({ context: { id: 'workspace', runtimeProjectId: 'workspace', settingsProjectId: 'workspace', instructions: '' } });
    return Response.json({}, { status: 404 });
  }));
});

afterEach(async () => {
  await act(async () => { releaseOldRead?.(); });
  act(() => root.unmount()); host.remove(); window.localStorage.clear(); vi.unstubAllGlobals();
});

it('refreshes the retained Customize picker after retrying a failed repository link', async () => {
  linkFailures = 1;
  await mount();
  await addRepository();
  expect(document.body.textContent).toContain('Try again to finish opening it');
  expect(host.textContent).toContain('Workspace · 0 repositories');
  await act(async () => button('Open').click());
  await expectRepositoryAvailable();
  expect(registrations).toBe(1);
});

it('does not reuse or apply a pre-add project read after membership changes', async () => {
  await mount();
  // Start a real new project read after the initial response's dedup tail.
  await new Promise((resolve) => setTimeout(resolve, 160));
  holdNextRead = true;
  await act(async () => button('Refresh project context').click());
  expect(releaseOldRead).toBeTypeOf('function');
  await addRepository();
  await expectRepositoryAvailable();
  await act(async () => { releaseOldRead!(); });
  expect(host.textContent).toContain('Workspace · 1 repository');
  expect(host.textContent).toContain('Selected repository: /fixture/repo');
});
