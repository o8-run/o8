// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AddRepoDialog } from './AddRepoDialog';

const cloneUrl = 'https://example.org/team/project.git';
const repo = { id: 'repo-1', name: 'Project', localPath: '/projects/project', remoteUrl: cloneUrl, defaultBranch: 'main' };
const fetchMock = vi.fn<typeof fetch>();
const onClose = vi.fn();
const onRepoAdded = vi.fn();
const onProjectsChanged = vi.fn();
let root: Root;
let host: HTMLDivElement;
let linkFailures: number;
let cloneCount: number;
let patchCount: number;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  vi.clearAllMocks();
  linkFailures = 0; cloneCount = 0; patchCount = 0;
  localStorage.clear();
  fetchMock.mockImplementation(async (url, init) => {
    if (String(url) === '/api/panel/repos') {
      if (!init?.method) return Response.json({ repos: [] });
      expect(JSON.parse(String(init.body))).toEqual({ action: 'clone', cloneUrl });
      cloneCount += 1;
      return Response.json({ repo });
    }
    if (String(url) === '/api/panel/projects/default' && init?.method === 'PATCH') {
      expect(JSON.parse(String(init.body))).toEqual({ repoPaths: [repo.localPath] });
      patchCount += 1;
      return --linkFailures >= 0
        ? Response.json({ error: 'Project temporarily unavailable' }, { status: 503 })
        : Response.json({ ok: true });
    }
    throw new Error(`Unexpected request: ${String(url)}`);
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

function button(label: string) {
  const control = [...document.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === label);
  expect(control, label).toBeDefined();
  return control!;
}

async function clone() {
  await act(async () => root.render(createElement(AddRepoDialog, {
    open: true, initialMode: 'scratch',
    projects: [{ id: 'default', name: 'Default', repoPaths: [], createdAt: '' }], activeProjectId: 'default',
    onClose, onRepoAdded, onProjectsChanged,
  })));
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('#add-repo-path')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, cloneUrl);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Clone and open').click());
}

it('keeps a successful clone and automatically retries a project-link 503 once', async () => {
  linkFailures = 1;
  await clone();
  expect(cloneCount).toBe(1);
  expect(patchCount).toBe(2);
  expect(onRepoAdded).toHaveBeenCalledExactlyOnceWith(repo);
  expect(onProjectsChanged).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it('shows one pending state and Retry after two link 503s, then retries the link without cloning again', async () => {
  linkFailures = 2;
  await clone();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  const states = document.querySelectorAll('[role="status"]');
  expect(states).toHaveLength(1);
  expect(states[0].textContent).toBe('Cloned. Link pending.');
  expect(document.body.textContent).not.toContain('Could not clone');
  expect(button('Retry').disabled).toBe(false);
  expect(cloneCount).toBe(1);
  expect(patchCount).toBe(2);
  expect(onClose).not.toHaveBeenCalled();
  expect(onRepoAdded).not.toHaveBeenCalled();
  expect(onProjectsChanged).not.toHaveBeenCalled();
  await act(async () => button('Retry').click());
  expect(cloneCount).toBe(1);
  expect(patchCount).toBe(3);
  expect(onRepoAdded).toHaveBeenCalledExactlyOnceWith(repo);
  expect(onProjectsChanged).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

it('does not classify a workspace-refresh error after a successful clone as a clone failure', async () => {
  onRepoAdded.mockRejectedValueOnce(new Error('Refresh unavailable'));
  await clone();
  expect(cloneCount).toBe(1);
  expect(patchCount).toBe(1);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Folder added, but the workspace could not open');
  expect(document.body.textContent).not.toContain('Could not clone');
});
