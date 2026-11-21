import { MODEL_IDS } from '@/lib/models';
import type { OrchestratorBackendSetting } from '@/lib/operator/backend-setting';
import {
  getRuntimeCapability,
  type OrchestratorRuntime,
} from '@/lib/orchestrator/runtime-capabilities';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { SubscriptionProfile } from '@/lib/operator/subscription-profile';
import { validateRuntimeModelSelection } from '@/lib/runtimes/shared/model-compatibility';

export { validateRuntimeModelSelection } from '@/lib/runtimes/shared/model-compatibility';

export type RoleId = 'orchestrate' | 'build' | 'review' | 'brain' | 'triage' | 'recovery';
export type RoleRouteSource = 'env' | 'file' | 'profile' | 'default' | 'runtime-default' | 'derived' | 'request-time';
export type RoleRouteStatus = 'ready' | 'unavailable' | 'unchecked';

export interface RuntimeRouteAvailability {
  id: OrchestratorRuntime;
  label: string;
  available: boolean;
  unavailableReason: 'not_installed' | 'needs_auth' | 'needs_restart' | 'adapter_unavailable' | 'incompatible_model' | null;
  detail: string;
  fix: string;
}

export interface RoleRoutingDefaults {
  subscriptionProfile: SubscriptionProfile;
  orchestratorBackend: OrchestratorBackendSetting;
  inAppOrchestratorEnabled: boolean;
  thinkingEffort: ThinkingEffort;
  orchestratorModel: string;
  opencodeOrchestratorModel: string | null;
  reviewerBackend: 'follow' | 'codex' | 'claude';
  defaultDispatchRuntime: OrchestratorRuntime;
  defaultDispatchModel: string;
  codexWorkerEffort: ThinkingEffort;
  claudeWorkerEffort: ThinkingEffort;
  crossHouseWorkerFallback: boolean;
  brainRoutingMode: 'auto' | 'subscription';
  classAComposer: 'auto' | 'haiku-cli' | 'sonnet-cli' | 'fastest';
  brainUseClaudeCli: boolean;
  brainCodexModel: string;
  brainCodexEffort: ThinkingEffort;
  localInferenceBaseUrl: string;
  localChatModel: string;
  targetingTriage: {
    runtime: OrchestratorRuntime;
    model: string;
    effort: ThinkingEffort;
  };
}

export type RoleRoutingSources = {
  [Key in keyof RoleRoutingDefaults]: RoleRouteSource;
};

export interface RoleRouteChoice {
  backend: string | null;
  runtime: OrchestratorRuntime | null;
  model: string | null;
  effort: ThinkingEffort | null;
  label: string;
}

export interface RoleRouteChoiceSources {
  backend: RoleRouteSource;
  runtime: RoleRouteSource;
  model: RoleRouteSource;
  effort: RoleRouteSource;
}

export interface RoleRouteAvailability {
  status: RoleRouteStatus;
  reason: RuntimeRouteAvailability['unavailableReason'];
  detail: string;
  fix: string;
}

export interface AgentRoleRoute {
  id: RoleId;
  label: string;
  description: string;
  configured: RoleRouteChoice;
  effective: RoleRouteChoice;
  sources: RoleRouteChoiceSources;
  availability: RoleRouteAvailability;
  fallbacks: string[];
  reason: string;
  changePath: string;
  settingKeys: Array<keyof RoleRoutingDefaults>;
}

export interface ProjectAgentRoleRoutesInput {
  values: RoleRoutingDefaults;
  sources: RoleRoutingSources;
  dispatchableRuntimes: RuntimeRouteAvailability[];
  /** Resolved at the API boundary so the projection does not promise managed use to free plans. */
  managedBrainEligible?: boolean;
}

const ROLE_META: Record<RoleId, Pick<AgentRoleRoute, 'label' | 'description'>> = {
  orchestrate: {
    label: 'Orchestrate',
    description: 'Drives operator chat and plans governed work.',
  },
  build: {
    label: 'Build',
    description: 'Implements dispatched packets in isolated worktrees.',
  },
  review: {
    label: 'Review',
    description: 'Checks completed work before approval and merge.',
  },
  brain: {
    label: 'Brain',
    description: 'Answers repository questions and composes cited guidance.',
  },
  triage: {
    label: 'Triage',
    description: 'Scores intake and prepares lightweight routing decisions.',
  },
  recovery: {
    label: 'Recovery',
    description: 'Resumes or replaces a worker without changing packet ownership.',
  },
};

const BACKEND_LABELS: Record<string, string> = {
  auto: 'Auto',
  codex: 'Codex',
  claude: 'Claude',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  acp: 'ACP agent',
  collide: 'Collide',
  fable: 'Fable',
  o8: 'o8 managed',
  opencode: 'OpenCode 2',
  muse: 'Muse Code',
  follow: 'Follow Orchestrate',
  'auto-cascade': 'Auto cascade',
  'managed-inference': 'Managed inference',
  local: 'Local inference',
  'packet-worker': 'Packet worker route',
};

function cleanModel(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  return trimmed || null;
}

function backendRuntime(backend: string): OrchestratorRuntime | null {
  if (backend === 'codex') return 'codex';
  if (backend === 'claude') return 'claude-code';
  if (backend === 'opencode') return 'opencode';
  return null;
}

function backendLabel(backend: string): string {
  return BACKEND_LABELS[backend] ?? backend;
}

function runtimeLabel(runtime: OrchestratorRuntime): string {
  return getRuntimeCapability(runtime).label;
}

function choiceLabel(choice: Omit<RoleRouteChoice, 'label'>): string {
  const owner = choice.runtime
    ? runtimeLabel(choice.runtime)
    : choice.backend
      ? backendLabel(choice.backend)
      : 'Request-time route';
  const detail = [choice.model, choice.effort && choice.effort !== 'adaptive' ? choice.effort : null]
    .filter(Boolean)
    .join(' · ');
  return detail ? `${owner} · ${detail}` : owner;
}

function choice(value: Omit<RoleRouteChoice, 'label'>): RoleRouteChoice {
  return { ...value, label: choiceLabel(value) };
}

export function createRoleRouteChoice(value: Omit<RoleRouteChoice, 'label'>): RoleRouteChoice {
  return choice(value);
}

export function createBackendRoleRouteChoice(
  backend: string,
  model: string | null = null,
  effort: ThinkingEffort | null = null,
): RoleRouteChoice {
  return choice({ backend, runtime: backendRuntime(backend), model, effort });
}

function runtimeAvailability(
  runtime: OrchestratorRuntime | null,
  dispatchableRuntimes: RuntimeRouteAvailability[],
  fallbackDetail: string,
): RoleRouteAvailability {
  if (!runtime) {
    return {
      status: 'unchecked',
      reason: null,
      detail: fallbackDetail,
      fix: '',
    };
  }
  const found = dispatchableRuntimes.find((item) => item.id === runtime);
  if (!found) {
    return {
      status: 'unchecked',
      reason: null,
      detail: `${runtimeLabel(runtime)} readiness has not been checked yet.`,
      fix: '',
    };
  }
  return {
    status: found.available ? 'ready' : 'unavailable',
    reason: found.unavailableReason,
    detail: found.detail,
    fix: found.fix,
  };
}

function incompatibleAvailability(runtime: OrchestratorRuntime, model: string): RoleRouteAvailability {
  return {
    status: 'unavailable',
    reason: 'incompatible_model',
    detail: `${runtimeLabel(runtime)} cannot launch model "${model}".`,
    fix: `Clear the model pin or choose a model supported by ${runtimeLabel(runtime)}.`,
  };
}

function runtimeModel(runtime: OrchestratorRuntime, configured: string | null): {
  effective: string | null;
  source: RoleRouteSource;
  incompatible: boolean;
} {
  if (!configured) {
    return {
      effective: getRuntimeCapability(runtime).defaultModel ?? null,
      source: 'runtime-default',
      incompatible: false,
    };
  }
  const incompatible = validateRuntimeModelSelection(runtime, configured, 'Selected') !== null;
  return {
    effective: incompatible ? getRuntimeCapability(runtime).defaultModel ?? null : configured,
    source: incompatible ? 'runtime-default' : 'file',
    incompatible,
  };
}

function workerEffort(values: RoleRoutingDefaults, runtime: OrchestratorRuntime): ThinkingEffort | null {
  if (runtime === 'codex') return values.codexWorkerEffort;
  if (runtime === 'claude-code') return values.claudeWorkerEffort;
  return null;
}

function resolvedBackend(values: RoleRoutingDefaults): string {
  if (values.orchestratorBackend !== 'auto') return values.orchestratorBackend;
  return values.inAppOrchestratorEnabled ? 'claude' : 'codex';
}

function backendModel(values: RoleRoutingDefaults, backend: string): string | null {
  if (backend === 'claude') return values.orchestratorModel;
  if (backend === 'codex') return MODEL_IDS.codexDefault;
  if (backend === 'opencode') {
    return cleanModel(values.opencodeOrchestratorModel)
      ?? getRuntimeCapability('opencode').defaultModel
      ?? null;
  }
  return null;
}

function backendModelSource(values: RoleRoutingDefaults, backend: string, sources: RoleRoutingSources): RoleRouteSource {
  if (backend === 'claude') return sources.orchestratorModel;
  if (backend === 'opencode' && values.opencodeOrchestratorModel) return sources.opencodeOrchestratorModel;
  return 'runtime-default';
}

function subscriptionProfileLabel(profile: SubscriptionProfile): string {
  if (profile === 'claude-only') return 'Claude-only';
  if (profile === 'codex-only') return 'Codex-only';
  return 'Both accounts';
}

function profileReason(values: RoleRoutingDefaults, source: RoleRouteSource): string | null {
  if (source !== 'profile') return null;
  return `${subscriptionProfileLabel(values.subscriptionProfile)} controls this route.`;
}

function orchestrateRoute(input: ProjectAgentRoleRoutesInput): AgentRoleRoute {
  const { values, sources, dispatchableRuntimes } = input;
  const effectiveBackend = resolvedBackend(values);
  const runtime = backendRuntime(effectiveBackend);
  const effective = choice({
    backend: effectiveBackend,
    runtime,
    model: backendModel(values, effectiveBackend),
    effort: values.thinkingEffort ?? null,
  });
  const configured = choice({
    backend: values.orchestratorBackend,
    runtime: values.orchestratorBackend === 'auto' ? null : runtime,
    model: values.orchestratorBackend === 'claude' ? values.orchestratorModel : null,
    effort: values.thinkingEffort ?? null,
  });
  const autoReason = values.inAppOrchestratorEnabled ? 'Claude' : 'Codex';
  const constrainedByProfile = profileReason(values, sources.orchestratorBackend);
  return {
    id: 'orchestrate',
    ...ROLE_META.orchestrate,
    configured,
    effective,
    sources: {
      backend: sources.orchestratorBackend,
      runtime: values.orchestratorBackend === 'auto' ? 'derived' : sources.orchestratorBackend,
      model: backendModelSource(values, effectiveBackend, sources),
      effort: sources.thinkingEffort,
    },
    availability: runtimeAvailability(
      runtime,
      dispatchableRuntimes,
      `${backendLabel(effectiveBackend)} validates its own connection when a turn starts.`,
    ),
    fallbacks: values.orchestratorBackend === 'auto'
      ? [`Auto currently follows the ${autoReason} legacy orchestrator preference.`]
      : [],
    reason: constrainedByProfile
      ?? (values.orchestratorBackend === 'auto'
        ? `Auto resolves through the legacy orchestrator preference, currently ${autoReason}.`
        : `${backendLabel(effectiveBackend)} is pinned in operator settings.`),
    changePath: 'Settings → Models & providers → Chat & code review',
    settingKeys: ['subscriptionProfile', 'orchestratorBackend', 'inAppOrchestratorEnabled', 'orchestratorModel', 'opencodeOrchestratorModel'],
  };
}

function buildRoute(input: ProjectAgentRoleRoutesInput): AgentRoleRoute {
  const { values, sources, dispatchableRuntimes } = input;
  const runtime = values.defaultDispatchRuntime;
  const configuredModel = cleanModel(values.defaultDispatchModel);
  const model = runtimeModel(runtime, configuredModel);
  const effort = workerEffort(values, runtime);
  const effective = choice({ backend: null, runtime, model: model.effective, effort });
  const invalid = configuredModel && model.incompatible;
  const fallback = values.crossHouseWorkerFallback
    ? ['A quota-capped worker may retry on the equal-tier runtime from the other configured account.']
    : ['A quota cap stops for operator review; automatic cross-account fallback is off.'];
  const constrainedByProfile = profileReason(values, sources.defaultDispatchRuntime);
  return {
    id: 'build',
    ...ROLE_META.build,
    configured: choice({ backend: null, runtime, model: configuredModel, effort }),
    effective,
    sources: {
      backend: 'derived',
      runtime: sources.defaultDispatchRuntime,
      model: configuredModel && !model.incompatible ? sources.defaultDispatchModel : model.source,
      effort: runtime === 'codex'
        ? sources.codexWorkerEffort
        : runtime === 'claude-code'
          ? sources.claudeWorkerEffort
          : 'runtime-default',
    },
    availability: invalid
      ? incompatibleAvailability(runtime, configuredModel)
      : runtimeAvailability(runtime, dispatchableRuntimes, `${runtimeLabel(runtime)} validates when the packet launches.`),
    fallbacks: fallback,
    reason: invalid
      ? `${runtimeLabel(runtime)} cannot launch "${configuredModel}"; the safe effective route uses its adapter default.`
      : constrainedByProfile
        ?? (configuredModel
          ? `The operator pinned ${configuredModel} for the default worker.`
          : `No worker model is pinned, so ${runtimeLabel(runtime)} uses its runtime default.`),
    changePath: 'Settings → Models & providers → Default workers',
    settingKeys: [
      'subscriptionProfile',
      'defaultDispatchRuntime',
      'defaultDispatchModel',
      'codexWorkerEffort',
      'claudeWorkerEffort',
      'crossHouseWorkerFallback',
    ],
  };
}

function reviewRoute(input: ProjectAgentRoleRoutesInput, orchestrate: AgentRoleRoute): AgentRoleRoute {
  const { values, sources, dispatchableRuntimes } = input;
  const backend = values.reviewerBackend === 'follow'
    ? orchestrate.effective.backend ?? 'codex'
    : values.reviewerBackend;
  const runtime = backendRuntime(backend);
  const effective = choice({
    backend,
    runtime,
    model: backendModel(values, backend),
    effort: values.thinkingEffort ?? null,
  });
  const constrainedByProfile = profileReason(values, sources.reviewerBackend);
  return {
    id: 'review',
    ...ROLE_META.review,
    configured: choice({
      backend: values.reviewerBackend,
      runtime: values.reviewerBackend === 'follow' ? null : runtime,
      model: null,
      effort: null,
    }),
    effective,
    sources: {
      backend: sources.reviewerBackend,
      runtime: values.reviewerBackend === 'follow' ? 'derived' : sources.reviewerBackend,
      model: backendModelSource(values, backend, sources),
      effort: sources.thinkingEffort,
    },
    availability: runtimeAvailability(
      runtime,
      dispatchableRuntimes,
      `${backendLabel(backend)} validates its own connection when review starts.`,
    ),
    fallbacks: values.reviewerBackend === 'follow' ? ['Changes whenever the Orchestrate backend changes.'] : [],
    reason: constrainedByProfile
      ?? (values.reviewerBackend === 'follow'
        ? `Review follows Orchestrate, currently ${backendLabel(backend)}.`
        : `${backendLabel(backend)} is pinned for review.`),
    changePath: 'Settings → Models & providers → Chat & code review',
    settingKeys: ['subscriptionProfile', 'reviewerBackend', 'orchestratorBackend', 'inAppOrchestratorEnabled', 'orchestratorModel'],
  };
}

function brainRoute(input: ProjectAgentRoleRoutesInput): AgentRoleRoute {
  const { values, sources, dispatchableRuntimes } = input;
  const configuredComposer = values.classAComposer;
  const autoRouting = values.brainRoutingMode === 'auto';
  const managedBrainEligible = input.managedBrainEligible === true;
  let backend = 'auto-cascade';
  let runtime: OrchestratorRuntime | null = null;
  let model: string | null = null;
  let reason = autoRouting && managedBrainEligible
    ? 'Auto uses the authorized managed inference route. Availability or quota errors stay visible and do not spend another provider.'
    : autoRouting
      ? 'Auto uses the existing configured Brain route.'
    : 'Subscription mode uses the connected subscription CLI cascade.';
  let modelSource: RoleRouteSource = 'request-time';

  if (autoRouting && managedBrainEligible) {
    backend = 'managed-inference';
    model = 'managed';
  } else if (!autoRouting && (configuredComposer === 'haiku-cli' || configuredComposer === 'sonnet-cli')) {
    backend = 'claude';
    runtime = 'claude-code';
    model = configuredComposer === 'haiku-cli' ? 'haiku' : 'sonnet';
    reason = `${model === 'haiku' ? 'Haiku' : 'Sonnet'} is pinned for Brain composition through the Claude CLI.`;
    modelSource = sources.classAComposer;
  } else if (!autoRouting && configuredComposer === 'fastest') {
    backend = 'managed-inference';
    model = 'fastest-available';
    reason = 'Brain composition is pinned to the fastest available managed route.';
    modelSource = sources.classAComposer;
  }

  const localFallback = values.localInferenceBaseUrl && values.localChatModel
    ? `Local model ${values.localChatModel}`
    : 'Local inference is not configured';
  const fallbacks = [
    ...(autoRouting
      ? managedBrainEligible
        ? ['Managed inference, with a visible managed error rather than another payer.']
        : ['Existing configured Brain route.']
      : [localFallback, values.brainUseClaudeCli ? 'Signed-in Claude CLI' : 'Claude CLI is disabled for Brain', `Signed-in Codex CLI (${values.brainCodexModel})`, 'BYOK provider route', 'Deterministic heuristic answer']),
  ];
  const effective = choice({ backend, runtime, model, effort: null });
  return {
    id: 'brain',
    ...ROLE_META.brain,
    configured: choice({ backend: values.brainRoutingMode, runtime: null, model: null, effort: null }),
    effective,
    sources: {
      backend: sources.brainRoutingMode,
      runtime: runtime ? 'derived' : 'request-time',
      model: modelSource,
      effort: 'request-time',
    },
    availability: runtimeAvailability(
      runtime,
      dispatchableRuntimes,
      'The exact Brain route is selected and receipted when each request runs.',
    ),
    fallbacks,
    reason,
    changePath: 'Settings → Models & providers → Advanced routing',
    settingKeys: [
      'brainRoutingMode',
      'classAComposer',
      'brainUseClaudeCli',
      'brainCodexModel',
      'brainCodexEffort',
      'localInferenceBaseUrl',
      'localChatModel',
    ],
  };
}

function triageRoute(input: ProjectAgentRoleRoutesInput): AgentRoleRoute {
  const { values, sources, dispatchableRuntimes } = input;
  const { runtime, effort } = values.targetingTriage;
  const configuredModel = cleanModel(values.targetingTriage.model);
  const model = runtimeModel(runtime, configuredModel);
  const invalid = configuredModel && model.incompatible;
  return {
    id: 'triage',
    ...ROLE_META.triage,
    configured: choice({ backend: null, runtime, model: configuredModel, effort }),
    effective: choice({ backend: null, runtime, model: model.effective, effort }),
    sources: {
      backend: 'derived',
      runtime: sources.targetingTriage,
      model: configuredModel && !model.incompatible ? sources.targetingTriage : model.source,
      effort: sources.targetingTriage,
    },
    availability: invalid
      ? incompatibleAvailability(runtime, configuredModel)
      : runtimeAvailability(runtime, dispatchableRuntimes, `${runtimeLabel(runtime)} validates when triage starts.`),
    fallbacks: configuredModel ? [] : [`${runtimeLabel(runtime)} chooses its adapter default model.`],
    reason: invalid
      ? `${runtimeLabel(runtime)} cannot launch "${configuredModel}"; the safe effective route uses its adapter default.`
      : configuredModel
        ? `Triage is pinned to ${configuredModel}.`
        : `Triage uses the ${runtimeLabel(runtime)} runtime default.`,
    changePath: 'Settings → Models & providers → Thinking & task models',
    settingKeys: ['targetingTriage'],
  };
}

function recoveryRoute(build: AgentRoleRoute): AgentRoleRoute {
  return {
    id: 'recovery',
    ...ROLE_META.recovery,
    configured: choice({ backend: 'packet-worker', runtime: null, model: null, effort: null }),
    effective: { ...build.effective },
    sources: {
      backend: 'derived',
      runtime: 'derived',
      model: 'derived',
      effort: 'derived',
    },
    availability: { ...build.availability },
    fallbacks: ['Recovery reuses the packet\'s persisted worker routing before any quota fallback is considered.'],
    reason: 'Recovery follows the packet\'s persisted worker route, so a restart does not silently choose a different model.',
    changePath: 'Packet override, then Settings → Models & providers → Default workers',
    settingKeys: [
      'defaultDispatchRuntime',
      'defaultDispatchModel',
      'codexWorkerEffort',
      'claudeWorkerEffort',
      'crossHouseWorkerFallback',
    ],
  };
}

export function projectAgentRoleRoutes(input: ProjectAgentRoleRoutesInput): AgentRoleRoute[] {
  const orchestrate = orchestrateRoute(input);
  const build = buildRoute(input);
  return [
    orchestrate,
    build,
    reviewRoute(input, orchestrate),
    brainRoute(input),
    triageRoute(input),
    recoveryRoute(build),
  ];
}
