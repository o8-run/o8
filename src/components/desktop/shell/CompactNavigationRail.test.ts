// @vitest-environment jsdom
import { act, createElement, type HTMLAttributes } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompactNavigationRail } from './CompactNavigationRail';
import { OPEN_KEYBOARD_SHORTCUTS_EVENT, OPEN_SETTINGS_TAB_EVENT } from '@/lib/desktop/events';
import { setCustomizeTab } from '../customize/navigation';
import { checkAllUpdates, publishAppUpdateView, refreshCliUpdateView, registerAppUpdateCheck } from '@/lib/app-update/update-hub-client';

const auth = vi.hoisted(() => ({ isLoaded: true, signedIn: false, clerkEnabled: true, user: { name: 'Private account', email: 'private@example.test' }, signIn: vi.fn(), openManageAccount: vi.fn() }));
const updateCheck = vi.hoisted(() => vi.fn(async () => ({ version: null as string | null })));
const theme = vi.hoisted(() => ({ paletteId: 'light', workspaceGlass: false, setPalette: vi.fn(), setWorkspaceGlass: vi.fn(), setReduceTransparency: vi.fn() }));
const notify = vi.hoisted(() => vi.fn());
vi.mock('@/components/shared/ConfirmToastHost', () => ({ toast: notify }));
vi.mock('@/components/auth/O8AuthProvider', () => ({ useO8Auth: () => auth }));
vi.mock('@/lib/theme/context', () => ({ useTheme: () => theme }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.0.0' }));
vi.mock('@/lib/app-update/check', () => ({ check: updateCheck }));
vi.mock('@lisse/react', () => ({ SmoothCorners: ({ children, style }: HTMLAttributes<HTMLDivElement>) => createElement('div', { style }, children) }));
beforeEach(() => {
  setCustomizeTab('rules');
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/setup/cli-updates')) return Response.json({ tools: [] });
    if (String(input).startsWith('/api/panel/o8-update-summary')) return Response.json({ version: '0.1.1', summary: 'Published changes', entries: [{ text: 'Clearer navigation' }], source: 'release', releaseUrl: 'https://github.com/hurttlocker/o8-releases/releases/tag/v0.1.1' });
    throw new Error(`Unexpected request ${String(input)}`);
  }));
});
afterEach(() => { auth.signedIn = false; vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('keeps navigation usable with the chat list open or closed and reads fresh usage', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const callbacks = {
    onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(),
    onOpenProjects: vi.fn(), onOpenSettings: vi.fn(),
    onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn(),
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/runtime/capacity') return Response.json({
      schema: 'o8/runtime-capacity-control/v1', capacities: [{ runtime: 'codex', status: 'available', confidence: 'exact', buckets: [{ id: 'weekly', label: 'Weekly', usedRatio: 0.4 }] }],
    });
    if (String(input).startsWith('/api/setup/cli-updates')) return Response.json({ tools: [] });
    if (String(input).startsWith('/api/panel/o8-update-summary')) return Response.json({ version: '0.1.1', summary: 'Published changes', entries: [{ text: 'Clearer navigation' }], source: 'release' });
    throw new Error(`Unexpected request ${String(input)}`);
  }));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) => {
    const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(found).not.toBeNull();
    return found!;
  };
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'projects', glassSurface: false })));
    expect(fetch).toHaveBeenCalledWith('/api/runtime/capacity', expect.objectContaining({ cache: 'no-store' }));
    expect(host.querySelector('[data-runtime-weekly-meter="codex"]')?.getAttribute('aria-valuenow')).toBe('40');
    expect(host.querySelector('[data-runtime-weekly-meter="claude-code"]')?.getAttribute('aria-valuetext')).toBe('Not reported');
    expect(host.querySelector('[aria-label="Search"]')).toBeNull();
    expect(host.querySelector('[aria-label="Projects"]')).toBeNull();
    expect(host.querySelector('[aria-label="Customize"]')).toBeNull();
    expect(button('More navigation').getAttribute('aria-current')).toBe('page');
    expect(button('Automations')).toBeDefined();
    expect(button('Plugins')).toBeDefined();
    await act(async () => button('More navigation').click());
    const projects = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="Projects"]')!;
    expect(projects.getAttribute('aria-current')).toBe('page');
    expect(document.activeElement).toBe(projects);
    await act(async () => projects.click());
    expect(callbacks.onOpenProjects).toHaveBeenCalledOnce();
    expect(document.querySelector('[aria-label="More destinations"]')).toBeNull();
    expect(document.activeElement).toBe(button('More navigation'));
    expect(host.querySelector('[aria-label="Hide chats"], [aria-label="Show chats"], [aria-label="Settings"]')).toBeNull();
    expect(button('Canvas mode')).toBeDefined();
    expect(button('Home').querySelector('img')?.getAttribute('src')).toBe('/logos/o8-desktop.png');
    expect(host.querySelectorAll('[data-sidebar-brand]')).toHaveLength(1);
    const navigationButtons = [...host.querySelectorAll('[aria-label="Workspace navigation"] button')];
    expect(navigationButtons[1]).toBe(button('Symon'));
    const voiceToggle = vi.fn();
    window.addEventListener('o8:symon-voice-toggle', voiceToggle);
    try {
      expect(voiceToggle).not.toHaveBeenCalled();
      await act(async () => button('Symon').click());
      expect(voiceToggle).toHaveBeenCalledOnce();
    } finally { window.removeEventListener('o8:symon-voice-toggle', voiceToggle); }
    for (const [label, callback] of [['Home', callbacks.onHome], ['Run orchestrator', callbacks.onNewSession], ['Run terminal', callbacks.onCreateTerminal], ['PRs', callbacks.onOpenPRs]] as const) {
      await act(async () => button(label).click());
      expect(callback).toHaveBeenCalledOnce();
      expect(button(label).style.minWidth).toBe('44px');
      expect(button(label).style.minHeight).toBe('var(--o8-navigation-target, 44px)');
    }
    expect(button('More navigation').nextElementSibling).toBe(button('PRs'));
    expect(button('More navigation').style.minWidth).toBe('44px');
    expect(button('More navigation').style.minHeight).toBe('var(--o8-navigation-target, 44px)');
    expect(host.querySelector('[aria-label="Handoffs"]')).toBeNull();
    await act(async () => button('Runtime usage').focus());
    expect(document.getElementById('o8-rail-usage-tooltip')?.textContent).toContain('40% used');
    await act(async () => button('Runtime usage').click());
    expect(callbacks.onOpenUsage).toHaveBeenCalledOnce();
    await act(async () => { button('Runtime usage').blur(); button('Runtime usage').focus(); });
    for (const scroller of host.querySelectorAll<HTMLElement>('[style*="overflow-y: auto"]')) expect(scroller.style.scrollbarWidth).toBe('none');
    await act(async () => button('Runtime usage').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.getElementById('o8-rail-usage-tooltip')).toBeNull();
    const rail = host.querySelector('[aria-label="Workspace navigation"]');
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: true })));
    expect(host.querySelector('[aria-label="Workspace navigation"]')).toBe(rail);
    expect(host.querySelector('[aria-label="Hide chats"], [aria-label="Show chats"]')).toBeNull();
    expect(button('Home').getAttribute('aria-current')).toBe('page');
    expect((rail as HTMLElement).style.background).toBe('transparent');
    expect((rail as HTMLElement).style.boxShadow).toBe('none');
    expect(fetch).toHaveBeenCalledWith('/api/runtime/capacity', expect.objectContaining({ cache: 'no-store' }));
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('reaches Plugins directly, keeps Automations, and navigates the secondary drawer by keyboard', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const callbacks = { onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn() };
  const customize = vi.fn();
  const automations = vi.fn();
  window.addEventListener('o8:open-customize', customize);
  window.addEventListener('o8:open-automations', automations);
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const key = async (value: string) => act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })));
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: true })));
    await act(async () => button('Automations').click());
    expect(automations).toHaveBeenCalledOnce();
    await act(async () => button('Plugins').click());
    expect(customize).toHaveBeenCalledOnce();
    expect((customize.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'plugins' });
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', workspacePage: 'plugins', glassSurface: true })));
    expect(button('Plugins').getAttribute('aria-current')).toBe('page');
    await act(async () => button('More navigation').click());
    expect(document.activeElement).toBe(button('Projects'));
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    await key('ArrowDown');
    expect(document.activeElement).toBe(button('Customize'));
    await key('Escape');
    expect(document.querySelector('[aria-label="More destinations"]')).toBeNull();
    expect(document.activeElement).toBe(button('More navigation'));
    await act(async () => button('More navigation').click());
    await key('End');
    expect(document.activeElement).toBe(button('Settings'));
    await key('ArrowUp');
    await act(async () => button('Customize').click());
    expect(customize).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[aria-label="More destinations"]')).toBeNull();
    await act(async () => button('More navigation').click());
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(document.querySelector('[aria-label="More destinations"]')).toBeNull();
  } finally {
    window.removeEventListener('o8:open-customize', customize);
    window.removeEventListener('o8:open-automations', automations);
    await act(async () => root.unmount());
    host.remove();
  }
});

it('distinguishes app Settings from Customize before navigation and preserves the selected workspace capability', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const callbacks = { onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn() };
  const customize = vi.fn(); window.addEventListener('o8:open-customize', customize);
  const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  setCustomizeTab('skills');
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', workspacePage: 'customize', glassSurface: false })));
    await act(async () => button('More navigation').click());
    const menu = document.querySelector<HTMLElement>('[aria-label="More destinations"]')!;
    expect([...menu.querySelectorAll('[role="menuitem"]')].map(item => item.getAttribute('aria-label'))).toEqual(['Projects', 'Customize', 'Settings']);
    for (const [label, description] of [['Customize', 'Agent and workspace capabilities'], ['Settings', 'Appearance and app preferences']]) {
      const item = button(label);
      expect(item.textContent).toContain(description);
      expect(document.getElementById(item.getAttribute('aria-describedby')!)?.textContent).toBe(description);
    }
    expect(callbacks.onOpenSettings).not.toHaveBeenCalled(); expect(customize).not.toHaveBeenCalled();
    await act(async () => button('Customize').click());
    expect(customize).toHaveBeenCalledOnce(); expect((customize.mock.calls[0][0] as CustomEvent).detail).toEqual({ tab: 'skills' });
    expect(document.activeElement).toBe(button('More navigation'));
    await act(async () => button('More navigation').click());
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(button('Settings'));
    await act(async () => (document.activeElement as HTMLButtonElement).click());
    expect(callbacks.onOpenSettings).toHaveBeenCalledOnce(); expect(customize).toHaveBeenCalledOnce();
    expect(theme.setPalette).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="More destinations"]')).toBeNull();
    expect(document.activeElement).toBe(button('More navigation'));
    await act(async () => button('More navigation').click());
    await act(async () => button('Customize').click());
    expect((customize.mock.calls[1][0] as CustomEvent).detail).toEqual({ tab: 'skills' });
  } finally { window.removeEventListener('o8:open-customize', customize); await act(async () => root.unmount()); host.remove(); }
});

it('opens cached release notes from the updater and restores focus on Escape without reopening', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const callbacks = { onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn() };
  const install = vi.fn();
  window.addEventListener('o8:install-app-update', install);
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: false })));
    const updates = host.querySelector<HTMLButtonElement>('[aria-label="Updates"]')!;
    await act(async () => updates.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
    const popup = document.querySelector<HTMLElement>('[aria-label="Updates and release notes"]')!;
    expect(popup.textContent).toContain('Clearer navigation');
    expect(popup.id).toBe(updates.getAttribute('aria-controls'));
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Refresh updates');
    expect(document.querySelector('[aria-label="Quick settings"]')).toBeNull();
    expect(updateCheck).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.querySelector('[aria-label="Updates and release notes"]')).toBeNull();
    expect(document.activeElement).toBe(updates);
    expect(updates.getAttribute('aria-expanded')).toBe('false');
  } finally {
    window.removeEventListener('o8:install-app-update', install);
    await act(async () => root.unmount());
    host.remove();
  }
});

it('checks updates on click and opens the panel with the result', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const unregister = registerAppUpdateCheck(updateCheck);
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => String(input).startsWith('/api/setup/cli-updates')
    ? Response.json({ tools: ['codex', 'claude-code', 'grok'].map(runtimeId => ({ runtimeId, label: runtimeId, status: 'not-installed' })) })
    : Response.json({ entries: [], summary: 'Published changes' }));
  const callbacks = { onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn() };
  const install = vi.fn(); window.addEventListener('o8:install-app-update', install);
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: true })));
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Updates"]')!;
    await act(async () => trigger.click());
    expect(updateCheck).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith('Checking o8…', 'info');
    expect(notify).toHaveBeenCalledWith('o8 is up to date.', 'success');
    expect(document.querySelector('[aria-label="Updates and release notes"]')?.textContent).toContain('You’re up to date.');
    expect(install).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  } finally { unregister(); window.removeEventListener('o8:install-app-update', install); await act(async () => root.unmount()); host.remove(); }
});

it('keeps o8 primary and requires expanding Tools before any explicit CLI update', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const callbacks = { onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn() };
  const install = vi.fn(); window.addEventListener('o8:install-app-update', install);
  const cli = (runtimeId: string, status: string) => ({ runtimeId, label: runtimeId, status, installedVersion: '1.0', latestVersion: '1.1' });
  vi.mocked(fetch).mockImplementation(async input => String(input).startsWith('/api/setup/cli-updates')
    ? Response.json({ tools: [cli('codex', 'update-available'), cli('claude-code', 'current'), cli('grok', 'not-installed'), cli('gemini', 'current')] })
    : Response.json({ entries: [], summary: 'Published changes' }));
  publishAppUpdateView({ version: '0.1.901', outcome: 'available', installing: false, message: null, error: 'Fetch is aborted', downloadOnly: false });
  try {
    await refreshCliUpdateView(true);
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: true })));
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Updates"]')!;
    expect(trigger.querySelector('[data-update-ready]')).not.toBeNull();
    expect(trigger.querySelector('[data-update-dot]')).toBeNull();
    await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
    const popup = document.querySelector<HTMLElement>('[aria-label="Updates and release notes"]')!;
    expect(popup.textContent).not.toContain('codex');
    const tools = popup.querySelector<HTMLButtonElement>('[aria-label="Tools updates"]')!;
    expect(tools).not.toBeNull(); expect(tools.getAttribute('aria-expanded')).toBe('false');
    const notesHeading = [...popup.querySelectorAll('div')].find(element => element.textContent === 'What’s changed')!;
    expect(notesHeading.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => tools.click());
    expect(popup.textContent).toContain('codex');
    expect(popup.textContent).not.toMatch(/claude-code|grok|gemini|Fetch is aborted/);
    expect(popup.textContent).toContain('Update checks couldn’t finish');
    const current = [...popup.querySelectorAll('button')].find(button => button.textContent?.startsWith('Current CLIs'))!;
    expect(current.getAttribute('aria-expanded')).toBe('false');
    act(() => current.click());
    expect(popup.textContent).toContain('claude-code');
    expect(current.getAttribute('aria-expanded')).toBe('true');
    const update = [...popup.querySelectorAll('button')].find(button => button.textContent === 'Update o8')!;
    expect(update.style.minHeight).toBe('30px');
    const unregister = registerAppUpdateCheck(async () => {
      publishAppUpdateView({ version: '0.1.901', outcome: 'available', installing: false, message: null, error: null, downloadOnly: false });
      return { version: '0.1.901' };
    });
    await act(async () => { await checkAllUpdates(); }); unregister();
    expect(popup.textContent).toContain('Updates are ready.');
    act(() => update.click()); expect(install).toHaveBeenCalledOnce();
    expect([...popup.querySelectorAll('button')].some(button => button.textContent === 'Update connected CLIs')).toBe(false);
    expect(popup.querySelector('[aria-label="Update codex"]')).not.toBeNull();
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
    await act(async () => publishAppUpdateView({ version: '0.1.901', outcome: 'available', installing: false, message: 'Restart is waiting for lanes and terminals to become idle.', error: null, downloadOnly: false }));
    expect(popup.textContent).toContain('Restart is waiting');
    expect(popup.textContent).not.toContain('You’re up to date.');
  } finally {
    publishAppUpdateView({ version: null, outcome: 'never', installing: false, message: null, error: null, downloadOnly: false });
    window.removeEventListener('o8:install-app-update', install); await act(async () => root.unmount()); host.remove();
  }
});

it('opens quick settings from the avatar, keeps account details in Settings, and returns keyboard focus', async () => {
  auth.signedIn = true;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const callbacks = { onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn() };
  const settings = vi.fn();
  const help = vi.fn();
  window.addEventListener(OPEN_SETTINGS_TAB_EVENT, settings);
  window.addEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, help);
  const drawer = () => document.querySelector<HTMLElement>('[aria-label="Quick settings"]');
  const menuButton = (label: string) => [...drawer()!.querySelectorAll('button')].find((button) => button.textContent?.startsWith(label))!;
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: false })));
    const avatar = host.querySelector<HTMLButtonElement>('[aria-label="Open quick settings"]')!;
    await act(async () => avatar.click());
    expect(drawer()?.id).toBe(avatar.getAttribute('aria-controls'));
    expect(document.activeElement).toBe(menuButton('Account'));
    expect(drawer()?.textContent).not.toMatch(/private@example|Private account|Sign out|Sign in/);
    expect(drawer()?.textContent).not.toContain('Runtime capacity');
    expect(drawer()?.textContent).not.toContain('Check for updates');
    expect(auth.openManageAccount).not.toHaveBeenCalled();
    expect(auth.signIn).not.toHaveBeenCalled();
    const last = [...drawer()!.querySelectorAll('button')].at(-1)!;
    last.focus();
    await act(async () => last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(menuButton('Account'));
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(avatar);
    await act(async () => avatar.click());
    await act(async () => menuButton('Account').click());
    expect(settings.mock.calls[0][0].detail).toEqual({ tab: 'account' });
    expect(drawer()).toBeNull();
    await act(async () => avatar.click());
    await act(async () => menuButton('Get help').click());
    await act(async () => menuButton('?Keyboard shortcuts').click());
    expect(callbacks.onOpenShortcuts).toHaveBeenCalledOnce();
    expect(help).not.toHaveBeenCalled();
    expect(drawer()).toBeNull();
    expect(document.activeElement).toBe(avatar);
    await act(async () => avatar.click());
    await act(async () => menuButton('Appearance').click());
    const choices = drawer()!.querySelector('[aria-label="Quick appearance"]')!;
    expect([...choices.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Light', 'Dark', 'All Glass']);
    expect(choices.querySelector('[aria-pressed="true"]')?.textContent).toBe('Light');
    await act(async () => menuButton('Dark').click());
    expect(theme.setPalette).toHaveBeenCalledWith('dark');
    expect(theme.setWorkspaceGlass).toHaveBeenCalledWith(false);
    expect(theme.setReduceTransparency).toHaveBeenCalledWith('on');
    expect(drawer()).toBeNull();
    await act(async () => avatar.click());
    await act(async () => menuButton('All Glass').click());
    expect(theme.setWorkspaceGlass).toHaveBeenLastCalledWith(true);
    expect(settings).toHaveBeenCalledOnce();
    expect(drawer()).toBeNull();
  } finally {
    window.removeEventListener(OPEN_SETTINGS_TAB_EVENT, settings);
    window.removeEventListener(OPEN_KEYBOARD_SHORTCUTS_EVENT, help);
    await act(async () => root.unmount());
    host.remove();
  }
});

it('shows installed CLIs under Tools while keeping the default ready state specific to o8', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const tools = [{ runtimeId: 'codex', label: 'Codex CLI', status: 'not-installed' },
    { runtimeId: 'claude-code', label: 'Claude Code', status: 'current' },
    { runtimeId: 'grok', label: 'Grok Build', status: 'current' },
    { runtimeId: 'gemini', label: 'Gemini CLI', status: 'update-available' }];
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/setup/cli-updates')) return Response.json({ tools });
    return Response.json({ entries: [], summary: 'Published changes' });
  });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const callbacks = { onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn() };
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: true })));
    await act(async () => refreshCliUpdateView(true));
    expect(host.querySelector('[data-update-ready]')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Updates"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
    const popup = document.querySelector('[aria-label="Updates and release notes"]')!;
    await act(async () => popup.querySelector<HTMLButtonElement>('[aria-label="Tools updates"]')!.click());
    await act(async () => [...popup.querySelectorAll('button')].find(button => button.textContent?.startsWith('Current CLIs'))!.click());
    expect(popup.textContent).toContain('Grok Build'); expect(popup.textContent).toContain('Claude Code');
    expect(popup.textContent).not.toContain('Codex CLI'); expect(popup.textContent).toContain('Gemini CLI');
    tools[2]!.status = 'update-available';
    await act(async () => refreshCliUpdateView(true));
    // A CLI update alone shows the small dot; the filled icon is reserved for an o8 update.
    expect(host.querySelector('[data-update-ready]')).toBeNull();
    expect(host.querySelector('[data-cli-update-ready]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});


it('keeps weekly house meters separate from short windows, model caps and unselected accounts', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const capacities = [
    { runtime: 'codex', identityId: 'selected-codex', status: 'available', confidence: 'exact', buckets: [{ label: '5-hour', usedRatio: 0.98 }, { label: 'Weekly', usedRatio: 0.41 }] },
    { runtime: 'codex', identityId: 'other-codex', status: 'available', confidence: 'exact', buckets: [{ label: 'Weekly', usedRatio: 0.99 }] },
    { runtime: 'claude-code', status: 'available', confidence: 'exact', buckets: [{ label: '5-hour', usedRatio: 0.87 }, { label: 'Weekly', usedRatio: 0.62 }, { label: 'Weekly · Opus', usedRatio: 0.95 }] },
  ];
  vi.mocked(fetch).mockImplementation(async input => String(input) === '/api/runtime/capacity'
    ? Response.json({ schema: 'o8/runtime-capacity-control/v1', identities: [{ id: 'selected-codex', runtime: 'codex', selected: true }], capacities })
    : Response.json({ tools: [] }));
  const callbacks = { onHome: vi.fn(), onNewSession: vi.fn(), onCreateTerminal: vi.fn(), onOpenProjects: vi.fn(), onOpenSettings: vi.fn(), onOpenPRs: vi.fn(), onOpenUsage: vi.fn(), onOpenShortcuts: vi.fn() };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { ...callbacks, activeDestination: 'agents', glassSurface: true })));
    const codex = host.querySelector<HTMLElement>('[data-runtime-weekly-meter="codex"]')!;
    const claude = host.querySelector<HTMLElement>('[data-runtime-weekly-meter="claude-code"]')!;
    expect(codex.getAttribute('aria-valuenow')).toBe('41');
    expect(claude.getAttribute('aria-valuenow')).toBe('62');
    expect(codex.firstElementChild?.getAttribute('style')).toContain('var(--t-accent)');
    expect(claude.firstElementChild?.getAttribute('style')).toContain('var(--t-brand-orange)');
    expect(codex.style.left).toBe(claude.style.left);
    expect(codex.style.width).toBe(claude.style.width);
    expect(Number.parseFloat(codex.style.bottom)).toBeGreaterThan(Number.parseFloat(claude.style.bottom));
    expect(document.querySelector('[data-mcp-scope="rail-usage-preview"]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('keeps the usage meter containing block stable while its preview opens on hover and focus', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ capacities: [], tools: [] })));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const noop = () => {};
  try {
    await act(async () => root.render(createElement(CompactNavigationRail, { activeDestination: 'agents', glassSurface: true,
      onHome: noop, onNewSession: noop, onCreateTerminal: noop, onOpenProjects: noop, onOpenSettings: noop,
      onOpenPRs: noop, onOpenUsage: noop, onOpenShortcuts: noop })));
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Runtime usage"]')!;
    const icon = button.firstElementChild as HTMLElement;
    const before = icon.style.filter;
    await act(async () => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(document.querySelector('[data-mcp-scope="rail-usage-preview"]')).not.toBeNull();
    expect(icon.style.filter).toBe(before);
    await act(async () => button.focus()); expect(icon.style.filter).toBe(before);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
