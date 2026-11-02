type Json = Record<string, unknown>;

const DONE = new Set(['completed', 'errored', 'interrupted', 'shutdown', 'notFound']);
const TITLE_CHARS = 60;

function title(prompt: string): string {
  const line = prompt.split('\n').find((row) => row.trim())?.trim() ?? '';
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS).trimEnd()}…` : line;
}

/**
 * Codex reports its subagents as collab items. A spawn returns at once, and an
 * agent's answer arrives later in agentsStates on any collab item, so each
 * spawn is reported as one Agent call that stays running until that answer.
 */
export function createCollabTracker() {
  const calls = new Map<string, string>();
  return {
    lines(phase: 'started' | 'completed', item: Json): Json[] {
      const id = String(item.id ?? '');
      const prompt = typeof item.prompt === 'string' ? item.prompt : '';
      const lines: Json[] = [];
      if (item.tool === 'spawnAgent' && phase === 'started') {
        lines.push({
          type: 'item.completed',
          item: {
            type: 'tool_use',
            id,
            name: 'Agent',
            arguments: { description: title(prompt), prompt, ...(item.model ? { model: item.model } : {}) },
          },
        });
      }
      if (phase === 'started') return lines;
      if (item.tool === 'spawnAgent') {
        const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
        for (const thread of receivers) calls.set(String(thread), id);
        if (item.status === 'failed' || receivers.length === 0) {
          lines.push(output(id, 'The subagent did not start.'));
        }
      }
      for (const [thread, state] of Object.entries((item.agentsStates ?? {}) as Record<string, Json | undefined>)) {
        const call = calls.get(thread);
        if (!call || !state || !DONE.has(String(state.status))) continue;
        calls.delete(thread);
        lines.push(output(call, typeof state.message === 'string' && state.message ? state.message : String(state.status)));
      }
      return lines;
    },
  };
}

function output(callId: string, text: string): Json {
  return { type: 'response_item', payload: { type: 'function_call_output', call_id: callId, name: 'Agent', output: text } };
}
