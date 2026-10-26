// @vitest-environment jsdom

/**
 * The pre-paint stamp and ThemeProvider resolve the same thing twice, in two languages.
 * Divergence is invisible in review and shows up as a wrong-coloured flash before
 * hydration — the exact class the layout's warning comment was written about. These
 * cases run the real script string the layout injects.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { PRE_PAINT_THEME_STAMP } from './pre-paint-stamp';

function runStamp(): void {
  new Function(PRE_PAINT_THEME_STAMP)();
}

function markWebMachine(): void {
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'o8-auth-mode');
  meta.setAttribute('content', 'web-machine');
  document.head.appendChild(meta);
}

/** Mirrors the Rust initialization script's __O8_HOST_PLATFORM__ stamp (#1743). */
function stampHostPlatform(os: string): void {
  (window as unknown as { __O8_HOST_PLATFORM__?: string }).__O8_HOST_PLATFORM__ = os;
}

/** Mirrors the Rust initialization script's __O8_LINUX_GLASS__ stamp (O8_LINUX_GLASS=1). */
function stampLinuxGlass(enabled: boolean): void {
  (window as unknown as { __O8_LINUX_GLASS__?: boolean }).__O8_LINUX_GLASS__ = enabled;
}

describe('pre-paint theme stamp', () => {
  beforeEach(() => {
    localStorage.clear();
    delete (window as unknown as { __O8_HOST_PLATFORM__?: string }).__O8_HOST_PLATFORM__;
    delete (window as unknown as { __O8_LINUX_GLASS__?: boolean }).__O8_LINUX_GLASS__;
    document.documentElement.removeAttribute('data-linux-glass');
    document.head.querySelectorAll('meta').forEach((meta) => meta.remove());
    for (const attribute of ['theme', 'palette', 'surface']) {
      document.documentElement.removeAttribute(`data-${attribute}`);
    }
    document.documentElement.style.removeProperty('--o8-boot-cover-bg');
  });

  it('pins solid and keeps the stored palette when the page is relayed to a browser', () => {
    localStorage.setItem('cortex-theme-palette', 'light');
    localStorage.setItem('cortex-reduce-transparency', 'off');
    localStorage.setItem('cortex-workspace-glass', 'true');
    markWebMachine();

    runStamp();

    // Matches ThemeProvider: forceSolid wins, All Glass is ignored, palette survives.
    expect(document.documentElement.dataset.surface).toBe('solid');
    expect(document.documentElement.dataset.palette).toBe('light');
    expect(localStorage.getItem('cortex-workspace-glass')).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--o8-boot-cover-bg')).toBe('#F4F2ED');
  });

  it('still paints dark glass for All Glass on the machine itself', () => {
    localStorage.setItem('cortex-theme-palette', 'light');
    localStorage.setItem('cortex-workspace-glass', 'true');

    runStamp();

    expect(document.documentElement.dataset.surface).toBe('glass');
    expect(document.documentElement.dataset.palette).toBe('dark');
  });

  it('honours a stored glass preference locally', () => {
    localStorage.setItem('cortex-theme-palette', 'dark');
    localStorage.setItem('cortex-reduce-transparency', 'off');

    runStamp();

    expect(document.documentElement.dataset.surface).toBe('glass');
    expect(document.documentElement.dataset.palette).toBe('dark');
  });

  it('pins solid on a Windows shell, where no vibrancy material exists (#1743)', () => {
    localStorage.setItem('cortex-theme-palette', 'dark');
    localStorage.setItem('cortex-reduce-transparency', 'off');
    localStorage.setItem('cortex-workspace-glass', 'true');
    stampHostPlatform('windows');

    runStamp();

    expect(document.documentElement.dataset.surface).toBe('solid');
    expect(document.documentElement.dataset.palette).toBe('dark');
    expect(localStorage.getItem('cortex-workspace-glass')).toBe('true');
  });

  it('pins solid on a Linux shell too', () => {
    localStorage.setItem('cortex-theme-palette', 'light');
    localStorage.setItem('cortex-reduce-transparency', 'off');
    stampHostPlatform('linux');

    runStamp();

    expect(document.documentElement.dataset.surface).toBe('solid');
    expect(document.documentElement.dataset.palette).toBe('light');
  });

  it('paints dark All Glass on a Linux shell launched with O8_LINUX_GLASS=1', () => {
    stampHostPlatform('linux');
    stampLinuxGlass(true);

    runStamp();

    expect(document.documentElement.dataset.surface).toBe('glass');
    expect(document.documentElement.dataset.palette).toBe('dark');
    expect(document.documentElement.dataset.linuxGlass).toBe('true');
    expect(document.documentElement.style.getPropertyValue('--o8-boot-cover-bg')).toContain('linear-gradient');
  });

  it('keeps a stored All Glass opt-out on an opted-in Linux shell', () => {
    stampHostPlatform('linux');
    stampLinuxGlass(true);
    localStorage.setItem('cortex-workspace-glass', 'false');

    runStamp();

    expect(document.documentElement.dataset.surface).toBe('solid');
    expect(localStorage.getItem('cortex-workspace-glass')).toBe('false');
  });

  it('ignores the Linux glass flag on a Windows shell', () => {
    stampHostPlatform('windows');
    stampLinuxGlass(true);
    localStorage.setItem('cortex-reduce-transparency', 'off');

    runStamp();

    expect(document.documentElement.dataset.surface).toBe('solid');
    expect(document.documentElement.dataset.linuxGlass).toBeUndefined();
  });

  it('leaves the macOS shell stamp on the glass path', () => {
    localStorage.setItem('cortex-theme-palette', 'dark');
    localStorage.setItem('cortex-reduce-transparency', 'off');
    stampHostPlatform('macos');

    runStamp();

    expect(document.documentElement.dataset.surface).toBe('glass');
  });

  it('defaults a first-run visitor to light solid', () => {
    runStamp();

    expect(document.documentElement.dataset.palette).toBe('light');
    expect(document.documentElement.dataset.surface).toBe('solid');
  });

  it('starts a fresh macOS shell in dark All Glass without a light first frame', () => {
    stampHostPlatform('macos');
    runStamp();
    expect(document.documentElement.dataset.palette).toBe('dark');
    expect(document.documentElement.dataset.surface).toBe('glass');
    expect(document.documentElement.style.getPropertyValue('--o8-boot-cover-bg')).toContain('linear-gradient');
  });

  it.each([
    ['cortex-workspace-glass', 'false'],
    ['cortex-reduce-transparency', 'on'],
    ['cortex-theme-palette', 'light'],
    ['cortex-theme', 'light'],
  ])('keeps an existing macOS preference: %s', (key, value) => {
    stampHostPlatform('macos');
    localStorage.setItem(key, value);
    runStamp();
    expect(document.documentElement.dataset.surface).toBe(key === 'cortex-theme-palette' || key === 'cortex-theme' ? 'glass' : 'solid');
    if (value === 'light') expect(document.documentElement.dataset.palette).toBe('light');
    expect(localStorage.getItem(key)).toBe(value);
  });

  it('keeps a fresh browser relay solid even when the host is macOS', () => {
    stampHostPlatform('macos');
    markWebMachine();
    runStamp();
    expect(document.documentElement.dataset.surface).toBe('solid');
  });
});
