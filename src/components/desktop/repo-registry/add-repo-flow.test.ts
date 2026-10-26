// @vitest-environment jsdom

import { act, createElement, Fragment, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentPanel } from '../AgentPanel';
import { AddRepoFlowHost } from './AddRepoFlowHost';
import { open as pickDirectory } from '@tauri-apps/plugin-dialog';
import { FOCUS_REPO_WORKSPACE_TAB_EVENT, REQUEST_ADD_REPO_EVENT } from '@/lib/desktop/events';
import type { OrchestratorWorkspaceTarget } from '@/lib/orchestrator/types';
import { ComposerContextRow } from '../thoughts/chat-panel/ComposerContextRow';

vi.mock('../hooks/DesktopWebSocketContext', () => ({ useSharedDesktopWs: () => ({ isConnected: false }) }));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => false, canUseTauriEvents: () => false }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }));
vi.mock('@/lib/panel/fetch-cache', () => ({
  fetchOnce: (url: string) => fetch(url),
  getSWR: () => ({ data: null }),
  setSWR: vi.fn(),
  invalidateFetchOnce: vi.fn(),
}));
vi.mock('../AgentPanelExtraAgents', () => ({ AgentPanelExtraAgents: () => null }));
vi.mock('../workspace-terminal/workspace-boot-loader-claim', () => ({ WorkspaceBootLoaderClaim: () => null }));
vi.mock('../ConnectionPill', () => ({ ConnectionPill: () => null }));
vi.mock('../UpdateCard', () => ({ UpdateCard: () => null }));
vi.mock('../FixedReportCard', () => ({ FixedReportCard: () => null }));
vi.mock('../account-block/AccountBlock', () => ({ AccountBlock: () => null }));
vi.mock('../repo-focus/LeftPanelProjectFocus', () => ({ LeftPanelProjectFocus: () => null }));
vi.mock('../repo-focus/tabs/ChatsTab', () => ({ ChatsTab: () => null }));

let root: Root;
let container: HTMLDivElement;
const project = { id: 'default', name: 'Default', repoPaths: [], createdAt: '' };
const repo = { id: 'repo-1', name: 'Example', localPath: '/tmp/o8-add-flow-example', remoteUrl: null, defaultBranch: 'main' };
const onRepoAdded = vi.fn();
const onSelectRepo = vi.fn();
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : null;
  if (url === '/api/panel/projects') return Response.json({ projects: [project], activeProjectId: 'default' });
  if (url === '/api/runtime/inventory') return Response.json({ agents: [] });
  if (url === '/api/panel/workspaces') return Response.json({ workspaces: [] });
  if (url === '/api/panel/repos' && body?.action === 'validate') return Response.json({ repo: { ...repo, isGitRepo: true, setup: {} } });
  if (url === '/api/panel/repos' && body?.action === 'add') return Response.json({ repo });
  if (url === '/api/panel/repos') return Response.json({ repos: [] });
  if (url === '/api/panel/projects/default' && init?.method === 'PATCH') return Response.json({ ok: true });
  throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${url}`);
});

function Workspace({ sidebar, targets = [] }: { sidebar: 'expanded' | 'collapsed' | 'preview'; targets?: OrchestratorWorkspaceTarget[] }) {
  return createElement(Fragment, null,
    createElement(AddRepoFlowHost, { onRepoAdded, onSelectRepo }),
    sidebar !== 'collapsed' ? createElement('aside', { key: sidebar }, createElement(AgentPanel, { onRepoAdded, onSelectRepo })) : null,
    createElement(ComposerContextRow, {
      selectedRepoPath: '~',
      workspaceTargets: targets,
      onSelectRepoPath: vi.fn(),
      onAddProject: () => window.dispatchEvent(new CustomEvent('o8:open-add-repo-flow', { detail: { mode: 'existing' } })),
    }),
  );
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  vi.mocked(pickDirectory).mockClear();
  onRepoAdded.mockClear();
  onSelectRepo.mockClear();
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function render(sidebar: 'expanded' | 'collapsed' | 'preview', targets: OrchestratorWorkspaceTarget[] = []) {
  await act(async () => root.render(createElement(StrictMode, null, createElement(Workspace, { sidebar, targets }))));
}

function trigger() {
  const element = document.querySelector<HTMLButtonElement>('button[aria-label="Project target"]');
  expect(element).not.toBeNull();
  return element!;
}

function button(text: string) {
  const element = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text);
  expect(element, `button ${text}`).toBeDefined();
  return element!;
}

async function openFromComposer() {
  await act(async () => { trigger().focus(); trigger().click(); });
  await act(async () => button('Add repository…').click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1)));
}

it.each(['expanded', 'collapsed', 'preview'] as const)('opens exactly one repository form from the composer with the sidebar %s', async (sidebar) => {
  await render(sidebar);
  await openFromComposer();
  expect(document.querySelectorAll('#add-repo-path')).toHaveLength(1);
  expect(document.activeElement).toBe(document.querySelector('#add-repo-path'));
  await act(async () => button('Cancel').click());
  expect(document.querySelectorAll('#add-repo-path')).toHaveLength(0);
  expect(document.activeElement).toBe(trigger());
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
});

it('moves keyboard focus into the Project target popup so Add repository is reachable', async () => {
  await render('collapsed');
  await act(async () => { trigger().focus(); trigger().click(); });
  expect(document.activeElement).toBe(button('Add repository…'));
});


it('keeps one live listener pair through sidebar transitions and removes them with the host', async () => {
  const added = vi.spyOn(window, 'addEventListener');
  const removed = vi.spyOn(window, 'removeEventListener');
  const liveListeners = (name: string) => added.mock.calls.filter(([type]) => type === name).length
    - removed.mock.calls.filter(([type]) => type === name).length;
  for (const state of ['collapsed', 'expanded', 'preview', 'collapsed', 'expanded'] as const) {
    await render(state);
    expect(liveListeners('o8:open-add-repo-flow')).toBe(1);
    expect(liveListeners(REQUEST_ADD_REPO_EVENT)).toBe(1);
    await openFromComposer();
    expect(document.querySelectorAll('#add-repo-path')).toHaveLength(1);
    await act(async () => button('Cancel').click());
    expect(document.querySelector('#add-repo-path')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  }
  act(() => root.unmount());
  expect(liveListeners('o8:open-add-repo-flow')).toBe(0);
  expect(liveListeners(REQUEST_ADD_REPO_EVENT)).toBe(0);
  root = createRoot(container);
  await render('collapsed');
  expect(liveListeners('o8:open-add-repo-flow')).toBe(1);
});

it.each(['Enter', ' '] as const)('shares the sidebar + flow with keyboard %s and survives preview-to-sidebar remount', async (key) => {
  await render('preview');
  const plus = document.querySelector<HTMLElement>('[aria-label="Add repository"]')!;
  expect(plus).not.toBeNull();
  await act(async () => {
    plus.focus();
    plus.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  const input = document.querySelector('#add-repo-path');
  expect(input).not.toBeNull();
  await render('expanded');
  expect(document.querySelectorAll('#add-repo-path')).toHaveLength(1);
  expect(document.querySelector('#add-repo-path')).toBe(input);
  await act(async () => button('Cancel').click());
  expect(document.activeElement).toBe(document.querySelector('[aria-label="Add repository"]'));
  expect(pickDirectory).toHaveBeenCalledOnce();
});

it('restores focus to the sidebar + after a mouse open and Cancel', async () => {
  await render('expanded');
  const plus = document.querySelector<HTMLElement>('[aria-label="Add repository"]')!;
  await act(async () => plus.click());
  expect(document.querySelectorAll('#add-repo-path')).toHaveLength(1);
  await act(async () => button('Cancel').click());
  expect(document.activeElement).toBe(plus);
});

it('navigates a populated Project target menu with arrows and returns focus on Escape or Tab', async () => {
  const targets = [{ id: 'repo-1', label: 'Example', repoName: 'Example', localPath: '/tmp/example', branch: 'main' }];
  await render('collapsed', targets);
  await act(async () => {
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  });
  expect(document.activeElement?.getAttribute('role')).toBe('option');
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(button('Add repository…'));
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
  expect(document.activeElement).not.toBe(button('Add repository…'));
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(button('Add repository…'));
  // Native buttons synthesize a click for Enter/Space; exercise its focused target.
  await act(async () => (document.activeElement as HTMLButtonElement).click());
  expect(document.activeElement).toBe(document.querySelector('#add-repo-path'));
  await act(async () => button('Cancel').click());
  expect(document.activeElement).toBe(trigger());
  await act(async () => trigger().click());
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(document.activeElement).toBe(trigger());
  await act(async () => trigger().click());
  await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.querySelector('[role="listbox"]')).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

it('ignores duplicate open requests without resetting the form or duplicating registration and refresh', async () => {
  await render('collapsed');
  await openFromComposer();
  const input = document.querySelector<HTMLInputElement>('#add-repo-path')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, repo.localPath);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    window.dispatchEvent(new CustomEvent('o8:open-add-repo-flow', { detail: { mode: 'existing' } }));
    window.dispatchEvent(new CustomEvent(REQUEST_ADD_REPO_EVENT));
  });
  await render('expanded');
  expect(document.querySelectorAll('#add-repo-path')).toHaveLength(1);
  expect(input.value).toBe(repo.localPath);
  expect(pickDirectory).toHaveBeenCalledOnce();
  const reposChanged = vi.fn();
  window.addEventListener('o8:repos-changed', reposChanged);
  try {
    await act(async () => button('Open').click());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.body && JSON.parse(String(init.body)).action === 'add')).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url) === '/api/panel/projects/default' && init?.method === 'PATCH')).toHaveLength(1);
    expect(onRepoAdded).toHaveBeenCalledExactlyOnceWith(repo);
    expect(onSelectRepo).toHaveBeenCalledExactlyOnceWith(repo.id);
    expect(reposChanged).toHaveBeenCalledOnce();
    expect(document.querySelector('#add-repo-path')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await act(async () => document.querySelector<HTMLElement>('[aria-label="Add repository"]')?.click());
    expect(pickDirectory).toHaveBeenCalledTimes(2); // Every entry point opens the same picker.
    expect(document.querySelector<HTMLInputElement>('#add-repo-path')?.value).toBe('');
  } finally {
    window.removeEventListener('o8:repos-changed', reposChanged);
  }
});

it('waits for the first Project popup to become visible before moving keyboard focus', async () => {
  const focus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    // Browsers reject focus while ComposerPopover's first portal is hidden.
    // jsdom otherwise accepts it and can hide a missing post-placement focus.
    const overlay = this.closest<HTMLElement>('[data-composer-overlay]');
    if (overlay && getComputedStyle(overlay).visibility === 'hidden') return;
    focus.call(this, options);
  });
  await render('collapsed');
  await act(async () => {
    trigger().focus();
    trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  });
  expect(getComputedStyle(document.querySelector('[data-composer-overlay]')!).visibility).toBe('visible');
  expect(document.activeElement).toBe(button('Add repository…'));
});

it('opens the selected repository workspace from the sidebar without a second confirmation', async () => {
  await render('expanded');
  vi.mocked(pickDirectory).mockResolvedValueOnce(repo.localPath);
  const composer = document.createElement('textarea');
  document.body.append(composer);
  const focused = vi.fn((event: Event) => { event.preventDefault(); composer.focus(); });
  window.addEventListener(FOCUS_REPO_WORKSPACE_TAB_EVENT, focused);
  try {
    await act(async () => document.querySelector<HTMLElement>('[aria-label="Add repository"]')!.click());
    expect(pickDirectory).toHaveBeenCalledOnce();
    expect(onRepoAdded).toHaveBeenCalledExactlyOnceWith(repo);
    expect(onSelectRepo).toHaveBeenCalledExactlyOnceWith(repo.id);
    expect(focused).toHaveBeenCalledOnce();
    expect((focused.mock.calls[0][0] as CustomEvent).detail).toEqual({ repoId: repo.id, repoPath: repo.localPath });
    expect(document.querySelector('#add-repo-path')).toBeNull();
    expect(document.activeElement).toBe(composer);
  } finally { window.removeEventListener(FOCUS_REPO_WORKSPACE_TAB_EVENT, focused); composer.remove(); }
});

it('opens a dropped folder from the desktop Add entry without invoking the picker', async () => {
  await act(async () => root.render(createElement(Fragment, null,
    createElement(AddRepoFlowHost, { onRepoAdded, onSelectRepo }),
    createElement(AgentPanel, { onRepoAdded, onSelectRepo, navigationRail: true }),
  )));
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: {
    files: [], getData: (type: string) => type === 'text/uri-list' ? `file://${repo.localPath}` : '',
  } });
  await act(async () => button('Add repository').dispatchEvent(drop));
  expect(pickDirectory).not.toHaveBeenCalled();
  expect(onRepoAdded).toHaveBeenCalledExactlyOnceWith(repo);
  expect(onSelectRepo).toHaveBeenCalledExactlyOnceWith(repo.id);
});
