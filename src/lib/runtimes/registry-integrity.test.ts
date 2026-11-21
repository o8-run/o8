import { describe, expect, it } from 'vitest';

import {
  ORCHESTRATOR_RUNTIME_IDS,
  ORCHESTRATOR_RUNTIMES,
  getRuntimeCapability,
  isOrchestratorRuntime,
  listDispatchableRuntimes,
} from '@/lib/orchestrator/runtime-capabilities';
import {
  getAllRuntimes,
  getCostParser,
  getRuntime,
  parseCost,
} from '@/lib/runtimes';

const REQUIRED_ADAPTER_METHODS = [
  'discoverSessions',
  'readTranscript',
  'launch',
  'resume',
  'interrupt',
  'getChangedFiles',
] as const;

describe('dispatchable runtime registry integrity', () => {
  it('reports unknown Hermes cost evidence through the registered runtime', async () => {
    expect(getRuntime('hermes')?.capabilities.costTelemetry).toBe(false);
    expect(await parseCost('hermes', [], { fallbackModel: 'fixture/model' })).toMatchObject({
      costSource: 'unknown', totalCostUsd: 0, inputTokens: 0, outputTokens: 0, model: 'fixture/model',
    });
  });
  it('keeps every advertised runtime fully registered and dispatchable consistently', () => {
    const advertised = listDispatchableRuntimes();

    expect(advertised).toContain('antigravity');
    expect(new Set(advertised).size).toBe(advertised.length);

    for (const runtimeId of advertised) {
      const capability = ORCHESTRATOR_RUNTIMES[runtimeId];
      const adapter = getRuntime(runtimeId);

      expect(capability.label.trim(), `${runtimeId} label`).not.toBe('');
      expect(capability.accentColor, `${runtimeId} accent`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(capability.dispatchable, `${runtimeId} dispatchable flag`).toBe(true);
      expect(adapter, `${runtimeId} adapter registration`).toBeDefined();
      expect(adapter?.id, `${runtimeId} adapter id`).toBe(runtimeId);
      expect(adapter?.capabilities.launch, `${runtimeId} launch capability`).toBe(true);

      for (const method of REQUIRED_ADAPTER_METHODS) {
        expect(typeof adapter?.[method], `${runtimeId}.${method}`).toBe('function');
      }

      expect(getCostParser(runtimeId), `${runtimeId} cost parser registration`).toBeDefined();
      if (adapter?.capabilities.costTelemetry) {
        expect(typeof adapter.getTelemetry, `${runtimeId}.getTelemetry`).toBe('function');
      }
    }

    const registeredCanonicalLaunchers = getAllRuntimes()
      .filter((runtime) => isOrchestratorRuntime(runtime.id) && runtime.capabilities.launch)
      .map((runtime) => runtime.id)
      .sort();
    const explicitLaunchers = ORCHESTRATOR_RUNTIME_IDS.filter(
      (runtimeId) => getRuntimeCapability(runtimeId).explicitLaunchOnly,
    );
    expect(registeredCanonicalLaunchers).toEqual([...advertised, ...explicitLaunchers].sort());
  });

  it('keeps mission-hidden runtimes non-launchable unless they have an explicit governed launch route', () => {
    for (const runtimeId of ORCHESTRATOR_RUNTIME_IDS) {
      const capability = getRuntimeCapability(runtimeId);
      const adapter = getRuntime(runtimeId);
      expect(adapter, `${runtimeId} canonical adapter registration`).toBeDefined();
      expect(adapter?.capabilities.launch, `${runtimeId} dispatchability parity`)
        .toBe(capability.dispatchable || Boolean(capability.explicitLaunchOnly));
    }
  });
});
