import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const originalEnv = {
  HOME: process.env.HOME,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  O8_PROXY_URL: process.env.O8_PROXY_URL,
};

let home = '';
let dataDir = '';
let operatorDefaults: typeof import('@/lib/operator/defaults') | undefined;
let repoRegistry: typeof import('@/lib/repos/registry');
let laneRegistry: typeof import('@/lib/lane/registry');
let laneLaunch: typeof import('@/lib/lane/commands-launch');
let runtimeActions: typeof import('@/lib/runtime/actions');

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function makeRepo(name: string): string {
  const repoPath = mkdtempSync(join(home, `${name}-`));
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  return repoPath;
}

function telemetryCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/v1/telemetry'));
}

beforeAll(async () => {
  home = mkdtempSync(join(os.tmpdir(), 'o8-product-telemetry-entry-'));
  dataDir = join(home, '.o8');
  mkdirSync(dataDir, { recursive: true });
  process.env.HOME = home;
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  process.env.O8_DATA_DIR = dataDir;
  process.env.O8_PROXY_URL = 'https://telemetry.example.test';
  writeFileSync(join(dataDir, 'entitlement.json'), JSON.stringify({ licenseKey: 'header.payload.signature' }));

  operatorDefaults = await import('@/lib/operator/defaults');
  repoRegistry = await import('@/lib/repos/registry');
  laneRegistry = await import('@/lib/lane/registry');
  laneLaunch = await import('@/lib/lane/commands-launch');
  runtimeActions = await import('@/lib/runtime/actions');
});

afterEach(async () => {
  try {
    if (operatorDefaults) {
      await operatorDefaults.updateOperatorDefaults({ productTelemetryEnabled: false });
    }
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

afterAll(async () => {
  try {
    if (operatorDefaults) {
      await operatorDefaults.updateOperatorDefaults({ productTelemetryEnabled: false });
    }
  } finally {
    restoreEnv();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

describe.sequential('product telemetry gates real entry points', () => {
  it('repo registration emits nothing while off and one allowlisted event while on', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await operatorDefaults!.updateOperatorDefaults({ productTelemetryEnabled: false });
    await repoRegistry.addRepo(makeRepo('repo-off'));
    expect(telemetryCalls(fetchMock)).toHaveLength(0);

    await operatorDefaults!.updateOperatorDefaults({
      productTelemetryEnabled: true, crashReportsEnabled: false, telemetryConsentAnswered: true,
    });
    await repoRegistry.addRepo(makeRepo('repo-on'));
    expect(telemetryCalls(fetchMock)).toHaveLength(1);
    expect(telemetryCalls(fetchMock)[0]?.[1]).toMatchObject({
      body: JSON.stringify({ event: 'repo.added', props: { hasRemote: false, isGitRepo: true } }),
    });
  });

  it('dispatch launch emits nothing while off and one allowlisted event while on', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const launchSpy = vi.spyOn(runtimeActions, 'launchRuntimeSurface').mockImplementation(async (input) => ({
      ok: true,
      runtime: input.runtime,
      surfaceId: `codex-owned:${input.existingLaneId ?? 'telemetry'}`,
      note: 'launched',
      cwd: input.repoPath ?? home,
      repoPath: input.repoPath ?? home,
      worktree: null,
      laneId: input.existingLaneId ?? null,
    }));

    const launch = async (suffix: string) => {
      const repoPath = makeRepo(`dispatch-${suffix}`);
      const lane = laneRegistry.createLane({
        repoPath,
        branch: `inline/telemetry-${suffix}`,
        baseBranch: 'main',
        runtime: 'codex',
      });
      const result = await laneLaunch.launchSession({
        verb: 'launch_session',
        laneId: lane.id,
        prompt: 'bounded test prompt',
      }, 'system');
      expect(result.ok).toBe(true);
    };

    await operatorDefaults!.updateOperatorDefaults({ productTelemetryEnabled: false });
    await launch('off');
    expect(telemetryCalls(fetchMock)).toHaveLength(0);

    await operatorDefaults!.updateOperatorDefaults({
      productTelemetryEnabled: true, crashReportsEnabled: false, telemetryConsentAnswered: true,
    });
    await launch('on');
    expect(telemetryCalls(fetchMock)).toHaveLength(1);
    expect(telemetryCalls(fetchMock)[0]?.[1]).toMatchObject({
      body: JSON.stringify({ event: 'dispatch.started', props: { runtime: 'codex' } }),
    });
    expect(launchSpy).toHaveBeenCalledTimes(2);
  });
});
