import { observeSteerTranscript } from '@/lib/ws-server/steer-transcript-anchor';
import { observeOrchestratorToolHistory } from '@/lib/orchestrator/tool-history';
import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import { createBackendRoleRouteChoice } from '@/lib/operator/role-routing';
import { recordRoleRoutingReceiptSafely } from '@/lib/operator/role-routing-ledger';
import type { ComposerWireMode } from '@/lib/orchestrator/composer-wire';
import { resolveOrchestratorExecutionMode } from './orchestrator-backends/orchestration-mode';
import { assertOrchestratorPermissionMode } from '@/lib/orchestrator/permission-mode';
import type { OrchestratorBackend, OrchestratorBackendId, OrchestratorTurnOptions } from './orchestrator-backends/types';

/** Resolve the selected backend before subscriptions and persistence are built. */
export function resolveOrchestratorExecutionBackendId(
  requestedBackendId: OrchestratorBackendId,
  rawOrchestrationMode: unknown,
): OrchestratorBackendId {
  void rawOrchestrationMode;
  return requestedBackendId;
}

/** Solo must stay on the selected runtime rather than silently changing houses. */
export function orchestratorModeAllowsBackendFallback(rawOrchestrationMode: unknown, pinBackend: unknown = false): boolean {
  return pinBackend !== true && resolveOrchestratorExecutionMode(rawOrchestrationMode) !== 'single';
}

export function resolveTurnReceiptMode(
  backendId: OrchestratorBackendId,
  rawOrchestrationMode: unknown,
  pickedMode?: ComposerWireMode,
): ComposerWireMode {
  const executionMode = resolveOrchestratorExecutionMode(rawOrchestrationMode);
  if (executionMode === 'single') return 'solo';
  if (executionMode === 'fusion') return 'fusion';
  if (backendId === 'collide') return 'moa';
  // Shared dispatch uses the fleet engine; that is not a change to the mode
  // selected by the operator. Solo and Fusion overrides above still win.
  return pickedMode === 'fast' ? 'fast' : 'multitask';
}

/** Backend invocation seam used by ws-server's orchestrator-send handler. */
export async function sendOrchestratorBackendTurn(
  backend: OrchestratorBackend,
  repoPath: string,
  message: string,
  onEvent: (event: OrchestratorEvent) => void,
  options: OrchestratorTurnOptions,
  rawOrchestrationMode: unknown,
  leadingEvents: readonly OrchestratorEvent[] = [],
): Promise<void> {
  try {
    assertOrchestratorPermissionMode(backend.id, options.permissionMode, options.toolProfile);
  } catch (error) {
    return Promise.reject(error);
  }
  for (const event of leadingEvents) onEvent(event);
  const requested = createBackendRoleRouteChoice(
    backend.id,
    options.model ?? null,
    options.thinkingEffort ?? null,
  );
  const routedOptions = {
    ...options,
    orchestrationMode: resolveOrchestratorExecutionMode(rawOrchestrationMode),
  };
  const record = (status: 'selected' | 'failed', reason: string) => {
    recordRoleRoutingReceiptSafely({
      role: 'orchestrate',
      repoPath,
      contextType: 'orchestrator-thread',
      contextId: options.threadId ?? null,
      requested,
      effective: requested,
      sources: {
        backend: 'request-time',
        runtime: 'derived',
        model: options.model ? 'request-time' : 'runtime-default',
        effort: options.thinkingEffort ? 'request-time' : 'runtime-default',
      },
      reason,
      status,
    });
  };
  const transcript = observeSteerTranscript(repoPath, options.threadId, options.transcriptMessageId ?? options.crashSurvival?.assistantMessageId);
  const toolHistory = observeOrchestratorToolHistory(repoPath, options.threadId,
    options.transcriptMessageId ?? options.crashSurvival?.assistantMessageId, backend.id);
  try {
    return await backend.sendTurn(repoPath, message, event => { transcript.event(event); toolHistory.event(event); onEvent(event); }, routedOptions)
      .then(() => {
        record('selected', `${backend.label} completed the orchestrator turn.`);
      })
      .catch((error) => {
        record('failed', `${backend.label} failed the orchestrator turn: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      });
  } finally { transcript.close(); toolHistory.flush(); }
}
