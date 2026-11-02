type Json = Record<string, unknown>;

const NOT_ANSWERED = 'The subagent finished without a reply.';
const OUTLIVED = 'Still running when the turn ended.';

function title(agentPath: unknown): string {
  const name = String(agentPath ?? '').split('/').filter(Boolean).pop() ?? 'Subagent';
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : 'Subagent';
}

function output(callId: string, text: string, isError: boolean): Json {
  return {
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: callId, name: 'Agent', output: text, ...(isError ? { is_error: true } : {}) },
  };
}

/**
 * Codex reports a subagent as activity items keyed by its thread. They carry no
 * answer, so the child thread's last message is kept here, and each agent reads
 * as one Agent call that stays running until its completed item.
 */
export function createSubagentTracker() {
  const calls = new Map<string, string>();
  const answers = new Map<string, string>();
  return {
    childMessage(thread: string, message: string) {
      if (message.trim()) answers.set(thread, message);
    },
    activity(item: Json): Json[] {
      const thread = String(item.agentThreadId ?? '');
      if (!thread) return [];
      const call = calls.get(thread);
      if (item.kind === 'started' && !call) {
        const id = String(item.id ?? thread);
        calls.set(thread, id);
        return [{
          type: 'item.completed',
          item: {
            type: 'tool_use',
            id,
            name: 'Agent',
            arguments: { description: title(item.agentPath), subagent_type: 'codex', ...(item.model ? { model: item.model } : {}) },
          },
        }];
      }
      if (!call || (item.kind !== 'completed' && item.kind !== 'interrupted')) return [];
      calls.delete(thread);
      const answer = answers.get(thread);
      return [output(call, answer ?? NOT_ANSWERED, item.kind === 'interrupted' || answer === undefined)];
    },
    /** A turn can end before an agent it did not wait for. */
    finish(): Json[] {
      const open = [...calls.values()].map((call) => output(call, OUTLIVED, false));
      calls.clear();
      return open;
    },
  };
}
