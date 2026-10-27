// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AddRepoDialog } from './AddRepoDialog';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it('recovers a registered repo after a lost response and retries only the failed project link', async () => {
  const localPath = '/tmp/o8-repo-add-recovery';
  const repo = { id: 'repo-1', name: 'Recovery', localPath, remoteUrl: null, defaultBranch: 'main' };
  let linkAttempts = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : null;
    if (url === '/api/panel/repos' && body?.action === 'validate') {
      return Response.json({ repo: { ...repo, isGitRepo: true, setup: {} } });
    }
    if (url === '/api/panel/repos' && body?.action === 'add') {
      throw new TypeError('Response lost after registration');
    }
    if (url === '/api/panel/repos' && !init?.method) {
      return Response.json({ repos: [repo] });
    }
    if (url === '/api/panel/projects/default' && init?.method === 'PATCH') {
      linkAttempts += 1;
      if (linkAttempts === 1) return Response.json({ error: 'Project temporarily unavailable' }, { status: 503 });
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const onClose = vi.fn();
  const onRepoAdded = vi.fn();
  const onProjectsChanged = vi.fn();

  await act(async () => {
    root.render(createElement(AddRepoDialog, {
      open: true, initialMode: 'scratch',
      projects: [{ id: 'default', name: 'Default', repoPaths: [], createdAt: '' }],
      activeProjectId: 'default',
      onClose,
      onRepoAdded,
      onProjectsChanged,
    }));
  });
  const input = document.querySelector<HTMLInputElement>('#add-repo-path');
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, localPath);
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'Open')?.click();
  });

  expect(document.body.textContent).toContain('Folder added, but the project could not be updated');
  expect(document.body.textContent).toContain('Try again to finish opening it');
  expect(onRepoAdded).not.toHaveBeenCalled();

  await act(async () => {
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'Open')?.click();
  });

  expect(fetchMock.mock.calls.filter(([url, init]) => (
    String(url) === '/api/panel/repos'
    && init?.body
    && JSON.parse(String(init.body)).action === 'add'
  ))).toHaveLength(1);
  expect(linkAttempts).toBe(2);
  expect(onProjectsChanged).toHaveBeenCalledOnce();
  expect(onRepoAdded).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});
