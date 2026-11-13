import { apiFetch, jsonResult, textResult, type McpTool } from './shared';
export const ADOPT_PR_TOOL: McpTool = {
  name: 'o8_adopt_pr', description: 'Adopt a GitHub PR into one durable review task. Operator token only. Repeating current input returns its task and revision. Use o8_task_dispatch to request review. Cannot deliver findings to an external author or merge.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { repoPath: { type: 'string' }, pullRequest: { type: ['string', 'integer'] }, intendedOutcome: { type: 'string' } }, required: ['repoPath', 'pullRequest'] },
};
export async function handleAdoptPr(args: Record<string, unknown>) {
  if (process.env.O8_WORKER_TOKEN) return textResult('Operator token required. Worker sessions cannot adopt PRs.', true);
  try { return jsonResult(await apiFetch('/api/tasks/adopt-pr', { method: 'POST', body: JSON.stringify(args) })); }
  catch { return textResult('PR adoption refused. An operator token and registered GitHub repository are required.', true); }
}
