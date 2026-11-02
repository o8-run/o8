import { ORCHESTRATOR_RUNTIMES, getRuntimeCapability } from '@/lib/orchestrator/runtime-capabilities';
import type { OrchestratorRuntime } from '@/lib/orchestrator/types';
import { MODEL_IDS } from '@/lib/models';

/**
 * Cross-house model bleed guard, driven by the runtime registry.
 *
 * The composer passes whatever model it holds, and when that model belongs to
 * another house the CLI is handed an id it cannot launch. It has happened in
 * both directions: a claude id reaching `codex exec` hung the turn forever with
 * nothing streamed (live hit 2026-07-05), and `gpt-5.6-sol` --
 * `default_dispatch_model`, the Codex WORKER model -- reaching the Claude
 * harness failed a fresh solo turn immediately (#1807).
 *
 * Each of those was patched where it was found, one house at a time. With 18
 * dispatchable runtimes that does not converge: every new pairing is the same
 * bug wearing a different model id. The constraint belongs to the runtime, so
 * it lives on the runtime's registry row as `modelIdPattern`, and a runtime
 * that fronts several providers simply omits it.
 */

/**
 * Whether `model` is an id `runtimeId` can actually launch.
 *
 * A runtime with no declared pattern is multi-provider or unknown, and returns
 * true: refusing to guess is the point. A wrong constraint blocks a valid
 * selection, which is worse than the bug it would prevent.
 */
export function modelBelongsToRuntime(model: string, runtimeId: OrchestratorRuntime): boolean {
  const trimmed = model.trim();
  if (!trimmed) return false;
  const pattern = getRuntimeCapability(runtimeId)?.modelIdPattern;
  if (!pattern) return true;
  return pattern.test(trimmed);
}

/**
 * The operator's model selection, if any. Threads created without a lead saved
 * a runtime id ("claude-code", "codex") as their model, and a thread can switch
 * houses afterwards; a runtime id is no selection, so it neither reaches a CLI
 * nor counts as an explicit model for effort pins.
 */
export function selectedOrchestratorModel(requested: string | undefined): string | undefined {
  const trimmed = requested?.trim();
  return trimmed && !Object.hasOwn(ORCHESTRATOR_RUNTIMES, trimmed.toLowerCase()) ? trimmed : undefined;
}

/**
 * The model an orchestrator turn on `runtimeId` should launch with.
 *
 * A model from another house is a backend mismatch, not an operator choice, so
 * it falls through to the runtime's default rather than reaching the CLI. The
 * rejection is reported with both ids -- silently substituting a model is its
 * own kind of dishonest surface.
 */
export function resolveRuntimeOrchestratorModel(
  requested: string | undefined,
  runtimeId: OrchestratorRuntime,
  defaultModel: string,
  onReject?: (rejected: string, replacement: string, runtimeId: OrchestratorRuntime) => void,
): string {
  const trimmed = selectedOrchestratorModel(requested);
  if (!trimmed) return defaultModel;
  if (modelBelongsToRuntime(trimmed, runtimeId)) return trimmed;
  onReject?.(trimmed, defaultModel, runtimeId);
  return defaultModel;
}

export const DEFAULT_CLAUDE_ORCHESTRATOR_MODEL = MODEL_IDS.orchestratorDefault;

export function resolveClaudeOrchestratorModel(requested: string | undefined): string {
  return resolveRuntimeOrchestratorModel(
    requested,
    'claude-code',
    DEFAULT_CLAUDE_ORCHESTRATOR_MODEL,
    (rejected, replacement, runtimeId) => {
      console.warn(`[orchestrator-session] Ignoring model "${rejected}" -- ${runtimeId} cannot launch it; using "${replacement}".`);
    },
  );
}
