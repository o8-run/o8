import { apiFetch, jsonResult, textResult, type McpTool } from './shared';

export const INBOX_DECISIONS_TOOL: McpTool = {
  name: 'get_inbox_decisions',
  description: 'Read one decision per blocked review or integration task and current revision, with policy and evidence links. Operator only; never executes actions.',
  inputSchema: { type: 'object', properties: {
    state: { type: 'string', enum: ['unresolved', 'history', 'all'] }, projectId: { type: 'string' },
    cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
  } },
};
export async function handleGetInboxDecisions(args: Record<string, unknown>) {
  const query = new URLSearchParams();
  for (const key of ['state', 'projectId', 'cursor', 'limit']) {
    if (args[key] !== undefined) query.set(key, String(args[key]));
  }
  try { return jsonResult(await apiFetch(`/api/panel/inbox/decisions?${query}`)); }
  catch { return textResult('Inbox decisions could not be read. Retry before choosing an action.', true); }
}
