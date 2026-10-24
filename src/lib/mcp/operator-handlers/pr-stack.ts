import { apiFetch, jsonResult, textResult, type McpTool, type McpToolResult } from './shared';
export const PR_STACK_TOOLS: McpTool[] = [{
  name: 'o8_pr_stack',
  description: 'Read a PR native stack, ordered layer revisions, trunk, provenance history and freshness. Read-only; never merge or restack. Native absence and inferred branch relationships are distinct.',
  inputSchema: { type: 'object', properties: { repo: { type: 'string', description: 'GitHub owner/repository.' }, number: { type: 'integer', minimum: 1, description: 'Selected PR number.' } }, required: ['repo', 'number'] },
}];
export async function handlePrStack(args: Record<string, unknown>): Promise<McpToolResult> {
  if (typeof args.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(args.repo) || !Number.isSafeInteger(args.number) || Number(args.number) < 1) return textResult('A repository and positive PR number are required.', true);
  try { return jsonResult(await apiFetch(`/api/panel/pr-stack?${new URLSearchParams({ repo: args.repo, number: String(args.number) })}`)); }
  catch { return textResult('Pull request stack could not be read. Check GitHub access and retry.', true); }
}
