// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternalUrl, toDataURL } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(),
  toDataURL: vi.fn(async () => 'data:image/png;base64,QR'),
}));

vi.mock('@/lib/desktop/open-external', () => ({ openExternalUrl }));
vi.mock('qrcode', () => ({ toDataURL }));

import { LAN_ACCESS_OFF_MESSAGE, MobilePairingView } from './MobilePairingView';
import { IPHONE_APP_INSTALL_URL } from './mobile-app-link';

function pairingPayload() {
  return {
    v: 2,
    host: '10.0.0.5',
    hosts: ['10.0.0.5'],
    apiPort: 47100,
    wsPort: 47105,
    token: 'pairing-token',
  };
}

function findLink(container: HTMLElement, text: string): HTMLAnchorElement | undefined {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>('a'))
    .find((link) => link.textContent?.trim() === text);
}

describe('MobilePairingView — where to get the iPhone app', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    openExternalUrl.mockReset();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => pairingPayload(),
    })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('is the open-beta TestFlight link', () => {
    expect(IPHONE_APP_INSTALL_URL).toBe('https://testflight.apple.com/join/kp4RQG5Q');
  });

  it('offers the app next to the QR, with the href and the one-line instruction', async () => {
    await act(async () => {
      root.render(createElement(MobilePairingView));
    });

    const link = findLink(container, 'Get the iPhone app');
    expect(link).toBeDefined();
    expect(link?.getAttribute('href')).toBe(IPHONE_APP_INSTALL_URL);
    expect(container.textContent).toContain('Install TestFlight, join the beta, then scan this code.');
  });

  it('opens the link through the external-link helper instead of navigating the webview', async () => {
    await act(async () => {
      root.render(createElement(MobilePairingView));
    });

    const link = findLink(container, 'Get the iPhone app');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      link?.dispatchEvent(click);
    });

    // preventDefault means the webview never follows the href itself — the
    // Tauri shell opens it in the default browser (window.open is a no-op here).
    expect(click.defaultPrevented).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith(IPHONE_APP_INSTALL_URL);
  });
});

describe('MobilePairingView — loopback-only servers', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    toDataURL.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('explains the O8_LAN_ACCESS opt-in instead of showing an unreachable QR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...pairingPayload(), lanAccess: false }),
    })));
    await act(async () => {
      root.render(createElement(MobilePairingView));
    });

    expect(container.textContent).toContain(LAN_ACCESS_OFF_MESSAGE);
    expect(LAN_ACCESS_OFF_MESSAGE).toContain('O8_LAN_ACCESS=1');
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it('renders the QR when the operator opted in to LAN access', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ...pairingPayload(), lanAccess: true }),
    })));
    await act(async () => {
      root.render(createElement(MobilePairingView));
    });

    expect(container.textContent).not.toContain(LAN_ACCESS_OFF_MESSAGE);
    expect(toDataURL).toHaveBeenCalledTimes(1);
  });
});
