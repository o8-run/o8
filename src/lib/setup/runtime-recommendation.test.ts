import { describe, expect, it } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import { recommendRuntimeSetup, visibleRuntimeInventory } from './runtime-recommendation';
import { resolveBackendTurnModel } from '@/lib/orchestrator/turn-model-selection';

const inventory = [
  { id: 'codex', label: 'Codex', available: true, unavailableReason: null, detail: '', fix: '' },
  { id: 'claude-code', label: 'Claude Code', available: true, unavailableReason: null, detail: '', fix: '' },
  { id: 'gemini', label: 'Gemini', available: false, unavailableReason: 'needs_auth', detail: '', fix: 'Sign in' },
  { id: 'opencode', label: 'OpenCode', available: false, unavailableReason: 'not_installed', detail: '', fix: 'Install' },
] as const;
const activity = { codex: 3, claude: 8, complete: true };

describe('detected runtime recommendation', () => {
  it.each([
    { backend: 'claude', saved: false, expected: MODEL_IDS.orchestratorDefault },
    { backend: 'claude', saved: true, expected: MODEL_IDS.claudeWorkerDefault },
    { backend: 'codex', saved: false, expected: MODEL_IDS.codexDefault },
    { backend: 'codex', saved: true, expected: MODEL_IDS.codexCliDefault },
    { backend: 'opencode', saved: false, expected: MODEL_IDS.opencodeDefault },
    { backend: 'opencode', saved: true, expected: 'fixture/selected-model' },
    { backend: 'pi', saved: false, expected: '' },
    { backend: 'pi', saved: true, expected: 'fixture/pi-saved-model' },
    { backend: 'pi', apiKey: true, saved: false, expected: '' },
    { backend: 'pi', apiKey: true, saved: true, expected: 'openrouter/fixture/api-saved-model' },
    { backend: 'o8', saved: false, expected: resolveBackendTurnModel('o8', undefined) },
    { backend: 'o8', saved: true, expected: resolveBackendTurnModel('o8', undefined) },
  ] as const)('resolves its own lead model or asks: $backend saved=$saved', (row) => {
    const { backend, saved, expected } = row;
    const apiKey = 'apiKey' in row && row.apiKey;
    const setup = recommendRuntimeSetup({
      inventory: [...inventory, { id: 'pi', label: 'Pi', available: true, unavailableReason: null, detail: '', fix: '',
        piSetup: { detected: true, agentDir: '/fixture/pi', credentialsPresent: true, extensions: 0, skills: 0, sessions: 0, countsTruncated: false,
          ...(apiKey ? { provider: 'openrouter' } : {}),
          ...(saved ? { model: apiKey ? 'fixture/api-saved-model' : 'fixture/pi-saved-model' } : {}) } }],
      activity, values: { orchestratorBackend: backend, workerRuntimes: ['codex'],
        ...(saved ? { orchestratorModel: MODEL_IDS.claudeWorkerDefault, opencodeOrchestratorModel: 'fixture/selected-model' } : {}) },
      sources: { orchestratorBackend: 'file', workerRuntimes: 'file', ...(saved ? { orchestratorModel: 'file' } : {}) },
      localLeadModels: saved ? { codex: MODEL_IDS.codexCliDefault } : {},
    });
    expect(setup.leadModel).toBe(expected);
  });

  it.each([null, '', '   '])('uses OpenCode defaults with no saved lead model (%j), independently of Codex workers', (saved) => {
    const setup = recommendRuntimeSetup({ inventory, activity, values: {
      orchestratorBackend: 'opencode', opencodeOrchestratorModel: saved,
      orchestratorModel: MODEL_IDS.orchestratorDefault, workerRuntimes: ['codex'],
    }, sources: { orchestratorBackend: 'file', workerRuntimes: 'file' } });
    expect(setup.leadModel).toBe(MODEL_IDS.opencodeDefault);
    expect(setup.workerModel).toBe(MODEL_IDS.codexWorkerDefault);
  });

  it('prefers OpenCode configuration, then a saved OpenCode lead model', () => {
    const input = { inventory, activity, opencodeModel: 'fixture/cli-model',
      values: { orchestratorBackend: 'opencode' as const }, sources: { orchestratorBackend: 'file' } };
    expect(recommendRuntimeSetup(input).leadModel).toBe('fixture/cli-model');
    expect(recommendRuntimeSetup({ ...input, values: {
      ...input.values, opencodeOrchestratorModel: 'fixture/saved-model',
    } }).leadModel).toBe('fixture/saved-model');
  });

  it('uses seven-day activity for a fresh install and economical workers', () => {
    const setup = recommendRuntimeSetup({ inventory, activity });
    expect(setup.backend).toBe('claude');
    expect(setup.workerRuntimes).toEqual(['claude-code']);
    expect(setup.workerModel).toBe(MODEL_IDS.claudeWorkerDefault);
    expect(setup.reason).toContain('past seven days');
  });

  it('keeps explicit choices even when another runtime was used more', () => {
    const setup = recommendRuntimeSetup({ inventory, activity, values: {
      orchestratorBackend: 'codex', orchestratorModel: MODEL_IDS.codexDefault,
      defaultDispatchRuntime: 'codex', defaultDispatchModel: MODEL_IDS.codexCliDefault,
      workerRuntimes: ['codex'],
    }, sources: { orchestratorBackend: 'file', orchestratorModel: 'file', defaultDispatchModel: 'file', workerRuntimes: 'file', defaultDispatchRuntime: 'file' } });
    expect(setup.backend).toBe('codex');
    expect(setup.workerModel).toBe(MODEL_IDS.codexCliDefault);
    expect(setup.reason).toContain('saved');
  });

  it('does not recommend a saved model from a different lead runtime', () => {
    const sources = { orchestratorBackend: 'file', orchestratorModel: 'file' };
    expect(recommendRuntimeSetup({ inventory, activity, sources, values: {
      orchestratorBackend: 'codex', orchestratorModel: 'claude-opus-5',
    } }).leadModel).toBe('gpt-6-astra');
    expect(recommendRuntimeSetup({ inventory, activity, sources, values: {
      orchestratorBackend: 'claude', orchestratorModel: 'gpt-6-astra',
    } }).leadModel).toBe('claude-opus-5-5');
    expect(recommendRuntimeSetup({ inventory, activity, sources, values: {
      orchestratorBackend: 'fable', orchestratorModel: 'claude-opus-5',
    } }).leadModel).toBe('claude-fable-5-1');
  });

  it('keeps the saved default worker when the pool was ordered differently', () => {
    const setup = recommendRuntimeSetup({ inventory, activity, values: {
      defaultDispatchRuntime: 'codex', workerRuntimes: ['claude-code', 'codex'],
    }, sources: { defaultDispatchRuntime: 'file', workerRuntimes: 'file' } });
    expect(setup.workerRuntimes).toEqual(['codex', 'claude-code']);
    expect(setup.workerModel).toBe(MODEL_IDS.codexWorkerDefault);
  });

  it('does not infer a preference from a partial or tied scan', () => {
    for (const evidence of [{ ...activity, complete: false }, { codex: 0, claude: 0, complete: true }]) {
      const setup = recommendRuntimeSetup({ inventory, activity: evidence });
      expect(setup.backend).toBe('codex');
      expect(setup.reason).not.toContain('more');
    }
  });

  it('chooses the only ready primary and leaves a no-primary setup unselected', () => {
    expect(recommendRuntimeSetup({ inventory: inventory.slice(1), activity }).backend).toBe('claude');
    expect(recommendRuntimeSetup({ inventory: inventory.slice(2), activity }).backend).toBeNull();
  });

  it('shows installed tools needing login, hides missing tools, and preserves a selected missing tool', () => {
    expect(visibleRuntimeInventory(inventory).map((item) => item.id)).toEqual(['codex', 'claude-code', 'gemini']);
    expect(visibleRuntimeInventory(inventory, ['opencode']).map((item) => item.id)).toContain('opencode');
  });
});
