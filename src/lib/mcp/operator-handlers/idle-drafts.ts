import { apiFetch, jsonResult, textResult, type McpTool, type McpToolResult } from './shared';
import { O8ApiError, safeErrorText } from '@/lib/mcp/api-error';
export const IDLE_DRAFT_TOOLS: McpTool[] = [{
  name: 'o8_idle_drafts',
  description: 'List open drafts idle at least three days with age, checks and conflicts with main, or explicitly record continue, handoff or close. Handoff requires a GitHub owner; close requires a reason. No workers are started. Page through nextPage. Inspect GitHub before retrying an uncertain write.',
  inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'continue', 'handoff', 'close'] }, repo: { type: 'string' },
    number: { type: 'integer', minimum: 1 }, page: { type: 'integer', minimum: 1 }, owner: { type: 'string' }, reason: { type: 'string' },
  }, required: ['action'], additionalProperties: false },
}];
export async function handleIdleDrafts(args: Record<string, unknown>): Promise<McpToolResult> {
  try {
    if (args.action === 'list') {
      const query = new URLSearchParams({ view: 'idle-drafts', page: String(args.page ?? 1) });
      if (typeof args.repo === 'string') query.set('repo', args.repo);
      return jsonResult(await apiFetch(`/api/panel/prs?${query}`));
    }
    if (!['continue', 'handoff', 'close'].includes(String(args.action)) || !Number.isSafeInteger(args.number) || Number(args.number) < 1) return textResult('Choose continue, handoff or close and a positive PR number.', true);
    if (typeof args.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(args.repo)) return textResult('A GitHub owner/repository is required.', true);
    return jsonResult(await apiFetch(`/api/panel/prs/${args.number}`, { method: 'POST', retry: false,
      body: JSON.stringify({ action: 'draft-decision', decision: args.action, repo: args.repo, owner: args.owner, reason: args.reason }),
    }));
  } catch (error) { return textResult(args.action !== 'list' && error instanceof O8ApiError && (error.status === null || error.status >= 500) ? 'Draft decision could not be confirmed. Inspect GitHub before retrying.' : safeErrorText(error), true); }
}
