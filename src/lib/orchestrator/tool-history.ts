import type { OrchestratorEvent } from '@/lib/lane/orchestrator-stream-events';
import type { MobileTranscriptToolCall } from '@/lib/mobile/types';
import { persistCanonicalChatHistoryRecord, readPersistedLlmChat, withCanonicalChatHistoryLock } from '@/lib/llm/chat-history-store';
import { redactToolCallForRest } from '@/lib/threads/redaction';

/** Keep runtime receipts in canonical history before completed-turn replay is discarded. */
export function observeOrchestratorToolHistory(
  repoPath: string,
  threadId: string | null | undefined,
  assistantMessageId: string | null | undefined,
  backend: string,
) {
  if (!threadId?.startsWith('thoughts-') || !assistantMessageId) return { flush() {}, event(_event: OrchestratorEvent) {} };
  let tools: MobileTranscriptToolCall[] = [];
  let dirty = false;
  const flush = () => {
    if (!dirty || !threadId?.startsWith('thoughts-') || !assistantMessageId) return;
    // Flush only at a terminal boundary, including a thrown/aborted backend.
    const settledTools = tools.map(tool => redactToolCallForRest(tool.status === 'running' ? { ...tool, status: undefined } : tool));
    withCanonicalChatHistoryLock(threadId, () => {
      const saved = readPersistedLlmChat(threadId)?.history;
      // A deleted or reassigned thread must never be recreated by a late event.
      if (!saved || saved.repoPath !== repoPath) return;
      const index = saved.messages.findIndex(message => message.id === assistantMessageId && message.role === 'assistant');
      if (index < 0) return;
      const messages = saved.messages.slice();
      messages[index] = { ...messages[index], toolCalls: settledTools,
        persistedVersion: (messages[index].persistedVersion ?? 0) + 1 };
      persistCanonicalChatHistoryRecord(threadId, { ...saved, messages });
      dirty = false;
    });
  };
  return {
    flush,
    event(event: OrchestratorEvent) {
      if (event.type === 'turn_retry') { tools = []; dirty = true; }
      if (event.type === 'tool_use' || event.type === 'tool_result') {
        const args = event.input && typeof event.input === 'object' && !Array.isArray(event.input)
          ? event.input as Record<string, unknown> : undefined;
        // An identified result never settles a different call. Legacy id-less
        // results can only settle a pending id-less call with the same name.
        const index = event.id ? tools.findIndex(tool => tool.id === event.id)
          : event.type === 'tool_result' ? tools.findIndex(tool => !tool.id && tool.name === event.name && tool.status === 'running') : -1;
        const prior = index >= 0 ? tools[index] : undefined;
        const tool: MobileTranscriptToolCall = {
          ...prior, id: event.id ?? null, name: prior?.name || event.name,
          args: args ?? prior?.args, backend,
          ...(event.type === 'tool_result' ? { status: event.isError ? 'error' : 'done', result: event.output }
            : { status: prior?.status ?? 'running' }),
        };
        tools = index >= 0 ? tools.map((value, position) => position === index ? tool : value) : [...tools, tool];
        dirty = true;
      }
      if (event.type === 'done' || event.type === 'error') {
        flush();
      }
    },
  };
}
