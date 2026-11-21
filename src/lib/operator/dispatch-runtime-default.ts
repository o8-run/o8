import type { OrchestratorRuntime } from '@/lib/orchestrator/types';

export type DispatchDefaultOrchestratorBackend =
  | 'auto'
  | 'codex'
  | 'claude'
  | 'openclaw'
  | 'hermes'
  | 'collide'
  | 'fable'
  | 'acp'
  // The free conversational backend never dispatches, but it remains a valid
  // orchestratorBackend setting while the worker default independently falls
  // through to Codex.
  | 'o8'
  // opencode DOES dispatch (its ACP session loads o8's operator MCP server), so
  // unlike 'o8' it is only listed here because the worker default is resolved
  // independently — orchestrating on opencode does not force opencode workers.
  | 'opencode'
  // Bundled Pi dispatches through the same operator server; the worker default
  // is still resolved independently.
  | 'pi';

export interface ResolveDefaultDispatchRuntimeInput {
  explicitRuntime?: OrchestratorRuntime | null;
  orchestratorBackend: DispatchDefaultOrchestratorBackend;
  inAppOrchestratorEnabled?: boolean;
}

export function resolveDefaultDispatchRuntime(
  input: ResolveDefaultDispatchRuntimeInput,
): OrchestratorRuntime {
  if (input.explicitRuntime) return input.explicitRuntime;
  return 'codex';
}
