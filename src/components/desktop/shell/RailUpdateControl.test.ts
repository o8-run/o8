// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/components/shared/ConfirmToastHost', () => ({ toast: vi.fn() }));

const { RailUpdateControl, describeUpdateProgress, panelPosition, sameNote } = await import('./RailUpdateControl');
const { publishAppUpdateView } = await import('@/lib/app-update/update-hub-client');

afterEach(() => { vi.unstubAllGlobals(); });

const baseView = { version: '0.1.796', currentVersion: '0.1.795', outcome: 'available' as const, installing: false,
  message: null, error: null, downloadOnly: false };

async function openPanel() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/setup/cli-updates')
    ? Response.json({ tools: [] })
    : Response.json({ source: 'release', entries: [{ text: 'feat: faster startup' }, { text: 'fix: fewer crashes' }],
      overview: 'Faster startup', summary: 'Faster startup' })));
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(RailUpdateControl, { buttonStyle: {} })));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Updates"]')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
  const panel = () => document.querySelector('[aria-label="Updates and release notes"]')!;
  return { host, root, panel };
}

it('shows installed and available versions, download progress, and the release notes once', async () => {
  publishAppUpdateView({ ...baseView, installing: true, progress: { stage: 'downloading', receivedBytes: 10 * 1_048_576, totalBytes: 40 * 1_048_576 } });
  const { host, root, panel } = await openPanel();
  try {
    expect(panel().textContent).toContain('o8 0.1.795 → 0.1.796');
    const bar = panel().querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(bar.textContent).toContain('Downloading 10 of 40 MB (25%)');
    // The overview repeats the first bullet, so it is shown once.
    expect(panel().textContent?.match(/faster startup/gi)).toHaveLength(1);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it('names waiting tasks and keeps explicit restart accessible with cached running work', async () => {
  publishAppUpdateView({ ...baseView, message: 'Update installed. Restart now to apply it. Waiting tasks keep their state.',
    blockers: { live: [], parked: ['Fix the login form (waiting for review)'] } });
  const { host, root, panel } = await openPanel();
  const restart = vi.fn(); window.addEventListener('o8:restart-app-update', restart);
  try {
    expect(panel().textContent).toContain('Fix the login form (waiting for review)');
    expect(panel().textContent).not.toContain('Update o8');
    await act(async () => [...panel().querySelectorAll('button')].find(button => button.textContent === 'Restart now')!.click());
    expect(restart).toHaveBeenCalledOnce();

    await act(async () => publishAppUpdateView({ ...baseView, message: 'Update installed. Restart is waiting for running work to finish.',
      blockers: { live: ['Build the release (running)'], parked: ['Fix the login form (waiting for review)'] } }));
    expect(panel().textContent).toContain('Work to check before restarting:');
    expect(panel().textContent).toContain('Build the release (running)');
    await act(async () => [...panel().querySelectorAll('button')].find(button => button.textContent === 'Restart anyway')!.click());
    expect(restart).toHaveBeenCalledTimes(2);
  } finally {
    window.removeEventListener('o8:restart-app-update', restart);
    await act(async () => root.unmount()); host.remove();
  }
});

it('keeps the panel inside a short window', () => {
  // A trigger near the top of a 300 px window leaves about 100 px above its bottom edge.
  const position = panelPosition({ right: 60, bottom: 112 }, { width: 1200, height: 300 });
  expect(position.bottom).toBe(188);
  expect(position.maxHeight).toBe(160);
  expect(panelPosition({ right: 60, bottom: 860 }, { width: 1200, height: 900 }).maxHeight).toBe(540);
});

it('describes each update stage', () => {
  expect(describeUpdateProgress({ stage: 'downloading', receivedBytes: 0, totalBytes: null }).label).toBe('Starting download…');
  expect(describeUpdateProgress({ stage: 'downloading', receivedBytes: 3 * 1_048_576, totalBytes: null })).toEqual({ label: 'Downloading 3.0 MB…', fraction: null });
  expect(describeUpdateProgress({ stage: 'installing', receivedBytes: 1, totalBytes: 1 }).label).toBe('Installing o8…');
  expect(describeUpdateProgress({ stage: 'restarting', receivedBytes: 1, totalBytes: 1 }).label).toBe('Restarting o8…');
  expect(sameNote('Faster startup', 'feat: faster startup')).toBe(true);
  expect(sameNote('Faster startup', 'fix: fewer crashes')).toBe(false);
});

it('uses the release-page action for a package-managed install in the compact rail', async () => {
  publishAppUpdateView({ ...baseView, downloadOnly: true, packageManager: true });
  const { host, root, panel } = await openPanel();
  const install = vi.fn(); window.addEventListener('o8:install-app-update', install);
  try {
    const action = [...panel().querySelectorAll('button')].find(button => button.textContent === 'Release page');
    expect(action).toBeDefined();
    expect(panel().textContent).not.toContain('Download o8');
    await act(async () => action!.click());
    expect(install).toHaveBeenCalledOnce();
  } finally {
    window.removeEventListener('o8:install-app-update', install);
    await act(async () => root.unmount()); host.remove();
  }
});
