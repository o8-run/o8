import { describe, expect, it } from 'vitest';

import { MODEL_IDS } from '@/lib/models';

import {
  ORCHESTRATOR_RUNTIMES,
  ORCHESTRATOR_RUNTIME_IDS,
  formatDispatchableRuntimeChoices,
  getRuntimeCapability,
  isDispatchableRuntime,
  isOrchestratorRuntime,
  isRuntimeWorkerProvider,
  listDeclarativeRuntimes,
  listDispatchableRuntimes,
  listDispatchableWorkerProviders,
  resolveRuntimePreset,
} from './runtime-capabilities';

describe('runtime capability catalog', () => {
  it('derives runtime membership and dispatch validation from the catalog keys', () => {
    expect(ORCHESTRATOR_RUNTIME_IDS).toEqual(Object.keys(ORCHESTRATOR_RUNTIMES));
    expect(listDispatchableRuntimes()).toEqual(
      ORCHESTRATOR_RUNTIME_IDS.filter((runtime) => getRuntimeCapability(runtime).dispatchable),
    );
    expect(isOrchestratorRuntime('antigravity')).toBe(true);
    expect(isDispatchableRuntime('antigravity')).toBe(true);
    expect(isOrchestratorRuntime('made-up-cli')).toBe(false);
    expect(isOrchestratorRuntime('cloud')).toBe(true);
    expect(isDispatchableRuntime('cloud')).toBe(false);
    expect(getRuntimeCapability('cloud').explicitLaunchOnly).toBe(true);
  });

  it('derives declarative membership and auth inventory from the same entries', () => {
    const declarative = listDeclarativeRuntimes();
    expect(declarative).toEqual(
      ORCHESTRATOR_RUNTIME_IDS.filter((runtime) => Boolean(getRuntimeCapability(runtime).declarative)),
    );
    expect(declarative.length).toBeGreaterThan(0);

    const dispatchAuthHouses = listDispatchableRuntimes()
      .map((runtime) => getRuntimeCapability(runtime).authHouse);
    expect(dispatchAuthHouses).not.toContain(null);
    expect(new Set(dispatchAuthHouses).size).toBe(dispatchAuthHouses.length);
  });

  it('publishes every dispatchable id in generated validation copy', () => {
    const choices = formatDispatchableRuntimeChoices();
    for (const runtime of listDispatchableRuntimes()) {
      expect(choices).toContain(`"${runtime}"`);
    }
  });

  it('derives worker-provider validation from dispatchable catalog entries', () => {
    const expected = [...new Set(listDispatchableRuntimes().map(
      (runtime) => getRuntimeCapability(runtime).workerProvider,
    ))];
    expect(listDispatchableWorkerProviders()).toEqual(expected);
    expect(expected.every((provider) => isRuntimeWorkerProvider(provider))).toBe(true);
    expect(isRuntimeWorkerProvider('made-up-provider')).toBe(false);
  });

  it('resolves the UI-edit preset through the selected subscription runtime', () => {
    expect(resolveRuntimePreset('ui-edit-low-latency', 'codex')).toEqual({
      runtime: 'codex',
      model: MODEL_IDS.codexScoutDefault,
    });
    expect(resolveRuntimePreset('ui-edit-low-latency', 'claude-code')).toEqual({
      runtime: 'claude-code',
      model: MODEL_IDS.claudeHaikuQaDefault,
    });
    expect(resolveRuntimePreset('ui-edit-low-latency', 'antigravity')).toBeNull();
  });
});
