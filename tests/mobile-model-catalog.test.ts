import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
// Keep account discovery on fixture-owned state, including when the runner has
// an account cache in CODEX_HOME or its normal home directory.
const codexHome = mkdtempSync(join(getDataDir(), 'phone-model-catalog-'));
const modelCache = join(codexHome, 'models_cache.json');
vi.stubEnv('CODEX_HOME', codexHome);

beforeEach(() => rmSync(modelCache, { force: true }));
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(codexHome, { recursive: true, force: true });
});

const operator = randomBytes(32).toString('hex');
const worker = randomBytes(32).toString('hex');
const device = randomBytes(32).toString('hex');
writeFileSync(join(getDataDir(), 'ws-token'), operator);
writeFileSync(join(getDataDir(), 'worker-token'), worker);
writeFileSync(join(getDataDir(), 'mobile-device-tokens'), createHash('sha256').update(device).digest('hex') + '\n');
const { GET } = await import('@/app/api/mobile/orchestrator/models/route');
const request = (token?: string) => new Request('http://localhost/api/mobile/orchestrator/models', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
import { ORCHESTRATOR_MODEL_OPTIONS } from '@/lib/operator/default-options';
import { CODEX_MODEL_IDS } from '@/lib/models';
import { formatModelLabel } from '@/lib/format';
import { mobileModelError } from '@/lib/mobile/model-catalog';

describe('phone model discovery route', () => {
  it('admits operator and enrolled device, refuses worker and missing credentials', async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request(worker))).status).toBe(403);
    expect((await GET(request(operator))).status).toBe(200);
    expect((await GET(request(device))).status).toBe(200);
  });
  it.each([
    { name: 'missing cache', cachedModels: null, expectedCodexModels: CODEX_MODEL_IDS },
    { name: 'empty cache', cachedModels: [], expectedCodexModels: CODEX_MODEL_IDS },
    { name: 'unrecognized cache', cachedModels: [{ slug: 'unknown-model' }], expectedCodexModels: CODEX_MODEL_IDS },
    {
      name: 'restricted account',
      cachedModels: [{ slug: 'gpt-5.6-sol' }, { slug: 'unknown-model' }],
      expectedCodexModels: ['gpt-5.6-sol'],
    },
  ])('projects the actual composer menu and valid defaults with $name', async ({ cachedModels, expectedCodexModels }) => {
    if (cachedModels !== null) writeFileSync(modelCache, JSON.stringify({ models: cachedModels }));
    for (const token of [operator, device]) {
      const response = await GET(request(token));
      expect(response.status).toBe(200);
      const catalog = await response.json();
      expect(catalog.version).toBe(1);
      expect(catalog.agents.map((agent: { id: string }) => agent.id)).toEqual(['claude', 'codex']);
      for (const agent of catalog.agents) {
        expect(agent.models.map((model: { id: string }) => model.id)).toContain(agent.defaultModel);
        expect(agent.models.map((model: { id: string; label: string }) => [model.id, model.label]))
          .toEqual(agent.id === 'claude' ? ORCHESTRATOR_MODEL_OPTIONS.map(option => [option.value, option.label]) : expectedCodexModels.map(id => [id, formatModelLabel(id)]));
        for (const model of agent.models) if (model.defaultEffort !== null) expect(model.efforts).toContain(model.defaultEffort);
      }
    }
    expect(mobileModelError('codex', expectedCodexModels[0])).toBeNull();
    if (!expectedCodexModels.includes('gpt-6.1-sol')) {
      expect(mobileModelError('codex', 'gpt-6.1-sol')).toContain('Unknown model');
    }
    expect(mobileModelError('codex', 'unknown-model')).toContain('Unknown model');
  });
});
