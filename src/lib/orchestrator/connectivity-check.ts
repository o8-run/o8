const PROBE_PROMPT = 'reply with exactly: terminal chat is connected';

/** Match only the known legacy diagnostic, never broader chat content. */
export function isTerminalChatConnectivityPrompt(value: unknown): boolean {
  return typeof value === 'string'
    && value.trim().replace(/\s+/g, ' ').replace(/[.!]$/, '').toLowerCase() === PROBE_PROMPT;
}

/** Preserve renamed checks and conversations that continued into real work. */
export function isSavedConnectivityCheck(record: { title?: unknown; messages?: unknown }): boolean {
  if (record.title && !isTerminalChatConnectivityPrompt(record.title)) return false;
  if (!Array.isArray(record.messages)) return false;
  const users = record.messages.filter(message => message?.role === 'user');
  return users.length === 1 && isTerminalChatConnectivityPrompt(users[0].content);
}
