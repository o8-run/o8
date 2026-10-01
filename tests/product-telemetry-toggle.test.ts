import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
let operatorDefaultsRoute: typeof import('@/app/api/panel/operator-defaults/route') | undefined;
let telemetryRoute: typeof import('@/app/api/panel/telemetry/route');
let operatorDefaults: typeof import('@/lib/operator/defaults') | undefined;

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function resetProductTelemetry() {
  if (operatorDefaultsRoute) {
    const response = await operatorDefaultsRoute.POST(defaultsRequest({ productTelemetryEnabled: false }));
    expect(response.status).toBe(200);
  }
}

function readProductTelemetryInColdProcess(): string {
  return execFileSync(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    '--input-type=module',
    '--eval',
    [
      "const imported = await import('./src/lib/operator/defaults.ts');",
      'const defaults = imported.default ?? imported;',
      'process.stdout.write(String(defaults.resolveProductTelemetryEnabledSync()));',
    ].join(' '),
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_DATA_DIR: dataDir,
      O8_PROXY_URL: 'https://telemetry.example.test',
    },
    timeout: 5_000,
  }).trim();
}

function defaultsRequest(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function telemetryRequest(body: unknown): Request {
  return new Request('http://127.0.0.1/api/panel/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(os.tmpdir(), 'o8-product-telemetry-toggle-'));
  dataDir = join(home, '.o8');
  mkdirSync(dataDir, { recursive: true });
  process.env.HOME = home;
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  process.env.O8_DATA_DIR = dataDir;
  process.env.O8_PROXY_URL = 'https://telemetry.example.test';
  writeFileSync(join(dataDir, 'entitlement.json'), JSON.stringify({ licenseKey: 'header.payload.signature' }));

  operatorDefaultsRoute = await import('@/app/api/panel/operator-defaults/route');
  telemetryRoute = await import('@/app/api/panel/telemetry/route');
  operatorDefaults = await import('@/lib/operator/defaults');
});

afterEach(async () => {
  try {
    await resetProductTelemetry();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

afterAll(async () => {
  try {
    await resetProductTelemetry();
  } finally {
    restoreEnv();
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

describe.sequential('product telemetry persisted consent — real routes', () => {
  it('resolves unchosen usage on for missing or corrupt state and round-trips explicit choices', async () => {
    rmSync(join(dataDir, 'settings.toml'), { force: true });
    rmSync(join(dataDir, 'operator-defaults.json'), { force: true });
    expect(operatorDefaults!.resolveProductTelemetryEnabledSync()).toBe(true);

    writeFileSync(join(dataDir, 'operator-defaults.json'), '{corrupt');
    expect(operatorDefaults!.resolveProductTelemetryEnabledSync()).toBe(true);
    expect(await (await telemetryRoute.GET()).json()).toEqual({ enabled: false });

    const enabledResponse = await operatorDefaultsRoute!.POST(defaultsRequest({ productTelemetryEnabled: true }));
    const enabledBody = await enabledResponse.json();
    expect(enabledResponse.status).toBe(200);
    expect(enabledBody.values.productTelemetryEnabled).toBe(true);
    expect(enabledBody.sources.productTelemetryEnabled).toBe('file');
    expect(operatorDefaults!.resolveProductTelemetryEnabledSync()).toBe(true);

    const persisted = JSON.parse(readFileSync(join(dataDir, 'operator-defaults.json'), 'utf8')) as Record<string, unknown>;
    expect(persisted.productTelemetryEnabled).toBe(true);
    expect(readProductTelemetryInColdProcess()).toBe('true');
    expect(operatorDefaults!.resolveCrashReportsEnabledSync()).toBe(false);

    const disabledResponse = await operatorDefaultsRoute!.POST(defaultsRequest({ productTelemetryEnabled: false }));
    expect((await disabledResponse.json()).values.productTelemetryEnabled).toBe(false);
    expect(operatorDefaults!.resolveProductTelemetryEnabledSync()).toBe(false);
    expect(readProductTelemetryInColdProcess()).toBe('false');
  });

  it('blocks the panel route while off and emits only the allowlisted payload while on', async () => {
    await operatorDefaultsRoute!.POST(defaultsRequest({ productTelemetryEnabled: false }));
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const offResponse = await telemetryRoute.POST(telemetryRequest({ event: 'app.opened' }));
    expect(await offResponse.json()).toEqual({ ok: true, emitted: false });
    expect(fetchMock).not.toHaveBeenCalled();

    await operatorDefaultsRoute!.POST(defaultsRequest({ productTelemetryEnabled: true }));
    const onResponse = await telemetryRoute.POST(telemetryRequest({
      event: 'repo.added',
      props: {
        hasRemote: true,
        isGitRepo: true,
        repoName: 'private-repo',
        path: '/private/path',
        transcript: 'secret',
      },
    }));
    expect(await onResponse.json()).toEqual({ ok: true, emitted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://telemetry.example.test/v1/telemetry');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ event: 'repo.added', props: { hasRemote: true, isGitRepo: true } }),
    });

    const rejected = await telemetryRoute.POST(telemetryRequest({ event: 'repo.private-path', props: { path: '/secret' } }));
    expect(rejected.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
