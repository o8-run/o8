// @vitest-environment jsdom

/**
 * A .deb/.rpm Linux install cannot replace itself. The card links to the
 * release page and says to update with the package manager, instead of
 * offering a restart or an AppImage download.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/app-update/update-hub-client', () => ({
  publishAppUpdateView: vi.fn(),
  refreshCliUpdateView: vi.fn(async () => undefined),
  registerAppUpdateCheck: vi.fn(() => () => undefined),
}));
vi.mock('@/lib/app-update/client-restart', () => ({
  installUpdateAndRestart: vi.fn(async () => ({ installed: false, downloadOpened: true })),
  relaunchInstalledUpdate: vi.fn(),
  RELEASE_URL: 'https://example.test/releases',
}));
vi.mock('@/lib/tauri/bridge', () => ({ isTauri: () => false, canUseTauriEvents: () => false }));
vi.mock('@/components/shared/ConfirmToastHost', () => ({ requestConfirm: vi.fn(async () => false) }));

const { UpdateCard } = await import('./UpdateCard');
const { installUpdateAndRestart } = await import('@/lib/app-update/client-restart');

describe('update card on a Linux package install', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => Response.json(String(input) === '/api/panel/app/install-info'
      ? { platform: 'linux', arch: 'x64', appImagePath: null, updaterSelfUpdatable: null }
      : { ok: true })));
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.mocked(installUpdateAndRestart).mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('links to the release page and names the package manager', async () => {
    await act(async () => root.render(createElement(UpdateCard)));
    await act(async () => {
      window.dispatchEvent(new CustomEvent('o8:update-found', { detail: { version: '0.1.811', currentVersion: '0.1.810' } }));
    });

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Open the o8 v0.1.811 release page"]');
    expect(button?.textContent).toBe('Release page');
    expect(container.querySelector('[role="note"]')?.textContent).toContain('Update it with your package manager');

    await act(async () => { button!.click(); });
    expect(installUpdateAndRestart).toHaveBeenCalledWith(
      'https://github.com/o8-run/o8/releases/tag/v0.1.811',
      expect.objectContaining({ selfUpdatable: false }),
    );
  });
});
