import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
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
  it('projects the actual composer menu and valid defaults', async () => {
    const response = await GET(request(operator));
    const catalog = await response.json();
    expect(catalog.version).toBe(1);
    for (const agent of catalog.agents) {
      expect(agent.models.map((model: { id: string }) => model.id)).toContain(agent.defaultModel);
      expect(agent.models.map((model: { id: string; label: string }) => [model.id, model.label]))
        .toEqual(agent.id === 'claude' ? ORCHESTRATOR_MODEL_OPTIONS.map(option => [option.value, option.label]) : CODEX_MODEL_IDS.map(id => [id, formatModelLabel(id)]));
      for (const model of agent.models) if (model.defaultEffort !== null) expect(model.efforts).toContain(model.defaultEffort);
    }
    expect(mobileModelError('codex', 'gpt-6.1-sol')).toBeNull();
    expect(mobileModelError('codex', 'unknown-model')).toContain('Unknown model');
  });
});
