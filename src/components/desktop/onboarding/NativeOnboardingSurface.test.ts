// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Onboarding } from '../Onboarding';
import { ThemeProvider, useTheme } from '@/lib/theme/context';
import { FirstRunPreview, createOnboardingPreviewRequest } from '../../../../tests/fixtures/onboarding/FirstRunPreview';
import { PickerMenu } from '@/components/desktop/settings/dispatch-shared';
import { OnboardingSurface } from './OnboardingSurface';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const shell = window as unknown as { __TAURI_INTERNALS__?: { invoke: ReturnType<typeof vi.fn> }; __O8_HOST_PLATFORM__?: string };
let root: Root;
let theme: ReturnType<typeof useTheme>;
let workspace: HTMLDivElement;
let ancestorSibling: HTMLDivElement;

function ThemeProbe() {
  const current = useTheme();
  useEffect(() => { theme = current; }, [current]);
  return null;
}
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('cortex-theme-palette', 'dark');
  localStorage.setItem('cortex-reduce-transparency', 'off');
  localStorage.setItem('cortex-workspace-glass', 'true');
  shell.__O8_HOST_PLATFORM__ = 'macos';
  shell.__TAURI_INTERNALS__ = { invoke: vi.fn().mockResolvedValue(undefined) };
  ancestorSibling = document.createElement('div');
  ancestorSibling.textContent = 'Background workspace';
  ancestorSibling.style.setProperty('visibility', 'collapse', 'important');
  ancestorSibling.inert = true;
  document.body.appendChild(ancestorSibling);
  const shellRoot = document.createElement('main');
  shellRoot.style.background = 'var(--t-bg-gradient)';
  workspace = document.createElement('div');
  workspace.textContent = 'Workspace controls';
  workspace.inert = false;
  shellRoot.appendChild(workspace);
  const host = document.createElement('div');
  shellRoot.appendChild(host);
  document.body.appendChild(shellRoot);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
  document.documentElement.style.cssText = '';
  for (const key of ['theme', 'palette', 'surface', 'workspace-glass', 'tauri']) document.documentElement.removeAttribute(`data-${key}`);
  document.querySelectorAll('#tauri-vibrancy-overrides, #theme-chrome-surface').forEach((node) => node.remove());
  delete shell.__TAURI_INTERNALS__;
  delete shell.__O8_HOST_PLATFORM__;
  localStorage.clear();
  vi.restoreAllMocks();
});
async function render() {
  await act(async () => root.render(createElement(ThemeProvider, null,
    createElement(ThemeProbe),
    createElement(Onboarding, { request: createOnboardingPreviewRequest(), onComplete: vi.fn(), storage: localStorage }),
  )));
  return document.querySelector<HTMLElement>('[data-o8-onboarding]')!;
}

it('exposes the native material while hiding workspace content and preserving primary-button ink', async () => {
  const setup = await render();
  expect(document.documentElement.dataset.surface).toBe('glass');
  expect(getComputedStyle(workspace).visibility).toBe('hidden');
  expect(workspace.inert).toBe(true);
  expect(ancestorSibling.style.visibility).toBe('hidden');
  expect(setup.dataset.chromeSurface).toBe('true');
  expect(setup.style.getPropertyValue('--t-onboarding-surface-bg')).toBe('var(--t-bg)');
  expect(setup.style.getPropertyValue('--t-onboarding-bg')).toBe('#242424');
  expect(workspace.parentElement?.style.background).toBe('var(--t-bg-gradient)');
  const action = Array.from(setup.querySelectorAll('button')).find((button) => button.textContent?.includes('Open a folder'))!;
  expect(action.style.color).toBe('var(--t-onboarding-bg)');
  expect(action.style.background).toBe('var(--t-text)');
  act(() => root.unmount());
  expect(workspace.style.visibility).toBe('');
  expect(workspace.inert).toBe(false);
  expect(ancestorSibling.style.getPropertyValue('visibility')).toBe('collapse');
  expect(ancestorSibling.style.getPropertyPriority('visibility')).toBe('important');
  expect(ancestorSibling.inert).toBe(true);
});

it('restores the workspace when switching the native surface to solid without changing saved palette choices', async () => {
  const setup = await render();
  expect(workspace.inert).toBe(true);
  await act(async () => { theme.setWorkspaceGlass(false); theme.setReduceTransparency('on'); });
  expect(document.documentElement.dataset.surface).toBe('solid');
  expect(setup.dataset.chromeSurface).toBeUndefined();
  expect(setup.style.getPropertyValue('--t-onboarding-surface-bg')).toBe('');
  expect(workspace.style.visibility).toBe('');
  expect(workspace.inert).toBe(false);
  expect(localStorage.getItem('cortex-theme-palette')).toBe('dark');
});

it('keeps browser setup opaque even with a stored glass preference', async () => {
  delete shell.__TAURI_INTERNALS__;
  const setup = await render();
  expect(setup.dataset.chromeSurface).toBeUndefined();
  expect(setup.style.getPropertyValue('--t-onboarding-surface-bg')).toBe('');
  expect(workspace.style.visibility).toBe('');
  expect(workspace.inert).toBe(false);
  expect(localStorage.getItem('cortex-workspace-glass')).toBe('true');
});

it('obscures late workspace content and preserves a newer visibility change on close', async () => {
  await render();
  const lateControl = document.createElement('button');
  lateControl.textContent = 'Late workspace action';
  lateControl.inert = false;
  await act(async () => workspace.parentElement!.appendChild(lateControl));
  expect(lateControl.style.opacity).toBe('0');
  expect(lateControl.inert).toBe(true);
  workspace.style.setProperty('visibility', 'collapse');
  act(() => root.unmount());
  expect(workspace.style.visibility).toBe('collapse');
  expect(lateControl.style.opacity).toBe('');
  expect(lateControl.inert).toBe(false);
});

it('keeps the native preview on the app material instead of painting its browser palette over it', async () => {
  await act(async () => root.render(createElement(ThemeProvider, null, createElement(FirstRunPreview))));
  const controls = document.querySelector<HTMLElement>('[data-onboarding-preview-controls]')!;
  const preview = controls.parentElement!;
  expect(preview.style.getPropertyValue('--t-bg')).toBe('');
  expect(preview.style.background).toBe('var(--t-bg-gradient)');
  expect(controls.style.visibility).toBe('');
  expect(document.querySelector<HTMLSelectElement>('[aria-label="Preview theme"]')?.disabled).toBe(true);
});

it.each([true, false])('keeps the owned settings picker above setup and selectable (native: %s)', async (native) => {
  if (!native) delete shell.__TAURI_INTERNALS__;
  const choose = vi.fn();
  await act(async () => root.render(createElement(ThemeProvider, null,
    createElement(OnboardingSurface, null, createElement(PickerMenu, {
      value: 'first', options: [{ value: 'first', label: 'First tool' }, { value: 'second', label: 'Second tool' }], onChange: choose,
    })),
  )));
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')!.click());
  const picker = document.querySelector<HTMLElement>('[data-o8-settings-portal]')!;
  expect(picker.style.zIndex).toBe('100000');
  expect(picker.inert).not.toBe(true);
  expect(getComputedStyle(picker).visibility).toBe('visible');
  await act(async () => Array.from(picker.querySelectorAll('button')).find((button) => button.textContent?.includes('Second tool'))!.click());
  expect(choose).toHaveBeenCalledWith('second');
  expect(document.querySelector('[data-o8-settings-portal]')).toBeNull();
});
