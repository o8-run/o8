import type {
  DispatchRuntime,
  OperatorDefaultsResponse,
  OrchestratorBackendSetting,
} from '@/components/desktop/settings/dispatch-shared';

import { recommendRuntimeSetup, runtimeForLead, type RuntimeSetupRecommendation, type SetupRuntime } from '@/lib/setup/runtime-recommendation';
import { runtimeSelectionUpdate } from '@/lib/setup/runtime-selection';
import { invalidateRuntimeInventory } from './useRuntimeInventory';
import { invalidateOperatorDefaultsValuesSnapshot } from '@/lib/operator/operator-defaults-values-client';

export type OnboardingOrchestratorRuntime = Exclude<OrchestratorBackendSetting, 'claude'> | 'claude-code';

export type DispatchableRuntimeInventoryItem = SetupRuntime;

export interface OnboardingRuntimeSelection {
  inventory: DispatchableRuntimeInventoryItem[];
  consentAnswered: boolean;
  orchestratorRuntime: OnboardingOrchestratorRuntime;
  workerRuntimes: DispatchRuntime[];
  recommendation: RuntimeSetupRecommendation;
  sources: OperatorDefaultsResponse['sources'];
}

type OnboardingFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function loadOnboardingBuiltInAgent(request: OnboardingFetch = fetch): Promise<SetupRuntime | null> {
  const response = await request('/api/panel/operator-defaults?include=setup-built-in', { cache: 'no-store' });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null) as { builtInAgent?: SetupRuntime | null } | null;
  return payload?.builtInAgent ?? null;
}

export function orchestratorBackendForRuntime(
  runtime: OnboardingOrchestratorRuntime,
): OrchestratorBackendSetting {
  return runtime === 'claude-code' ? 'claude' : runtime;
}

export function canSelectOnboardingRuntime(
  inventory: DispatchableRuntimeInventoryItem[],
  runtime: DispatchRuntime,
): boolean {
  return inventory.some((item) => item.id === runtime && item.available);
}

export function toggleOnboardingWorkerRuntime(
  selected: DispatchRuntime[],
  runtime: DispatchRuntime,
  inventory: DispatchableRuntimeInventoryItem[],
): DispatchRuntime[] {
  if (selected.includes(runtime)) {
    return selected.length > 1 ? selected.filter((item) => item !== runtime) : selected;
  }
  if (!canSelectOnboardingRuntime(inventory, runtime)) return selected;
  return [...selected, runtime];
}

export async function loadOnboardingRuntimeSelection(
  request: OnboardingFetch = fetch,
  refresh = false,
): Promise<OnboardingRuntimeSelection> {
  const response = await request(`/api/panel/operator-defaults?include=setup${refresh ? '&refresh=runtime' : ''}`, { cache: 'no-store' });
  const payload = await response.json().catch(() => null) as (OperatorDefaultsResponse & { setupRecommendation?: RuntimeSetupRecommendation }) | { error?: string } | null;
  if (!response.ok || !payload || !('values' in payload)) {
    const message = payload && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Runtime inventory failed (${response.status})`;
    throw new Error(message);
  }
  const inventory = payload.dispatchableRuntimes ?? [];
  const recommendation = payload.setupRecommendation ?? recommendRuntimeSetup({
    inventory, values: payload.values, sources: payload.sources,
    activity: { codex: 0, claude: 0, complete: false },
  });
  return {
    consentAnswered: payload.values.telemetryConsentAnswered === true,
    inventory, recommendation, sources: payload.sources ?? {} as OperatorDefaultsResponse['sources'],
    orchestratorRuntime: recommendation.backend === 'claude' ? 'claude-code' : recommendation.backend ?? 'codex',
    workerRuntimes: recommendation.workerRuntimes,
  };
}

export async function persistOnboardingRuntimeSelection(
  selection: Pick<OnboardingRuntimeSelection, 'orchestratorRuntime' | 'workerRuntimes'> & { leadModel?: string; workerModel?: string },
  request: OnboardingFetch = fetch,
): Promise<void> {
  // These models describe runtime-owned defaults; only the editable lead
  // backends persist a model setting in operator defaults.
  const storesLeadModel = selection.orchestratorRuntime === 'claude-code'
    || selection.orchestratorRuntime === 'opencode';
  const response = await request('/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(runtimeSelectionUpdate({
      ...selection, leadModel: storesLeadModel ? selection.leadModel : undefined,
    })),
  });
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Save failed (${response.status})`);
  }
  invalidateOperatorDefaultsValuesSnapshot();
  invalidateRuntimeInventory();
}

export function onboardingSetupIsReady(setup: OnboardingRuntimeSelection): boolean {
  const backend = setup.recommendation.backend;
  const runtime = runtimeForLead(backend, setup.inventory);
  const leadReady = runtime ? canSelectOnboardingRuntime(setup.inventory, runtime)
    : backend === 'o8' || Boolean(backend && setup.recommendation.preserved);
  return leadReady && setup.workerRuntimes.length > 0
    && setup.workerRuntimes.every((id) => canSelectOnboardingRuntime(setup.inventory, id));
}
