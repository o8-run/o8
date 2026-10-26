import { resolve } from 'node:path';
import { readPersistedLlmChat } from '@/lib/llm/chat-history-store';
import { isComposerWireMode } from '@/lib/orchestrator/composer-wire';
import { normalizeObservedOrchestratorTurnModel } from '@/lib/orchestrator/turn-model-selection';
import { isManualThinkingEffort } from '@/lib/orchestrator/thinking-effort';

/** A phone continuation uses the last recorded choice on this exact thread. */
export function resolveMobileTurnSelection(
  message: Record<string, unknown>,
  repoPath: string,
  threadId: string | null,
  backend: string,
): Record<string, unknown> {
  if (message.surface !== 'mobile' || !threadId || !threadId.startsWith('thoughts-')) return message;
  // Agent identity is not recorded on these rows; do not borrow another agent's choice.
  if (backend === 'openclaw') return message;
  const history = readPersistedLlmChat(threadId)?.history;
  if (typeof history?.repoPath !== 'string' || resolve(history.repoPath) !== resolve(repoPath)) return message;
  const previous = history.messages.findLast((row) => row?.role === 'assistant');
  if (!previous || previous.backend !== backend) return message;
  const receipt = previous.receipt;
  const inherited: Record<string, unknown> = {};
  const leadModel = normalizeObservedOrchestratorTurnModel(backend, receipt?.leadModel)
    ?? normalizeObservedOrchestratorTurnModel(backend, previous.model);
  if (typeof leadModel === 'string') inherited.model = leadModel;
  if ((!receipt?.effortSource || receipt.effortSource === 'transport') && isManualThinkingEffort(receipt?.effort)) inherited.thinkingEffort = receipt.effort;
  if (receipt?.permissionMode === 'plan' || receipt?.permissionMode === 'full') {
    inherited.permissionMode = receipt.permissionMode;
  }
  if (isComposerWireMode(receipt?.mode)) {
    inherited.orchestrationMode = receipt.mode === 'solo' ? 'single' : receipt.mode === 'fusion' ? 'fusion' : 'fleet';
  }
  const pickedMode = receipt?.pickedMode ?? receipt?.mode;
  if (isComposerWireMode(pickedMode)) inherited.pickedMode = pickedMode;
  // An explicit per-send choice (including the agent-default empty model) wins.
  return { ...inherited, ...message };
}
