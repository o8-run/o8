import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { MODEL_IDS } from '@/lib/models';
import { serializeOperatorDefaultsToml } from '@/lib/settings/toml';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-runtime-inventory-route-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const availability = [{
  id: 'claude-code',
  label: 'Claude Code',
  available: false,
  unavailableReason: 'needs_auth',
  detail: 'Claude Code CLI is installed but not signed in.',
  fix: 'Run `claude` once to sign in.',
}];

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: vi.fn(async () => ({
    statuses: {},
    suggestedSubscriptionProfile: { profile: null, detail: null },
  })),
  getDispatchableRuntimeAvailability: vi.fn(async () => availability),
}));

const operatorDefaultsRoute = await import('@/app/api/panel/operator-defaults/route');

it.each(['fields', 'toml'])('acknowledges persisted native %s without waiting for unused runtime inventory', async (kind) => {
  const { getRuntimeAuthSnapshot, getDispatchableRuntimeAvailability } = await import('@/lib/runtimes/shared/auth-detect');
  const snapshot = vi.mocked(getRuntimeAuthSnapshot);
  const originalSnapshot = snapshot.getMockImplementation()!;
  const inventory = vi.mocked(getDispatchableRuntimeAvailability);
  const read = async () => (await operatorDefaultsRoute.GET(
    new Request('http://localhost/api/panel/operator-defaults?include=native'),
  )).json();
  const before = await read();
  const parallelCap = kind === 'fields' ? 3 : 6;
  snapshot.mockClear();
  inventory.mockClear();
  snapshot.mockImplementationOnce(async () => { throw new Error('Runtime inventory unavailable'); });
  try {
    const saved = await operatorDefaultsRoute.POST(new Request('http://localhost/api/panel/operator-defaults?include=native', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        settingsTomlRevision: before.settingsToml.revision,
        ...(kind === 'fields' ? { parallelCap } : { settingsToml: `[operator]\nparallel_cap = ${parallelCap}\n` }),
      }),
    }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true });
    expect((await read()).values.parallelCap).toBe(parallelCap);
    expect(snapshot).not.toHaveBeenCalled();
    expect(inventory).not.toHaveBeenCalled();
  } finally {
    snapshot.mockReset().mockImplementation(originalSnapshot);
  }
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('operator-defaults dispatchable runtime inventory', () => {
  it('persists non-funded stability toggles without a license', async () => {
    for (const enabled of [false, true, false]) {
      const values = {
        experimentalCanvas: enabled,
        experimentalGemini: enabled,
        experimentalOpencode: enabled,
        nativeBrowserView: enabled,
      };
      const response = await operatorDefaultsRoute.POST(new Request('http://localhost/api/panel/operator-defaults', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      }));
      expect(response.status).toBe(200);
      const read = await operatorDefaultsRoute.GET(new Request('http://localhost/api/panel/operator-defaults?include=values'));
      expect(await read.json()).toMatchObject({
        values,
        sources: { experimentalCanvas: 'file', experimentalGemini: 'file', experimentalOpencode: 'file', nativeBrowserView: 'file' },
      });
    }
  });

  it('defaults explainers off and persists both positions of the existing toggle', async () => {
    const read = async () => (await operatorDefaultsRoute.GET(
      new Request('http://127.0.0.1/api/panel/operator-defaults'),
    )).json();
    expect((await read()).values.packetExplainerEnabled).toBe(false);
    for (const enabled of [true, false]) {
      const response = await operatorDefaultsRoute.POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packetExplainerEnabled: enabled }),
      }));
      expect(response.status).toBe(200);
      const persisted = await read();
      expect(persisted.values.packetExplainerEnabled).toBe(enabled);
      expect(persisted.values.quizGateEnabled).toBe(false);
    }
  });
  it('exposes runtime id, label, and structured availability through the existing read route', async () => {
    const response = await operatorDefaultsRoute.GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      dispatchableRuntimes: availability,
      roleRoutes: [
        { id: 'orchestrate' },
        { id: 'build' },
        { id: 'review' },
        { id: 'brain' },
        { id: 'triage' },
        { id: 'recovery' },
      ],
      recentRoleReceipts: expect.any(Array),
    });
  });

  it('rejects an incompatible worker runtime and model before persistence', async () => {
    const response = await operatorDefaultsRoute.POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultDispatchRuntime: 'codex',
        defaultDispatchModel: MODEL_IDS.orchestratorDefault,
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('not compatible with Codex'),
    });

    const persisted = await operatorDefaultsRoute.GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    await expect(persisted.json()).resolves.toMatchObject({
      values: { defaultDispatchModel: '' },
    });
  });

  it('applies the same compatibility guard to direct settings.toml saves', async () => {
    const { getOrCreateWsToken } = await import('@/lib/ws-auth');
    const before = await operatorDefaultsRoute.GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    const payload = await before.json();
    const response = await operatorDefaultsRoute.POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getOrCreateWsToken()}` },
      body: JSON.stringify({
        settingsToml: serializeOperatorDefaultsToml({
          ...payload.values,
          defaultDispatchRuntime: 'codex',
          defaultDispatchModel: MODEL_IDS.orchestratorDefault,
        }),
        settingsTomlRevision: payload.settingsToml.revision,
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('not compatible with Codex'),
    });
  });

  it('names the subscription profile as the source of constrained routes', async () => {
    const response = await operatorDefaultsRoute.POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionProfile: 'codex-only' }),
    }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      sources: {
        orchestratorBackend: 'profile',
        defaultDispatchRuntime: 'profile',
        reviewerBackend: 'profile',
      },
    });
    expect(payload.roleRoutes.find((item: { id: string }) => item.id === 'orchestrate')).toMatchObject({
      sources: { backend: 'profile' },
    });
    expect(payload.roleRoutes.find((item: { id: string }) => item.id === 'build')).toMatchObject({
      sources: { runtime: 'profile' },
    });
    expect(payload.roleRoutes.find((item: { id: string }) => item.id === 'review')).toMatchObject({
      sources: { backend: 'profile' },
    });

    const restore = await operatorDefaultsRoute.POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionProfile: 'both' }),
    }));
    expect(restore.status).toBe(200);
  });

  it.each(['claude-opus-5-5', 'claude-fable-5-1'])('persists %s with Sonnet workers through the settings route', async (model) => {
    const response = await operatorDefaultsRoute.POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orchestratorBackend: 'claude', orchestratorModel: model,
        defaultDispatchRuntime: 'claude-code', defaultDispatchModel: 'claude-sonnet-5', workerRuntimes: ['claude-code'] }),
    }));
    expect(response.status).toBe(200);
    const persisted = await operatorDefaultsRoute.GET(new Request('http://127.0.0.1/api/panel/operator-defaults'));
    await expect(persisted.json()).resolves.toMatchObject({ values: {
      orchestratorBackend: 'claude', orchestratorModel: model,
      defaultDispatchRuntime: 'claude-code', defaultDispatchModel: 'claude-sonnet-5', workerRuntimes: ['claude-code'],
    } });
  });
});
