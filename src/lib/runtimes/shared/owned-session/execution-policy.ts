import { controlledProviderPins } from './controlled-provider';
import { isManualThinkingEffort, type ManualThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import { assertRuntimeEffortPin, resolveEffortPin } from '@/lib/orchestrator/effort-pin';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { CODEX_MODEL_IDS, SUPPORTED_MODEL_IDS } from '@/lib/models';
import type { OwnedLaunchRequest, OwnedRunMode, OwnedRuntimeAdapter, OwnedSessionRecord } from './types';

export interface OwnedExecutionPolicy {
  version: 1;
  mode: 'single-attempt';
  runtime: string;
  model: string;
  effort: ManualThinkingEffort | undefined;
  runtimeConfig: Record<string, string>;
}

function configKey(config?: Record<string, string>): string {
  return JSON.stringify(Object.entries(config ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

function nativeModel(runtime: string, model: string): boolean {
  return runtime === 'codex' ? CODEX_MODEL_IDS.some((entry) => entry === model)
    : runtime === 'claude-code' && model.startsWith('claude-') && SUPPORTED_MODEL_IDS.some((entry) => entry === model);
}

export function createOwnedExecutionPolicy(request: OwnedLaunchRequest, runtime: string, codexHome?: string): OwnedExecutionPolicy | undefined {
  if (request.executionPolicy === undefined) return undefined;
  const controlled = !!request.controlledTask && runtime === 'claude-code'
    && controlledProviderPins(request.model, request.effort, request.runtimeConfig);
  if (request.executionPolicy !== 'single-attempt' || !['codex', 'claude-code'].includes(runtime)
    || !request.model?.trim() || request.model !== request.model.trim()
    || (!controlled && !isManualThinkingEffort(request.effort)) || request.runtimeConfig?.workMode !== 'read-only') {
    throw new Error('Single-attempt workers require an explicit runtime, model, concrete effort and enforced read-only mode.');
  }
  if (controlled) return { version: 1, mode: 'single-attempt', runtime, model: request.model!,
    effort: undefined, runtimeConfig: { ...request.runtimeConfig } };
  const effort = resolveEffortPin({ runtime: runtime as OrchestratorRuntime, model: request.model,
    explicitModel: request.model, requestedEffort: request.effort, codexHome });
  if (!effort.ok || effort.selectedEffort !== request.effort
    || !nativeModel(runtime, request.model)
    || request.runtimeConfig.executionCarrier !== undefined
    || (request.runtimeConfig.modelSource !== undefined && request.runtimeConfig.modelSource !== 'native')) {
    throw new Error('Single-attempt workers require exact native model and effort pins without another execution carrier.');
  }
  return { version: 1, mode: 'single-attempt', runtime, model: request.model,
    effort: request.effort as ManualThinkingEffort, runtimeConfig: { ...request.runtimeConfig } };
}

/** Preserve early legacy admission; discovery-only tiers wait for account selection. */
export function resolveOwnedLaunchPolicy(request: OwnedLaunchRequest, adapter: OwnedRuntimeAdapter,
  account: { deferDiscovery?: boolean; identity?: OwnedSessionRecord['identity'] } = {}): OwnedExecutionPolicy | undefined {
  if (account.deferDiscovery && adapter.runtimeId === 'codex'
    && (request.effort === 'none' || request.effort === 'minimal')) return undefined;
  const codexHome = account.identity?.configHomeRef ?? adapter.defaultConfigHome?.();
  const policy = createOwnedExecutionPolicy(request, adapter.runtimeId, codexHome);
  assertRuntimeEffortPin(adapter.runtimeId, request.model ?? adapter.defaultModel, request.effort, codexHome);
  return policy;
}

/** An execution limit, not an authorization, account grant or dispatch receipt. */
export function assertOwnedSingleAttemptSpawn(session: OwnedSessionRecord, runtime: string, mode: OwnedRunMode): void {
  const policy = session.executionPolicy;
  if (policy === undefined) return;
  const fresh = createOwnedExecutionPolicy({ cwd: session.cwd, prompt: session.latestPrompt,
    controlledTask: session.controlledTask, executionPolicy: 'single-attempt',
    model: session.model, effort: session.effort, runtimeConfig: session.runtimeConfig }, runtime, session.identity?.configHomeRef);
  if (policy?.version !== 1 || policy.mode !== 'single-attempt' || policy.runtime !== runtime
    || policy.model !== session.model || policy.effort !== session.effort
    || configKey(fresh?.runtimeConfig) !== configKey(policy.runtimeConfig)
    || configKey(policy.runtimeConfig) !== configKey(session.runtimeConfig)
    || mode !== 'launch' || session.activeRun || session.recentRuns.length !== 0
    || session.runIdentityLedger?.version !== 1 || session.runIdentityLedger.complete !== true
    || session.runIdentityLedger.totalRuns !== 0) {
    throw new Error('Single-attempt worker refused: its pins changed or its attempt is already consumed or uncertain.');
  }
}

export function refuseOwnedSingleAttemptResume(session: OwnedSessionRecord | null): void {
  if (session?.executionPolicy !== undefined) {
    throw new Error('Single-attempt workers cannot resume or retry. Review the result and prepare a new task.');
  }
}

/** Re-read policy after asynchronous setup before admitting a process spawn. */
export function assertDurableOwnedSpawn(session: OwnedSessionRecord | null, expected: OwnedSessionRecord, runtime: string, mode: OwnedRunMode): asserts session is OwnedSessionRecord {
  if (!session) throw new Error('Owned session disappeared before its run could start.');
  if (JSON.stringify(session.executionPolicy) !== JSON.stringify(expected.executionPolicy)) {
    throw new Error('Single-attempt worker policy changed before spawn.');
  }
  if (JSON.stringify(session.controlledTask) !== JSON.stringify(expected.controlledTask)) {
    throw new Error('Controlled task binding changed before spawn.');
  }
  assertOwnedSingleAttemptSpawn(session, runtime, mode);
}
