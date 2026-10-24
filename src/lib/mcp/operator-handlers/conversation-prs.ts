import { apiFetch, jsonResult, textResult, type McpTool, type McpToolResult } from './shared';
import { safeErrorText } from '@/lib/mcp/api-error';
export const CONVERSATION_PR_TOOLS: McpTool[] = [{
  name: 'o8_conversation_prs',
  description: 'Read durable conversation and PR links, or add/remove an explicit context, review or import association. Operator only; never starts a worker or modifies GitHub. Delivery associations are automatic and read-only. Reverse lookup includes archived conversations. Resolve immutable identities from the local mirror using repo and number.',
  inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'add', 'remove', 'reverse'] },
    threadId: { type: 'string' }, repo: { type: 'string', description: 'owner/repository' }, number: { type: 'integer', minimum: 1 },
    repositoryId: { type: 'integer', minimum: 1 }, pullRequestId: { type: 'integer', minimum: 1 },
    kind: { type: 'string', enum: ['context', 'review', 'import'] },
    after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 },
  }, required: ['action'], additionalProperties: false },
}];
export async function handleConversationPrs(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    const action = args.action;
    if (!['list', 'add', 'remove', 'reverse'].includes(String(action))) return textResult('Use list, add, remove or reverse.', true);
    const query = new URLSearchParams();
    const endpoint = '/api/orchestrator/pull-request-context';
    if (action === 'list') query.set('threadId', String(args.threadId ?? ''));
    else {
      query.set('number', String(args.number ?? ''));
      if (args.repo !== undefined) query.set('repo', String(args.repo));
      if (args.repositoryId !== undefined || args.pullRequestId !== undefined) {
        query.set('host', 'github.com'); query.set('repositoryId', String(args.repositoryId ?? '')); query.set('pullRequestId', String(args.pullRequestId ?? ''));
      }
    }
    if (action === 'add' || action === 'remove') {
      if (args.repo !== undefined && (args.repositoryId !== undefined || args.pullRequestId !== undefined)) return textResult('Use either repo or immutable IDs, not both.', true);
      let identity: Record<string, unknown>;
      if (args.repo !== undefined) {
        query.set('resolve', '1'); if (action === 'add') query.set('refresh', '1');
        const resolved = await apiFetch(`${endpoint}?${query}`) as { result: { identity: Record<string, unknown> } };
        identity = resolved.result.identity;
      } else identity = { host: 'github.com', repositoryId: args.repositoryId, pullRequestId: args.pullRequestId, number: args.number };
      return jsonResult(await apiFetch(endpoint, { method: action === 'add' ? 'POST' : 'DELETE',
        body: JSON.stringify({ ...identity, threadId: args.threadId, kind: args.kind ?? 'context' }) }));
    }
    for (const key of ['after', 'limit']) if (args[key] !== undefined) query.set(key, String(args[key]));
    return jsonResult(await apiFetch(`${endpoint}?${query}`));
  } catch (error) { return textResult(safeErrorText(error), true); }
}
