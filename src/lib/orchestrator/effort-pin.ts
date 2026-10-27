import { homedir } from 'node:os';
import { join } from 'node:path';
import { getCodexSpeedCatalogue } from '@/lib/codex/service-tier-catalogue';
import { getOrPinPacketRuntimeIdentity, getSelectedRuntimeIdentity } from '@/lib/runtime/identity-catalog';
import { codexCliSupportsUltraEfforts, resolveCodexReasoningEffort } from '@/lib/codex/reasoning-effort';
import { parseLocalModel } from '@/lib/codex/local-model';
import { getRuntimeCapability, isOrchestratorRuntime } from '@/lib/orchestrator/runtime-capabilities';
import {
  THINKING_EFFORTS,
  claudeEffortFlagValue,
  isThinkingEffort,
  type ThinkingEffort,
} from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorRuntime, WorkerModelDisposition } from '@/lib/orchestrator/types';
import { museWorkerModelContext, probeMuseModels } from '@/lib/muse/models';
import { museRoot } from '@/lib/muse/roots';

/**
 * Explicit mission reasoning-effort pinning.
 *
 * A caller may pin a concrete tier (`low`…`ultra`). This route only accepts a
 * pin when the selected runtime + model will pass it through UNCHANGED. It is
 * the o8 route that cannot honor a coerced or dropped tier — NOT a claim that
 * the provider never supports that effort. The provider's own catalog drift
 * (e.g. a freshly installed CLI advertising a tier this adapter clamps) belongs
 * to the compatibility audit, not this pin.
 *
 * `adaptive` is not a concrete pin: it is the explicit "reset to the runtime
 * default" selection and resolves to null here, matching omitted effort.
 */

export type ConcreteThinkingEffort = Exclude<ThinkingEffort, 'adaptive'>;

/** Operator-facing effort list used in validation errors (single source: THINKING_EFFORTS). */
export const EFFORT_CHOICE_LIST = THINKING_EFFORTS.join(', ');

/**
 * The concrete effort tier the runtime adapter will actually hand to its CLI
 * for the selected model. Reuses the adapter-specific resolvers so this stays
 * the single mapping rather than a competing effort table.
 */
export function resolveAdapterEffort(
  runtime: OrchestratorRuntime,
  model: string | null,
  effort: ConcreteThinkingEffort,
): string {
  if (runtime === 'codex' || runtime === 'cloud') return resolveCodexReasoningEffort(effort, model);
  if (runtime === 'claude-code') return claudeEffortFlagValue(effort);
  return effort;
}

export type EffortPinErrorCode =
  | 'invalid_effort'
  | 'conflicting_effort'
  | 'effort_unsupported_runtime'
  | 'effort_model_incompatible'
  | 'effort_unsupported_model'
  | 'effort_coerced'
  | 'effort_cli_incompatible';

/** Thrown by dispatch/runtime seams so routes can return a typed 400. */
export class EffortPinRejectionError extends Error {
  constructor(public readonly code: EffortPinErrorCode, message: string) {
    super(message);
    this.name = 'EffortPinRejectionError';
  }
}

export type ResolveEffortPinResult =
  | { ok: true; requestedEffort: ThinkingEffort | null; selectedEffort: ThinkingEffort | null }
  | { ok: false; code: EffortPinErrorCode; message: string };

/**
 * Resolve the two API effort aliases (`requestedEffort` / `thinkingEffort`)
 * into one pin. Each present alias is validated independently so a malformed
 * value can never hide behind the other; two different explicit values are a
 * conflict rather than first-wins.
 */
export function resolveEffortAliases(
  requestedEffort: unknown,
  thinkingEffort: unknown,
): ResolveEffortPinResult {
  for (const value of [requestedEffort, thinkingEffort]) {
    if (value === undefined || value === null) continue;
    if (!isThinkingEffort(value)) {
      return { ok: false, code: 'invalid_effort', message: `effort must be one of: ${EFFORT_CHOICE_LIST}.` };
    }
  }
  const requested = isThinkingEffort(requestedEffort) ? requestedEffort : null;
  const thinking = isThinkingEffort(thinkingEffort) ? thinkingEffort : null;
  if (requested && thinking && requested !== thinking) {
    return {
      ok: false,
      code: 'conflicting_effort',
      message: `requestedEffort "${requested}" conflicts with thinkingEffort "${thinking}". Send one effort value.`,
    };
  }
  const value = requested ?? thinking;
  return { ok: true, requestedEffort: value, selectedEffort: value === 'adaptive' ? null : value };
}

/**
 * A routing whose concrete requested effort was actually honored at creation
 * (`selectedEffort === requestedEffort`). Only this class of pin is enforced
 * after the fact — a deliberately no-op effort on a runtime without a
 * reasoning surface (e.g. the Targeting Machine's Gemini/OpenCode tiers) keeps
 * its legacy "request recorded, not applied" semantics.
 */
export function isHonoredEffortPin(
  routing: { requestedEffort?: ThinkingEffort | null; selectedEffort?: ThinkingEffort | null } | null | undefined,
): boolean {
  return Boolean(routing?.requestedEffort && routing.selectedEffort === routing.requestedEffort);
}

export interface ResolveEffortPinInput {
  /** Raw caller value. Omitted / null => no pin (parity). */
  requestedEffort: unknown;
  runtime: string;
  /** The model that will actually launch (selected, or the runtime default). */
  model: string | null;
  /** The caller's explicit model identity, BEFORE any routing normalization. */
  explicitModel?: string | null;
  modelDisposition?: WorkerModelDisposition;
  /** Present when the launch boundary has resolved the installed executable. */
  installedCliVersion?: string | null;
  /** Fresh model/list evidence from the account that will run this selection. */
  modelEfforts?: readonly string[] | null;
}

export function resolveEffortPin(input: ResolveEffortPinInput): ResolveEffortPinResult {
  const raw = input.requestedEffort;
  if (raw === undefined || raw === null) {
    return { ok: true, requestedEffort: null, selectedEffort: null };
  }
  if (!isThinkingEffort(raw)) {
    return {
      ok: false,
      code: 'invalid_effort',
      message: `effort must be one of: ${EFFORT_CHOICE_LIST}.`,
    };
  }
  if (raw === 'adaptive') {
    // Explicit reset: not a concrete pin, so the runtime default applies.
    return { ok: true, requestedEffort: null, selectedEffort: null };
  }
  if (!isOrchestratorRuntime(input.runtime) || !getRuntimeCapability(input.runtime).reasoningEffort) {
    return {
      ok: false,
      code: 'effort_unsupported_runtime',
      message: `This o8 mission route cannot honor effort "${raw}" on runtime "${input.runtime}": that worker runtime has no reasoning-effort surface, so the pin would be dropped. Request a runtime that supports reasoning effort (codex or claude-code) or omit --effort.`,
    };
  }
  if ((input.runtime === 'codex' || input.runtime === 'cloud')
    && (input.model?.trim().toLowerCase() === 'gpt-4o' || parseLocalModel(input.model))) {
    return {
      ok: false, code: 'effort_unsupported_model',
      message: `Effort "${raw}" has no verified reasoning transport for model "${input.model}". Omit effort or choose a reasoning model.`,
    };
  }
  // Judge the CALLER'S explicit model against what will actually launch, not a
  // pre-normalized routing value (profile resolution can drop a foreign-house
  // model before resolveWorkerRouting ever sees it).
  const explicitModel = input.explicitModel?.trim() || null;
  const actualModel = input.model?.trim() || null;
  if (explicitModel && actualModel !== explicitModel) {
    return {
      ok: false,
      code: 'effort_model_incompatible',
      message: `This o8 mission route cannot honor effort "${raw}" because the requested model "${explicitModel}" would not be used on runtime "${input.runtime}" (the route resolved "${actualModel ?? 'the runtime default'}"). Pin a compatible model or omit --effort.`,
    };
  }
  if (input.modelDisposition === 'rejected-incompatible') {
    const requested = explicitModel || 'the requested model';
    return {
      ok: false,
      code: 'effort_model_incompatible',
      message: `This o8 mission route cannot honor effort "${raw}" because ${requested} is not compatible with runtime "${input.runtime}" and the launch would silently fall back to a different model. Pin a compatible model or omit --effort.`,
    };
  }
  if ((input.runtime === 'muse' || (input.runtime === 'codex' && Object.hasOwn(input, 'modelEfforts')))
    && (!actualModel || !input.modelEfforts?.includes(raw))) {
    return { ok: false, code: 'effort_unsupported_model',
      message: `Cannot honor effort "${raw}" for model "${actualModel ?? 'runtime default'}": its current account catalog does not establish that selection. Choose a listed model and effort or omit effort.` };
  }
  const applied = resolveAdapterEffort(input.runtime, actualModel, raw);
  if (applied !== raw) {
    return {
      ok: false,
      code: 'effort_coerced',
      message: `This o8 mission route cannot honor effort "${raw}" for runtime "${input.runtime}" model "${actualModel ?? 'runtime default'}": the current adapter would change it to "${applied}". Request a supported tier or omit --effort.`,
    };
  }
  if ((input.runtime === 'codex' || input.runtime === 'cloud') && Object.hasOwn(input, 'installedCliVersion')
    && (raw === 'max' || raw === 'ultra') && !codexCliSupportsUltraEfforts(input.installedCliVersion)) {
    return { ok: false, code: 'effort_cli_incompatible',
      message: `Cannot honor effort "${raw}" on runtime "${input.runtime}" with installed CLI version "${input.installedCliVersion ?? 'unknown'}": compatibility would change the selection to "xhigh". Update the CLI or choose a supported effort.` };
  }
  return { ok: true, requestedEffort: raw, selectedEffort: raw };
}

/** Match the owned worker's selected account, or its durable packet binding. */
export async function resolveCodexWorkerConfigHome(packetId?: string): Promise<string> {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const identity = packetId
    ? await getOrPinPacketRuntimeIdentity({ runtime: 'codex', packetId,
      fallback: { id: 'codex-local-default', label: 'Current local sign-in', configHomeRef: home } })
    : await getSelectedRuntimeIdentity('codex');
  return identity?.configHomeRef ?? home;
}

/** Shared last admission boundary for owned launch, cold resume and automatic retries. */
export async function resolveRuntimeEffortPin(input: ResolveEffortPinInput, context: { cwd?: string; runtimeConfig?: Record<string, string>; configHome?: string; packetId?: string } = {}): Promise<ResolveEffortPinResult> {
  if (!isThinkingEffort(input.requestedEffort) || input.requestedEffort === 'adaptive') return resolveEffortPin(input);
  if (input.runtime !== 'muse' && input.runtime !== 'codex') return resolveEffortPin(input);
  if (input.runtime === 'codex') {
    const transport = resolveEffortPin(input);
    if (!transport.ok) return transport;
    try {
      const home = context.configHome ?? await resolveCodexWorkerConfigHome(context.packetId);
      const catalog = await getCodexSpeedCatalogue(home, true);
      const model = input.model?.trim() || catalog.nativeDefaultModel || null;
      return resolveEffortPin({ ...input, model, modelEfforts: model ? catalog.reasoningEfforts?.[model] ?? null : null });
    } catch {
      return { ok: false, code: 'effort_unsupported_model', message: 'Cannot verify this model effort with the selected account. Refresh the model catalog or omit effort; no worker was started.' };
    }
  }
  try {
    const config = await museWorkerModelContext(context.runtimeConfig);
    // Packet launches retain their durable account after the selection changes.
    // Resume/retry pass the session's roots explicitly and keep that association.
    const identity = context.packetId ? await getOrPinPacketRuntimeIdentity({
      runtime: 'muse', packetId: context.packetId,
      fallback: { id: 'muse-local-default', label: 'Current local sign-in', configHomeRef: config.museConfigRoot },
    }) : null;
    const configHome = context.configHome ?? identity?.configHomeRef;
    const discoveryConfig = configHome ? { ...config, museConfigRoot: museRoot(configHome, true) } : config;
    const catalog = await probeMuseModels(context.cwd ?? process.cwd(), true, discoveryConfig);
    const model = input.model?.trim() || catalog.models.find(row => row.isDefault)?.id || null;
    return resolveEffortPin({ ...input, model, modelEfforts: catalog.models.find(row => row.id === model)?.efforts });
  } catch {
    return { ok: false, code: 'effort_unsupported_model', message: 'Cannot verify this model effort with the selected account. Refresh the model catalog or omit effort; no worker was started.' };
  }
}

export async function assertRuntimeEffortPin(runtime: string, model: string | null | undefined, effort: unknown,
  context?: { cwd?: string; runtimeConfig?: Record<string, string>; configHome?: string; packetId?: string }): Promise<void> {
  const pin = await resolveRuntimeEffortPin({ runtime, model: model ?? null, requestedEffort: effort }, context);
  if (!pin.ok) throw new EffortPinRejectionError(pin.code, pin.message);
}
