// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { isLinuxGlassShell, isNonMacShell, shellLacksGlass } from './host-platform';

type Stamps = { __O8_HOST_PLATFORM__?: string; __O8_LINUX_GLASS__?: boolean };

function stamp(os?: string, linuxGlass?: boolean): void {
  const w = window as unknown as Stamps;
  if (os === undefined) delete w.__O8_HOST_PLATFORM__; else w.__O8_HOST_PLATFORM__ = os;
  if (linuxGlass === undefined) delete w.__O8_LINUX_GLASS__; else w.__O8_LINUX_GLASS__ = linuxGlass;
}

describe('host platform glass capability', () => {
  afterEach(() => stamp());

  it.each([
    [undefined, undefined, false, false, false],
    ['macos', undefined, false, false, false],
    ['macos', true, false, false, false],
    ['windows', true, true, false, true],
    ['linux', undefined, true, false, true],
    ['linux', false, true, false, true],
    ['linux', true, true, true, false],
  ] as const)('os=%s linuxGlass=%s', (os, linuxGlass, nonMac, glassShell, lacksGlass) => {
    stamp(os, linuxGlass);
    expect(isNonMacShell()).toBe(nonMac);
    expect(isLinuxGlassShell()).toBe(glassShell);
    expect(shellLacksGlass()).toBe(lacksGlass);
  });
});
