import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: vi.fn(async () => ({ statuses: {}, suggestedSubscriptionProfile: {} })),
  getDispatchableRuntimeAvailability: vi.fn(async () => []),
}));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-concurrency-settings-'));
vi.stubEnv('CORTEX_IDE_DATA_DIR', dataDir);
vi.stubEnv('O8_DATA_DIR', dataDir);
vi.stubEnv('O8_MAX_PARALLEL_DISPATCHES', undefined);

const settingsRoute = await import('@/app/api/panel/operator-defaults/route');
const { getOperatorDefaultsSync, getOperatorDefaultsTomlState, updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { parseOperatorDefaultsToml } = await import('@/lib/settings/toml');
const { buildRemainingLaunchBudget } = await import('@/lib/orchestrator/scheduling');
const { createLane, updateLane } = await import('@/lib/lane/registry');
const { closeDb } = await import('@/lib/db');
const settingsPath = join(dataDir, 'settings.toml');

async function post(update: Record<string, unknown>) {
  return settingsRoute.POST(new Request('http://localhost/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  }));
}

beforeEach(() => {
  vi.stubEnv('O8_MAX_PARALLEL_DISPATCHES', undefined);
  rmSync(settingsPath, { force: true });
  rmSync(join(dataDir, 'operator-defaults.json'), { force: true });
});

afterAll(() => {
  closeDb();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('operator concurrency settings real path', () => {
  it('keeps the default at five and honors settings API values above 32', async () => {
    expect(getOperatorDefaultsSync().values.parallelCap).toBe(5);
    expect(buildRemainingLaunchBudget().maxLaunches).toBe(5);
    for (const parallelCap of [64, '96', Number.MAX_SAFE_INTEGER]) {
      const result = await post({ parallelCap });
      expect(result.status).toBe(200);
      expect((await result.json()).values.parallelCap).toBe(Number(parallelCap));
      expect(parseOperatorDefaultsToml(readFileSync(settingsPath, 'utf8')).parallelCap).toBe(Number(parallelCap));
      expect(getOperatorDefaultsSync().values.parallelCap).toBe(Number(parallelCap));
      expect(buildRemainingLaunchBudget().maxLaunches).toBe(Number(parallelCap));
    }
  });

  it('honors explicit legacy file and direct store updates above 32', async () => {
    writeFileSync(join(dataDir, 'operator-defaults.json'), JSON.stringify({ parallelCap: 64 }));
    expect(getOperatorDefaultsSync().values.parallelCap).toBe(64);
    await updateOperatorDefaults({ parallelCap: 96 });
    expect(getOperatorDefaultsSync().values.parallelCap).toBe(96);
    expect(parseOperatorDefaultsToml(readFileSync(settingsPath, 'utf8')).parallelCap).toBe(96);
  });

  it('persists a TOML edit through the settings API and scheduler read', async () => {
    const state = await getOperatorDefaultsTomlState();
    const result = await post({ settingsToml: '[operator]\nparallel_cap = 128\n', settingsTomlRevision: state.revision });
    expect(result.status).toBe(200);
    expect(parseOperatorDefaultsToml(readFileSync(settingsPath, 'utf8')).parallelCap).toBe(128);
    expect(getOperatorDefaultsSync().values.parallelCap).toBe(128);
    expect(buildRemainingLaunchBudget().maxLaunches).toBe(128);
  });

  it('advertises and persists concurrency above 32 through the MCP settings handler', async () => {
    const { STATUS_TOOLS, handleOperatorDefaults } = await import('@/lib/mcp/operator-handlers/status');
    const tool = STATUS_TOOLS.find((candidate) => candidate.name === 'o8_operator_defaults');
    expect(tool?.inputSchema.properties).toMatchObject({
      parallelCap: { type: 'number', description: expect.stringContaining('positive safe integer') },
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe('/api/panel/operator-defaults');
      return settingsRoute.POST(request);
    });
    try {
      const result = await handleOperatorDefaults({ parallelCap: 64 });
      expect(result.isError).not.toBe(true);
      expect(parseOperatorDefaultsToml(readFileSync(settingsPath, 'utf8')).parallelCap).toBe(64);
      expect(getOperatorDefaultsSync().values.parallelCap).toBe(64);
      expect(buildRemainingLaunchBudget().maxLaunches).toBe(64);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([0, -1, 1.5, '2.5', '64agents', '', null, true, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid API value %j without modifying persisted settings', async (parallelCap) => {
      await updateOperatorDefaults({ parallelCap: 7 });
      const before = readFileSync(settingsPath, 'utf8');
      const result = await post({ parallelCap, healBotEnabled: false });
      expect(result.status).toBe(400);
      expect(readFileSync(settingsPath, 'utf8')).toBe(before);
      expect(getOperatorDefaultsSync().values.parallelCap).toBe(7);
    },
  );

  it('rejects invalid direct updates, legacy values, TOML edits, and environment overrides consistently', async () => {
    for (const parallelCap of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      await expect(updateOperatorDefaults({ parallelCap })).rejects.toThrow(/positive.*integer/);
      writeFileSync(join(dataDir, 'operator-defaults.json'), JSON.stringify({ parallelCap }));
      expect(getOperatorDefaultsSync().values.parallelCap).toBe(5);
    }
    await updateOperatorDefaults({ parallelCap: 64 });
    const before = readFileSync(settingsPath, 'utf8');
    for (const raw of ['0', '-1', '1.5', '9007199254740992']) {
      const state = await getOperatorDefaultsTomlState();
      const result = await post({ settingsToml: `[operator]\nparallel_cap = ${raw}\n`, settingsTomlRevision: state.revision });
      expect(result.status).toBe(400);
      expect(readFileSync(settingsPath, 'utf8')).toBe(before);
    }
    for (const raw of ['0', '-1', '1.5', '64agents', '9007199254740992', 'Infinity']) {
      vi.stubEnv('O8_MAX_PARALLEL_DISPATCHES', raw);
      expect(getOperatorDefaultsSync()).toMatchObject({ values: { parallelCap: 64 }, sources: { parallelCap: 'file' } });
    }
    vi.stubEnv('O8_MAX_PARALLEL_DISPATCHES', '96');
    expect(getOperatorDefaultsSync()).toMatchObject({ values: { parallelCap: 96 }, sources: { parallelCap: 'env' } });
    expect(buildRemainingLaunchBudget().maxLaunches).toBe(96);
    expect(readFileSync(settingsPath, 'utf8')).toBe(before);
  });

  it('subtracts persisted running and launching lanes', async () => {
    await updateOperatorDefaults({ parallelCap: 64 });
    for (const [index, status] of (['running', 'launching', 'idle'] as const).entries()) {
      const lane = createLane({ repoPath: dataDir, branch: `worker-${index}`, runtime: 'antigravity', baseCommit: 'a'.repeat(40) });
      updateLane(lane.id, { status });
    }
    expect(buildRemainingLaunchBudget()).toMatchObject({ maxLaunches: 62 });
    await updateOperatorDefaults({ parallelCap: 1 });
    expect(buildRemainingLaunchBudget().maxLaunches).toBe(0);
  });
});
