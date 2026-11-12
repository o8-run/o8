// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Onboarding } from '../Onboarding';
import { createOnboardingPreviewRequest, PREVIEW_PROJECT } from '../../../../tests/fixtures/onboarding/FirstRunPreview';
import { IPHONE_APP_INSTALL_URL } from '../canvas/mobile-app-link';
import { emptyProgress, PROGRESS_KEY } from './onboarding-progress';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => { act(() => root?.unmount()); document.body.replaceChildren(); localStorage.clear(); vi.restoreAllMocks(); if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor); else Reflect.deleteProperty(navigator, 'clipboard'); });
const findButton = (label: string) => [...document.querySelectorAll('button')].find((node) => node.textContent === label || node.getAttribute('aria-label') === label);
async function render() {
  const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  const request = vi.fn(createOnboardingPreviewRequest());
  const complete = vi.fn().mockResolvedValue(true);
  const openExternal = vi.fn();
  localStorage.setItem(PROGRESS_KEY, JSON.stringify({ ...emptyProgress(), project: PREVIEW_PROJECT }));
  await act(async () => root.render(createElement(Onboarding, { request, storage: localStorage, onComplete: complete, openExternal })));
  return { request, complete, openExternal };
}

it('offers an optional beta page without pairing, settings writes, or losing the selected project', async () => {
  const { request, complete, openExternal } = await render();
  expect(findButton('Try the iPhone app')).toBeDefined();
  await act(async () => findButton('Try the iPhone app')!.click());
  expect(document.querySelector('h1')?.textContent).toBe('Take o8 with you.');
  expect(document.querySelector('[aria-current="step"]')?.textContent).toContain('Workspace');
  const link = document.querySelector<HTMLAnchorElement>(`a[href="${IPHONE_APP_INSTALL_URL}"]`)!;
  expect(link).not.toBeNull();
  await act(async () => link.click());
  expect(openExternal).toHaveBeenCalledWith(IPHONE_APP_INSTALL_URL);
  expect(request.mock.calls.some(([url, init]) => String(url).includes('mobile-pairing') || init?.method === 'POST')).toBe(false);
  expect(complete).not.toHaveBeenCalled();
  await act(async () => findButton('Back to projects')!.click());
  expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!).project).toEqual(PREVIEW_PROJECT);
  expect(document.querySelector('h1')?.textContent).toContain('Open a project');
});

it('places optional voice setup under Workspace and keeps a return action in the browser', async () => {
  await render();
  await act(async () => findButton('Check voice & permissions')!.click());
  expect(document.querySelector('h1')?.textContent).toContain('Symon');
  expect(document.querySelector('[aria-current="step"]')?.textContent).toContain('Workspace');
  expect(document.body.textContent).toContain('macOS app');
  expect(findButton('Back to projects')).toBeDefined();
  await act(async () => findButton('Back to projects')!.click());
  expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!).project).toEqual(PREVIEW_PROJECT);
});

it('starts silent and saves an explicit sound preference in the supplied storage', async () => {
  await render();
  const sound = document.querySelector<HTMLButtonElement>('[aria-label="Onboarding sounds"]');
  expect(sound).not.toBeNull();
  expect(sound?.getAttribute('aria-pressed')).toBe('false');
  await act(async () => sound!.click());
  expect(sound?.getAttribute('aria-pressed')).toBe('true');
  expect(localStorage.getItem('o8:onboarding-muted')).toBe('0');
});

it('keeps the beta destination and project available when copying fails, then retries', async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new Error('Clipboard blocked')).mockResolvedValueOnce(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await render();
  await act(async () => findButton('Try the iPhone app')!.click());
  await act(async () => findButton('Copy beta link')!.click());
  expect(document.body.textContent).toContain('Could not copy the link.');
  expect(document.querySelector(`a[href="${IPHONE_APP_INSTALL_URL}"]`)).not.toBeNull();
  expect(JSON.parse(localStorage.getItem(PROGRESS_KEY)!).project).toEqual(PREVIEW_PROJECT);
  await act(async () => findButton('Copy beta link')!.click());
  expect(writeText).toHaveBeenLastCalledWith(IPHONE_APP_INSTALL_URL);
  expect(document.body.textContent).toContain('Beta link copied.');
  expect(document.body.textContent).not.toContain('Could not copy the link.');
});
