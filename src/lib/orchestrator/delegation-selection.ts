import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { resolveSubscriptionProfileRouting } from '@/lib/operator/subscription-profile';
import { normalizeRequestedRuntime, resolveWorkerRouting } from '@/lib/agents/routing';
import { assertExecutionCarrierDispatchable } from '@/lib/runtimes/shared/execution-carrier-preflight';
import { assertRuntimeDispatchable } from '@/lib/runtimes/shared/auth-detect';
import { resolveEffortAliases, resolveEffortPin } from './effort-pin';
import { configuredWorkerPool, workerModelCatalog } from './worker-catalog';

export class DelegationSelectionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export async function resolveDelegationSelection(body: Record<string, unknown>, repoPath: string) {
  const snapshot = getOperatorDefaultsSync();
  const defaults = snapshot.values;
  const runtime = body.runtime == null || body.runtime === '' ? defaults.defaultDispatchRuntime : normalizeRequestedRuntime(body.runtime);
  if (!runtime || !configuredWorkerPool(snapshot).includes(runtime)) {
    throw new DelegationSelectionError('worker_not_enabled', 'This worker is not in the configured pool. Choose one from cortex_worker_catalog or enable it in Settings > Models.');
  }
  const profile = resolveSubscriptionProfileRouting({ profile: defaults.subscriptionProfile, requestedRuntime: runtime });
  if (!profile.ok) throw new DelegationSelectionError(profile.code, profile.message);
  const aliases = resolveEffortAliases(body.requestedEffort, body.thinkingEffort);
  if (!aliases.ok) throw new DelegationSelectionError(aliases.code, aliases.message);
  if (body.model != null && typeof body.model !== 'string') throw new DelegationSelectionError('invalid_model', 'model must be a runtime model id.');
  const explicitModel = typeof body.model === 'string' ? body.model.trim() || null : null;
  let catalog;
  try { catalog = await workerModelCatalog(runtime, repoPath); }
  catch { throw new DelegationSelectionError('worker_catalog_unavailable', 'The worker model catalog is unavailable. Check this runtime in Settings and retry; no worker was started.'); }
  const model = explicitModel ?? catalog.defaultModel;
  if (model && !catalog.models.some(item => item.id === model)) {
    throw new DelegationSelectionError('worker_model_unavailable', `Model "${model}" is not in this worker's current catalog. Choose a listed model; no replacement was launched.`);
  }
  const inheritedEffort = runtime === 'codex' ? defaults.codexWorkerEffort : runtime === 'claude-code' ? defaults.claudeWorkerEffort : null;
  const requestedEffort = aliases.requestedEffort ?? inheritedEffort;
  const pin = resolveEffortPin({ runtime, model, explicitModel, requestedEffort,
    modelEfforts: catalog.models.find(row => row.id === model)?.efforts });
  if (!pin.ok) throw new DelegationSelectionError(pin.code, pin.message);
  const executionCarrier = runtime === 'codex' ? defaults.workerExecutionCarrier ?? null : null;
  try {
    if (executionCarrier) await assertExecutionCarrierDispatchable(runtime, executionCarrier);
    else await assertRuntimeDispatchable(runtime, catalog.carrier && catalog.carrier !== 'native' ? null : model, repoPath, { claudeCodeCarrier: catalog.carrier });
  }
  catch (error) { throw new DelegationSelectionError('worker_unavailable', error instanceof Error ? error.message : 'This worker is unavailable.'); }
  // Carrier-backed models intentionally cross model houses. Validate against the
  // configured carrier catalog above, then record the effective model unchanged.
  const routing = resolveWorkerRouting({ requestedRuntime: runtime, workerIntent: body.workerIntent, source: 'delegate-api' });
  return {
    routing: { ...routing, requestedModel: explicitModel, selectedModel: model,
      modelDisposition: explicitModel ? 'requested' as const : 'runtime-default' as const,
      requestedEffort, selectedEffort: pin.selectedEffort,
      reason: `Selected from the configured worker pool; model evidence: ${catalog.source}.` },
    carrier: catalog.carrier,
    executionCarrier,
    // Keep an explicit reset all the way to adapters; undefined inherits settings.
    launchEffort: requestedEffort ?? undefined,
  };
}
