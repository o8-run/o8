import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  defaults: { values: { workerRuntimes: ['codex', 'claude-code', '3code'], defaultDispatchRuntime: 'codex', subscriptionProfile: 'both', defaultDispatchModel: 'gpt-5.6-terra', codexWorkerEffort: 'adaptive', claudeWorkerEffort: 'adaptive' }, sources: { workerRuntimes: 'file' } },
  preflight: vi.fn(async () => {}),
}));
vi.mock('@/lib/operator/defaults', () => ({ getOperatorDefaultsSync: () => mocks.defaults }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({ assertRuntimeDispatchable: mocks.preflight }));
vi.mock('./worker-catalog', () => ({
  configuredWorkerPool: () => mocks.defaults.values.workerRuntimes,
  workerModelCatalog: async (runtime: string) => ({
    models: (runtime === 'codex' ? ['gpt-5.6-terra'] : runtime === '3code' ? ['provider.model'] : ['claude-sonnet-5']).map(id => ({ id })),
    defaultModel: runtime === 'codex' ? 'gpt-5.6-terra' : runtime === '3code' ? 'provider.model' : 'claude-sonnet-5',
    carrier: runtime === 'claude-code' ? 'native' : null,
    source: 'fixture',
  }),
}));
import { resolveDelegationSelection } from './delegation-selection';

describe('task-specific worker selection', () => {
  it('honors a different configured runtime without changing saved defaults', async () => {
    const before = JSON.stringify(mocks.defaults);
    const choice = await resolveDelegationSelection({ runtime: 'claude-code', model: 'claude-sonnet-5', requestedEffort: 'high' }, '/repo');
    expect(choice.routing).toMatchObject({ selectedRuntime: 'claude-code', selectedModel: 'claude-sonnet-5', selectedEffort: 'high' });
    expect(JSON.stringify(mocks.defaults)).toBe(before);
  });
  it('preserves an explicit adaptive reset through launch instead of inheriting high', async () => {
    mocks.defaults.values.codexWorkerEffort = 'high';
    try {
      const result = await resolveDelegationSelection({ runtime: 'codex', requestedEffort: 'adaptive' }, '/repo');
      expect(result.routing).toMatchObject({ requestedEffort: 'adaptive', selectedEffort: null });
      expect(result.launchEffort).toBe('adaptive');
    } finally { mocks.defaults.values.codexWorkerEffort = 'adaptive'; }
  });
  it('refuses a runtime outside the configured pool', async () => {
    await expect(resolveDelegationSelection({ runtime: 'antigravity' }, '/repo')).rejects.toMatchObject({ code: 'worker_not_enabled' });
  });
  it('refuses a model mismatch instead of substituting the default', async () => {
    await expect(resolveDelegationSelection({ runtime: 'codex', model: 'claude-sonnet-5' }, '/repo')).rejects.toMatchObject({ code: 'worker_model_unavailable' });
  });
  it('refuses an effort the adapter would drop', async () => {
    await expect(resolveDelegationSelection({ runtime: '3code', model: 'provider.model', requestedEffort: 'high' }, '/repo')).rejects.toMatchObject({ code: 'effort_unsupported_runtime' });
  });
  it('does not hide a conflicting effort alias', async () => {
    await expect(resolveDelegationSelection({ requestedEffort: 'high', thinkingEffort: 'low' }, '/repo')).rejects.toMatchObject({ code: 'conflicting_effort' });
  });
  it('refuses unavailable runtime readiness before returning a selection', async () => {
    mocks.preflight.mockRejectedValueOnce(new Error('Sign in first'));
    await expect(resolveDelegationSelection({ runtime: 'codex' }, '/repo')).rejects.toMatchObject({ code: 'worker_unavailable' });
  });
});
