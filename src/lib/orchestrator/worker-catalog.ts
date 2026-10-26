import 'server-only';

import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { resolveSubscriptionProfileRouting } from '@/lib/operator/subscription-profile';
import { assertExecutionCarrierDispatchable } from '@/lib/runtimes/shared/execution-carrier-preflight';
import { getDispatchableRuntimeAvailability } from '@/lib/runtimes/shared/auth-detect';
import { getCodexSpeedCatalogue } from '@/lib/codex/service-tier-catalogue';
import { parseLocalModel } from '@/lib/codex/local-model';
import { readCodexSubscriptionProxyModels } from '@/lib/claude-code/codex-subscription-proxy';
import { resolveClaudeCodeWorkerSelection } from '@/lib/claude-code/worker-profile';
import type { ClaudeCodeModelSource } from '@/lib/claude-code/worker-profile-types';
import { SUPPORTED_MODEL_IDS } from '@/lib/models';
import { getThreecodeModelCatalogue } from '@/lib/runtimes/threecode-model-catalogue';
import { resolveAcpLaunch } from '@/lib/lane/orchestrator-backends/acp';
import { probeAcpModels } from './acp-model-probe';
import { museWorkerModelContext, probeMuseModels } from '@/lib/muse/models';
import { getRuntimeCapability, type OrchestratorRuntime } from './runtime-capabilities';
import { resolveEffortPin } from './effort-pin';
import { THINKING_EFFORTS, type ThinkingEffort } from './thinking-effort';

export interface WorkerModelCatalog {
  models: Array<{ id: string; efforts: ThinkingEffort[] }>;
  defaultModel: string | null;
  carrier: ClaudeCodeModelSource | null;
  source: string;
  /** Discovery describes selectable ids, not provider entitlement or a successful run. */
  observedAt: string;
}

export function configuredWorkerPool(snapshot = getOperatorDefaultsSync()): OrchestratorRuntime[] {
  // Older installs have no explicit pool. Preserve their selected worker without
  // silently enabling every installed runtime. An explicit pool is authoritative.
  const pool = snapshot.sources.workerRuntimes === 'file'
    ? snapshot.values.workerRuntimes
    : [snapshot.values.defaultDispatchRuntime, ...snapshot.values.workerRuntimes];
  return [...new Set(pool)];
}

export async function workerModelCatalog(runtime: OrchestratorRuntime, repoPath: string): Promise<WorkerModelCatalog> {
  const defaults = getOperatorDefaultsSync().values;
  const capability = getRuntimeCapability(runtime);
  let defaultModel = runtime === 'opencode' ? defaults.opencodeWorkerModel
    : runtime === '3code' ? defaults.threecodeWorkerModel
      : runtime === defaults.defaultDispatchRuntime ? defaults.defaultDispatchModel || null : null;
  defaultModel ??= capability.defaultModel ?? null;
  let ids: string[] = [];
  let source = 'runtime-default';
  let carrier: ClaudeCodeModelSource | null = null;
  let modelEfforts: Map<string, string[] | null> | undefined;
  if (runtime === 'claude-code') {
    const configured = resolveClaudeCodeWorkerSelection();
    carrier = configured.source;
    if (carrier !== 'native') defaultModel = configured.model;
    if (carrier === 'native') {
      ids = SUPPORTED_MODEL_IDS.filter(id => id.startsWith('claude-'));
      source = 'app-model-registry';
    } else if (carrier === 'codex-subscription') {
      const models = await readCodexSubscriptionProxyModels();
      ids = models ?? (defaultModel ? [defaultModel] : []);
      source = models ? 'configured-carrier-model-list' : 'configured-carrier-model';
    } else {
      // Only the configured carrier model is established here. Changing the
      // carrier or enabling a different paid route remains a Settings action.
      ids = defaultModel ? [defaultModel] : [];
      source = 'configured-carrier-model';
    }
  } else if (runtime === 'codex' && defaults.workerExecutionCarrier) {
    // The carrier owns authentication; native Codex may use a different account.
    ids = defaultModel ? [defaultModel] : [];
    source = 'configured-execution-carrier-model';
  } else if (runtime === 'codex') {
    ids = Object.keys((await getCodexSpeedCatalogue()).models);
    if (defaultModel && parseLocalModel(defaultModel)) ids.push(defaultModel);
    source = 'installed-model-list';
  } else if (runtime === '3code') {
    const catalog = await getThreecodeModelCatalogue();
    ids = catalog.models;
    source = catalog.source;
  } else if (runtime === 'opencode') {
    const launch = resolveAcpLaunch('opencode');
    if (!launch) throw new Error('The selected runtime is not installed.');
    const catalog = await probeAcpModels('opencode', launch, repoPath);
    ids = catalog.models.map(model => model.value);
    defaultModel ??= catalog.currentModel;
    source = catalog.source;
  } else if (runtime === 'muse') {
    const catalog = await probeMuseModels(repoPath, true, await museWorkerModelContext());
    ids = catalog.models.map(model => model.id);
    modelEfforts = new Map(catalog.models.map(model => [model.id, model.efforts]));
    defaultModel ??= catalog.models.find(model => model.isDefault)?.id ?? null;
    source = catalog.source;
  } else {
    ids = defaultModel ? [defaultModel] : [];
  }
  return {
    models: [...new Set(ids)].map(id => ({ id, efforts: THINKING_EFFORTS.filter(effort => resolveEffortPin({ runtime, model: id, requestedEffort: effort, modelEfforts: modelEfforts?.get(id) }).ok) })),
    defaultModel, carrier, source, observedAt: new Date().toISOString(),
  };
}

/** Overview is cheap; model discovery is requested for one eligible runtime. */
export async function getWorkerCatalog(repoPath: string, runtime?: OrchestratorRuntime | null) {
  const snapshot = getOperatorDefaultsSync();
  const pool = configuredWorkerPool(snapshot);
  const inventory = await getDispatchableRuntimeAvailability();
  const workers = await Promise.all(pool.map(async id => {
    const readiness = inventory.find(item => item.id === id);
    let available = readiness?.available === true;
    let reason = readiness?.detail ?? 'Readiness is unknown.';
    if (id === 'codex' && snapshot.values.workerExecutionCarrier) {
      try { await assertExecutionCarrierDispatchable(id, snapshot.values.workerExecutionCarrier); available = true; }
      catch { available = false; reason = 'The configured execution carrier is unavailable. Check Settings > Models.'; }
    }
    const profile = resolveSubscriptionProfileRouting({ profile: snapshot.values.subscriptionProfile, requestedRuntime: id });
    return {
      runtime: id, label: getRuntimeCapability(id).label,
      available: profile.ok && available,
      reason: !profile.ok ? profile.message : available ? null : reason,
      preferred: id === snapshot.values.defaultDispatchRuntime,
      reasoningEffort: getRuntimeCapability(id).reasoningEffort,
    };
  }));
  if (runtime && !workers.some(worker => worker.runtime === runtime && worker.available)) {
    throw new Error('Choose an available runtime from the configured worker pool. Manage the pool in Settings > Models.');
  }
  return {
    workers,
    ...(runtime ? { runtime, catalog: await workerModelCatalog(runtime, repoPath) } : {}),
    selectionPolicy: 'Honor explicit task choices. Otherwise choose a suitable available worker from this pool. Do not change settings or silently replace a refused choice. Availability is preflight evidence, not proof of execution.',
  };
}
