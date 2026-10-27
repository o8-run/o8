// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { open as pickDirectory } from '@tauri-apps/plugin-dialog';
import { AddRepoDialog } from './AddRepoDialog';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));
const repo = { id: 'repo-1', name: 'Example', localPath: '/projects/example', remoteUrl: null, defaultBranch: 'main' };
const fetchMock = vi.fn<typeof fetch>();
const onRepoAdded = vi.fn();
const onClose = vi.fn();
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  vi.clearAllMocks();
  vi.mocked(pickDirectory).mockResolvedValue(null);
  fetchMock.mockImplementation(async (_url, init) => {
    if (!init?.method) return Response.json({ repos: [] });
    return Response.json({ repo });
  });
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function render() {
  await act(async () => root.render(createElement(StrictMode, null, createElement(AddRepoDialog, {
    open: true, projects: [], activeProjectId: null, onClose, onRepoAdded,
  }))));
}
async function type(value: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('#add-repo-path')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function enter() {
  await act(async () => document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}
function mutations() { return fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST'); }

it('opens the system picker once and registers the selection without a confirmation or scan', async () => {
  vi.mocked(pickDirectory).mockResolvedValue(repo.localPath);
  await render();
  expect(pickDirectory).toHaveBeenCalledOnce();
  expect(mutations().map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ action: 'add', localPath: repo.localPath }]);
  expect(onRepoAdded).toHaveBeenCalledExactlyOnceWith(repo);
  expect(onClose).toHaveBeenCalledOnce();
});
it('cancels the picker without writing and keeps URL paste available', async () => {
  await render();
  expect(pickDirectory).toHaveBeenCalledOnce();
  expect(mutations()).toHaveLength(0);
  await type('https://example.org/team/example.git');
  await enter();
  expect(mutations().map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ action: 'clone', cloneUrl: 'https://example.org/team/example.git' }]);
  expect(onRepoAdded).toHaveBeenCalledExactlyOnceWith(repo);
});
it('reopens a recent registered folder once and records the successful open', async () => {
  fetchMock.mockImplementation(async (_url, init) => Response.json(init?.method ? { repo } : { repos: [repo] }));
  await render();
  const recent = [...document.querySelectorAll('button')].find(button => button.textContent?.includes(repo.name));
  expect(recent).toBeDefined();
  await act(async () => { recent!.click(); recent!.click(); });
  expect(mutations()).toHaveLength(1);
  expect(onRepoAdded).toHaveBeenCalledOnce();
  expect(localStorage.getItem('o8:recent-repo-folders')).toContain(repo.localPath);
});
it('preserves the input and gives a recovery action after an add error', async () => {
  fetchMock.mockImplementation(async (_url, init) => init?.method
    ? Response.json({ error: 'Folder not found. Choose an existing folder.' }, { status: 400 })
    : Response.json({ repos: [] }));
  await render();
  await type(repo.localPath);
  await enter();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Choose an existing folder');
  expect(document.querySelector<HTMLInputElement>('#add-repo-path')?.value).toBe(repo.localPath);
  expect(onClose).not.toHaveBeenCalled();
  fetchMock.mockImplementation(async () => Response.json({ repo }));
  await enter();
  expect(onRepoAdded).toHaveBeenCalledOnce();
});

it('opens a dropped folder through the same registration path', async () => {
  await render();
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: {
    files: [], getData: (type: string) => type === 'text/uri-list' ? 'file:///projects/example' : '',
  } });
  await act(async () => document.querySelector('form')!.dispatchEvent(drop));
  expect(mutations().map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ action: 'add', localPath: repo.localPath }]);
  expect(onRepoAdded).toHaveBeenCalledExactlyOnceWith(repo);
});

it('explains a browser drop without a path and leaves manual entry available', async () => {
  await render();
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [new File([], 'example')], getData: () => '' } });
  await act(async () => document.querySelector('form')!.dispatchEvent(drop));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Choose a folder or paste its full path');
  expect(mutations()).toHaveLength(0);
});

it('ignores a late picker result after cancellation', async () => {
  let finish!: (path: string) => void;
  vi.mocked(pickDirectory).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await render();
  await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!.click());
  await act(async () => finish(repo.localPath));
  expect(mutations()).toHaveLength(0);
  expect(onRepoAdded).not.toHaveBeenCalled();
});

it('does not reopen a stale registered path when the server rejects it', async () => {
  fetchMock.mockImplementation(async (_url, init) => init?.method
    ? Response.json({ error: 'Folder not found. Choose an existing folder.' }, { status: 400 })
    : Response.json({ repos: [repo] }));
  await render();
  await type(repo.localPath);
  expect(document.querySelector('[role="status"]')).toBeNull();
  await enter();
  expect(onRepoAdded).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Folder not found');
});

it('uses the Open action without a helper when a registered path is pasted', async () => {
  fetchMock.mockImplementation(async (_url, init) => Response.json(init?.method ? { repo } : { repos: [repo] }));
  await render();
  await type(repo.localPath);
  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(document.body.textContent).not.toContain(`Open ${repo.name}.`);
  const open = [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Open');
  expect(open?.disabled).toBe(false);
  await act(async () => open!.click());
  expect(mutations().map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ action: 'add', localPath: repo.localPath }]);
  expect(onRepoAdded).toHaveBeenCalledExactlyOnceWith(repo);
});

it.each([200, 503])('explains an unavailable system picker without opening a second prompt (HTTP %s)', async status => {
  vi.mocked(pickDirectory).mockRejectedValueOnce(new Error('Native picker unavailable'));
  fetchMock.mockImplementation(async url => String(url).endsWith('browse-folder')
    ? Response.json({ path: null, unavailable: true, error: 'Folder picker unavailable' }, { status })
    : Response.json({ repos: [] }));
  await render();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Paste a folder path or Git URL');
  expect(document.querySelector('#add-repo-path')).not.toBeNull();
  expect(mutations()).toHaveLength(1); // Only the picker request; no registration.
  expect(onRepoAdded).not.toHaveBeenCalled();
});
