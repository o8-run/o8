/**
 * Settings › Providers switch enforcement (`disabledRuntimes`,
 * `[providers] disabled_runtimes`). A disabled runtime cannot start a new
 * session; a thread that already has messages keeps its runtime.
 */
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { readOrchestratorThreadMessages } from '@/lib/mobile/orchestrator-thread-history';

/** Composer backend id → runtime id used by the Providers list. */
export function runtimeForBackend(backend: string): string {
  return backend === 'claude' ? 'claude-code' : backend;
}

export function isRuntimeDisabled(runtime: string, disabled: readonly string[]): boolean {
  return disabled.includes(runtimeForBackend(runtime));
}

/**
 * The refusal text for a send that would open a new session on a disabled
 * runtime, or null when the send may proceed. Existing threads always pass.
 */
export function disabledRuntimeRefusal(input: {
  backend: string;
  threadId: string | null | undefined;
  disabled?: readonly string[];
  hasHistory?: (threadId: string) => boolean;
}): string | null {
  const disabled = input.disabled ?? getOperatorDefaultsSync().values.disabledRuntimes ?? [];
  if (!isRuntimeDisabled(input.backend, disabled)) return null;
  const hasHistory = input.hasHistory ?? (id => readOrchestratorThreadMessages(id).length > 0);
  if (input.threadId && hasHistory(input.threadId)) return null;
  return `${runtimeForBackend(input.backend)} is turned off in Settings › Providers. Turn it on or pick another runtime for new sessions.`;
}
