import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dataDir: string;
let originalDataDir: string | undefined;
let originalPlan: string | undefined;
let originalProxyUrl: string | undefined;

async function bootstrapEntitlement() {
  const { ensureFreeEntitlement } = await import('@/lib/entitlement/bootstrap');
  const { getEntitlement } = await import('@/lib/entitlement/store');
  await ensureFreeEntitlement();
  return getEntitlement();
}

describe('entitlement bootstrap default-free path', () => {
  beforeEach(() => {
    vi.resetModules();
    originalDataDir = process.env.CORTEX_IDE_DATA_DIR;
    originalPlan = process.env.O8_PLAN;
    originalProxyUrl = process.env.O8_PROXY_URL;
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-entitlement-bootstrap-'));
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    delete process.env.O8_PLAN;
    delete process.env.O8_PROXY_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
    else process.env.CORTEX_IDE_DATA_DIR = originalDataDir;
    if (originalPlan === undefined) delete process.env.O8_PLAN;
    else process.env.O8_PLAN = originalPlan;
    if (originalProxyUrl === undefined) delete process.env.O8_PROXY_URL;
    else process.env.O8_PROXY_URL = originalProxyUrl;
  });

  it('fresh install with no env contacts the DEFAULT hosted service for its free token, fail-soft', async () => {
    // Free-without-sign-in ruling 2026-08-06: an unset O8_PROXY_URL now means
    // "use the public default", so a zero-setup install can mint the anonymous
    // free-allowance token. Network failure stays fail-soft → plan free.
    const fetchMock = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);

    const state = await bootstrapEntitlement();

    expect(state).toMatchObject({
      plan: 'free',
      actualPlan: 'free',
      source: 'default',
      overrideActive: false,
      flags: {
        'proxy.inference': false,
        'relay.offNetwork': false,
        'team.shared': false,
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const firstCallUrl = (fetchMock.mock.calls as unknown[][])[0]?.[0];
    expect(String(firstCallUrl)).toBe('https://api.o8.run/issue-free');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('O8_PROXY_URL=off keeps the pure-BYO build fully offline', async () => {
    process.env.O8_PROXY_URL = 'off';
    vi.resetModules();
    const fetchMock = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);

    const state = await bootstrapEntitlement();

    expect(state.plan).toBe('free');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('keeps a configured but unreachable server bounded and avoids retry storms', async () => {
    process.env.O8_PROXY_URL = 'https://license.invalid';
    vi.resetModules();
    const fetchMock = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);

    const firstState = await bootstrapEntitlement();
    const secondState = await bootstrapEntitlement();

    expect(firstState.plan).toBe('free');
    expect(secondState.plan).toBe('free');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      '[entitlement] License server unavailable; using free plan.',
    );
  });

  it('lets a user-initiated hosted operation authenticate even when O8_PLAN owns local plan resolution', async () => {
    process.env.O8_PLAN = 'founder';
    vi.resetModules();
    const fetchMock = vi.fn(async () => {
      throw new Error('network unavailable');
    });
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.stubGlobal('fetch', fetchMock);

    const { ensureFreeEntitlement } = await import('@/lib/entitlement/bootstrap');
    await ensureFreeEntitlement();
    expect(fetchMock, 'the ordinary env-pinned path stays offline').not.toHaveBeenCalled();

    await ensureFreeEntitlement({ allowPinnedPlan: true });
    expect(fetchMock, 'explicit hosted authentication may provision an install credential').toHaveBeenCalledOnce();
  });
});
