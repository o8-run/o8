// @vitest-environment jsdom

import { act, createElement, type ComponentProps, type HTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import { ProjectsSwitcher } from './ProjectsSwitcher';
import { ChatListColumn } from '@/components/desktop/shell/ChatListColumn';

vi.mock('framer-motion', () => ({ useReducedMotion: () => true, motion: { div: 'div' } }));
vi.mock('../FloatingSurface', async (importOriginal) => ({
  ...await importOriginal<typeof import('../FloatingSurface')>(),
  FloatingSurface: ({ children }: HTMLAttributes<HTMLDivElement>) => createElement('div', null, children),
}));
vi.mock('./ProjectGroupDialog', () => ({ ProjectGroupDialog: () => createElement('div', { role: 'dialog' }, 'Project form') }));
vi.mock('./ConnectRepositoryDialog', () => ({ ConnectRepositoryDialog: () => null }));

const repos: RepoRegistryEntry[] = ['web', 'api', 'mobile', 'docs', 'tools', 'worker'].map((name) => ({
  id: name, name, localPath: `/preview/${name}`, remoteUrl: null, defaultBranch: 'main',
  addedAt: '2026-10-17T00:00:00.000Z', lastOpenedAt: null, storagePressureParkingDisabled: false,
  setup: {
    envMode: 'copy', envFiles: [], installCommand: null, installOnCreateWorkspace: false,
    buildCommand: null, runBuildOnCreateWorkspace: false, devCommand: null, defaultPort: null,
    workspaceIsolationPreference: 'auto',
  },
}));
const props: ComponentProps<typeof ProjectsSwitcher> = {
  projects: [{ id: 'preview', name: 'Preview', repoPaths: repos.map((repo) => repo.localPath), createdAt: repos[0].addedAt }],
  activeProjectId: 'preview', selectedRepoPath: repos[0].localPath,
  registeredRepoByPath: new Map(repos.map((repo) => [repo.localPath, repo])),
  onProjectSelect: vi.fn(async () => true), onRepoSelect: vi.fn(), onManageProjects: vi.fn(), onAddRepo: vi.fn(),
};
let root: Root;
let host: HTMLDivElement;

let observers: ResizeObserverCallback[];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); observers = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { observers.push(callback); } observe() {} disconnect() {} });
  vi.mocked(props.onRepoSelect).mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const row = () => host.querySelector<HTMLElement>('[aria-label="Project repositories"]')!;
const chips = () => Array.from(row().querySelectorAll<HTMLButtonElement>('[data-repository-chip]'));
function render(selectedRepoPath = props.selectedRepoPath, count = 6) {
  act(() => root.render(createElement(ProjectsSwitcher, { ...props, selectedRepoPath,
    projects: [{ ...props.projects[0], repoPaths: repos.slice(0, count).map(repo => repo.localPath) }] })));
}
function resize(width: number, nameWidth = 68) {
  Object.defineProperty(row(), 'clientWidth', { configurable: true, value: width });
  host.querySelectorAll<HTMLElement>('[data-repository-measure]').forEach(node => Object.defineProperty(node, 'offsetWidth', { configurable: true, value: nameWidth }));
  act(() => [...observers].forEach(callback => callback([], {} as ResizeObserver)));
}
describe('adaptive project repository navigation', () => {
  it('accepts a folder dropped on the Add entry without opening a source menu', () => {
    const onAddRepo = vi.fn();
    act(() => root.render(createElement(ProjectsSwitcher, { ...props, onAddRepo })));
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [], getData: (type: string) => type === 'text/uri-list' ? 'file:///projects/example' : '' } });
    act(() => host.querySelector('[aria-label="Add repository"]')!.dispatchEvent(drop));
    expect(onAddRepo).toHaveBeenCalledExactlyOnceWith('/projects/example');
  });

  it('accepts a Git URL pasted on the Add entry', () => {
    const onAddRepo = vi.fn();
    act(() => root.render(createElement(ProjectsSwitcher, { ...props, onAddRepo })));
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: () => 'https://example.org/team/project.git' } });
    act(() => host.querySelector('[aria-label="Add repository"]')!.dispatchEvent(paste));
    expect(onAddRepo).toHaveBeenCalledExactlyOnceWith('https://example.org/team/project.git');
  });

  it('keeps a pending project switch dismissed when the sidebar reopens', async () => {
    let finish!: (result: boolean) => void;
    const onProjectSelect = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const renderColumn = (visible: boolean) => act(() => root.render(createElement(ChatListColumn,
      { visible, overlay: false, width: 320, onClose: vi.fn() },
      createElement(ProjectsSwitcher, { ...props, onProjectSelect }))));
    renderColumn(true);
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Switch project"]')!;
    act(() => trigger.click());
    act(() => document.querySelector<HTMLButtonElement>('[data-project-choice]')!.click());
    expect(onProjectSelect).toHaveBeenCalledOnce();
    expect(trigger.disabled).toBe(true);
    renderColumn(false);
    expect(document.querySelector('[data-composer-overlay]')).toBeNull();
    renderColumn(true);
    try {
      expect(document.querySelector('[data-composer-overlay]')).toBeNull();
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    } finally {
      await act(async () => finish(true));
    }
    expect(onProjectSelect).toHaveBeenCalledOnce();
  });

  it.each([
    ['projects', false], ['overflow', false],
    ['projects', true], ['overflow', true],
  ] as const)('dismisses %s when the retained sidebar closes (overlay=%s)', (menu, overlay) => {
    const renderColumn = (visible: boolean) => act(() => root.render(createElement('div', null,
      createElement('button', { 'aria-label': 'Toggle sidebar', onClick: () => renderColumn(!visible) }, 'Chats'),
      createElement(ChatListColumn, { visible, overlay, width: 320, onClose: () => renderColumn(false) },
        createElement('div', { 'data-chat-scroll': true }, createElement(ProjectsSwitcher, props))),
    )));
    renderColumn(true);
    resize(260);
    const scroll = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
    scroll.scrollTop = 173;
    const trigger = host.querySelector<HTMLButtonElement>(menu === 'projects' ? '[aria-label="Switch project"]' : '[aria-label="3 more repositories"]')!;
    act(() => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-composer-overlay]')).not.toBeNull();
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Toggle sidebar"]')!;
    act(() => { toggle.focus(); toggle.click(); });
    expect(document.querySelector('[data-composer-overlay]')).toBeNull();
    expect(document.activeElement).toBe(toggle);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(host.querySelector('[data-chat-scroll]')).toBe(scroll);
    expect(scroll.scrollTop).toBe(173);
    expect(host.querySelector('[aria-label="Switch project"]')?.textContent).toContain('Preview');
    expect(document.querySelector('[data-composer-overlay]')).toBeNull();
    act(() => trigger.click());
    expect(document.querySelector('[data-composer-overlay]')).not.toBeNull();
    // A responsive boundary can hide the column without a pointer event.
    renderColumn(false);
    expect(document.querySelector('[data-composer-overlay]')).toBeNull();
    expect(document.activeElement?.closest('[inert]')).toBeNull();
    renderColumn(true);
    expect(document.querySelector('[data-composer-overlay]')).toBeNull();
    expect(host.querySelector('[data-chat-scroll]')).toBe(scroll);
  });

  it('offers existing project and repository entry points only after an empty navigation read', () => {
    const onAddRepo = vi.fn();
    const onProjectSelect = vi.fn(async () => true);
    const empty = { ...props, projects: [], activeProjectId: null, registeredRepoByPath: new Map(), onAddRepo, onProjectSelect };
    act(() => root.render(createElement(ProjectsSwitcher, { ...empty, loading: true })));
    expect(host.textContent).not.toContain('New project');
    act(() => root.render(createElement(ProjectsSwitcher, empty)));
    const find = (label: string) => [...document.querySelectorAll('button')].find(button => button.textContent === label)!;
    expect(onAddRepo).not.toHaveBeenCalled(); expect(onProjectSelect).not.toHaveBeenCalled();
    act(() => find('New project').click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toBe('Project form');
    act(() => find('Add repository').click());
    expect(onAddRepo).toHaveBeenCalledOnce();
    expect(onProjectSelect).not.toHaveBeenCalled();
  });
  it('keeps the selected repo visible, puts remaining repos in a keyboard menu and selects the exact repo', () => {
    render(repos[5].localPath); resize(260);
    expect(chips()).toHaveLength(3); expect(chips()[0].textContent).toContain('worker');
    const more = row().querySelector<HTMLButtonElement>('[aria-label="3 more repositories"]')!;
    expect(more).not.toBeNull(); act(() => more.click());
    const choice = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="Open docs repository"]')!;
    expect(choice).not.toBeNull(); act(() => choice.click());
    expect(props.onRepoSelect).toHaveBeenCalledExactlyOnceWith(props.projects[0], repos[3].localPath);
    expect(document.querySelector('[aria-label="More repositories"]')).toBeNull();
    render(repos[3].localPath); resize(120); expect(chips()).toHaveLength(1); expect(chips()[0].textContent).toContain('docs');
    resize(260); expect(chips()).toHaveLength(3);
  });
  it('shows every short name when three fit, and uses overflow when names or the sidebar need more room', () => {
    render(repos[0].localPath, 3); resize(260);
    expect(chips()).toHaveLength(3); expect(row().querySelector('[aria-haspopup="menu"]')).toBeNull();
    resize(260, 140); expect(chips()).toHaveLength(1); expect(row().querySelector('[aria-label="2 more repositories"]')).not.toBeNull();
    resize(400, 140); expect(chips()).toHaveLength(2);
    render(repos[0].localPath, 1); expect(host.querySelector('[aria-label="Project repositories"]')).toBeNull();
  });
});
