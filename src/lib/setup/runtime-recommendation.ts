import type { RuntimeConnectionEvidence } from '@/lib/runtimes/shared/connection-evidence';
import { MODEL_IDS } from '@/lib/models';
import type { OrchestratorBackendSetting } from '@/lib/operator/backend-setting';
import { getRuntimeCapability, type OrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import { builtInAgentFromInventory } from './built-in-agent';
import type { PiUserSetup } from '@/lib/pi/user-setup';

export interface SetupRuntime {
  id: OrchestratorRuntime;
  label: string;
  available: boolean;
  installed?: boolean;
  unavailableReason: string | null;
  detail: string;
  fix: string;
  builtIn?: { backend: Exclude<OrchestratorBackendSetting, 'auto'>; planDetail: string };
  piSetup?: PiUserSetup;
  connection?: RuntimeConnectionEvidence;
}

export interface RuntimeActivity {
  codex: number;
  claude: number;
  complete: boolean;
}

export interface SetupValues {
  orchestratorBackend?: OrchestratorBackendSetting;
  orchestratorModel?: string;
  inAppOrchestratorEnabled?: boolean;
  opencodeWorkerModel?: string | null;
  opencodeOrchestratorModel?: string | null;
  defaultDispatchRuntime?: OrchestratorRuntime;
  defaultDispatchModel?: string;
  workerRuntimes?: OrchestratorRuntime[];
}

export interface RuntimeSetupRecommendation {
  backend: OrchestratorBackendSetting | null;
  leadModel: string;
  workerRuntimes: OrchestratorRuntime[];
  workerModel: string;
  reason: string;
  activity: RuntimeActivity;
  preserved: boolean;
  opencodeModel?: string;
}

export function visibleRuntimeInventory<T extends SetupRuntime>(
  inventory: readonly T[], selected: readonly string[] = [],
): T[] {
  return inventory.filter((item) => item.available || item.installed || item.builtIn
    || item.unavailableReason === 'needs_auth' || item.unavailableReason === 'needs_restart'
    || selected.includes(item.id));
}

export function runtimeForLead(backend: OrchestratorBackendSetting | null, inventory: readonly SetupRuntime[] = []): OrchestratorRuntime | null {
  const builtIn = builtInAgentFromInventory(inventory);
  if (builtIn?.builtIn?.backend === backend) return builtIn.id;
  if (backend === 'claude' || backend === 'fable') return 'claude-code';
  if (backend === 'codex' || backend === 'opencode' || backend === 'muse') return backend;
  return null;
}

export function leadModelPreset(backend: OrchestratorBackendSetting | null): string {
  if (backend === 'codex') return MODEL_IDS.codexDefault;
  if (backend === 'claude') return MODEL_IDS.orchestratorDefault;
  if (backend === 'fable') return MODEL_IDS.fableDefault;
  return '';
}

export function workerModelPreset(runtime: OrchestratorRuntime | undefined): string {
  if (!runtime) return '';
  return getRuntimeCapability(runtime).defaultModel ?? '';
}

export function recommendRuntimeSetup({ inventory, activity, values = {}, sources = {}, localLeadModels = {}, opencodeModel }: {
  inventory: readonly SetupRuntime[];
  activity: RuntimeActivity;
  values?: SetupValues;
  sources?: Partial<Record<keyof SetupValues, string>>;
  localLeadModels?: Partial<Record<'codex' | 'claude', string>>;
  opencodeModel?: string;
}): RuntimeSetupRecommendation {
  const explicit = (key: keyof SetupValues) => Boolean(sources[key] && sources[key] !== 'default');
  const ready = (id: string) => inventory.some((item) => item.id === id && item.available);
  const builtIn = builtInAgentFromInventory(inventory);
  const preserved = explicit('orchestratorBackend') || explicit('inAppOrchestratorEnabled');
  let backend: OrchestratorBackendSetting | null = null;
  let reason = 'Connect Codex or Claude Code to start, or customize your lead.';
  if (preserved) {
    backend = values.orchestratorBackend ?? null;
    reason = 'Keeping your saved lead choice. Discovery never changes it.';
  } else if (ready('codex') && ready('claude-code')) {
    backend = activity.complete && activity.claude > activity.codex ? 'claude' : 'codex';
    reason = activity.complete && activity.codex !== activity.claude
      ? `${backend === 'codex' ? 'Codex' : 'Claude Code'} has more local sessions active in the past seven days. You can choose either.`
      : 'Both are ready. Start with Codex or choose Claude Code; recent activity did not establish a preference.';
  } else if (ready('codex') || ready('claude-code')) {
    backend = ready('codex') ? 'codex' : 'claude';
    reason = `${backend === 'codex' ? 'Codex' : 'Claude Code'} is your ready primary tool.`;
  } else if (builtIn?.available && builtIn.builtIn && !inventory.some((item) => item.available && !item.builtIn)) {
    backend = builtIn.builtIn.backend;
    reason = 'The built-in agent is ready. You can add other coding tools later.';
  }
  const primary = runtimeForLead(backend, inventory);
  const workerRuntimes = explicit('workerRuntimes') && values.workerRuntimes?.length
    ? [...values.workerRuntimes]
    : explicit('defaultDispatchRuntime') && values.defaultDispatchRuntime
      ? [values.defaultDispatchRuntime]
      : primary && ready(primary) ? [primary]
        : inventory.filter((item) => item.available).slice(0, 1).map((item) => item.id);
  // Keep an explicit default first, even if the saved pool uses another order.
  if (explicit('defaultDispatchRuntime') && values.defaultDispatchRuntime) {
    const index = workerRuntimes.indexOf(values.defaultDispatchRuntime);
    if (index > 0) workerRuntimes.unshift(...workerRuntimes.splice(index, 1));
    if (index < 0) workerRuntimes.unshift(values.defaultDispatchRuntime);
  }
  // orchestratorModel belongs to the Claude backend. Codex starts with its
  // own model default; Fable owns a separate fixed model configuration.
  const leadModel = backend === 'claude'
    ? explicit('orchestratorModel') && values.orchestratorModel?.startsWith('claude-')
      ? values.orchestratorModel : localLeadModels.claude ?? leadModelPreset(backend)
    : backend === 'opencode'
      ? values.opencodeOrchestratorModel?.trim() || opencodeModel || MODEL_IDS.opencodeDefault
      : leadModelPreset(backend);
  return {
    backend, leadModel, workerRuntimes,
    opencodeModel: values.opencodeWorkerModel ?? opencodeModel,
    workerModel: workerRuntimes[0] === 'opencode'
      ? values.opencodeWorkerModel ?? opencodeModel ?? workerModelPreset('opencode')
      : workerRuntimes[0] === builtIn?.id ? ''
      : explicit('defaultDispatchModel') && values.defaultDispatchModel
      ? values.defaultDispatchModel : workerModelPreset(workerRuntimes[0]),
    reason, activity, preserved,
  };
}
