import { apiFetch, jsonResult, requiredString, textResult, type McpTool } from './shared';

export const INTEGRATION_QUEUE_TOOLS: McpTool[] = [{
  name: 'o8_integration_queue',
  description: 'Read a repository integration queue, or explicitly prepare and check a combined candidate from reviewed tasks. Operator only. Never publishes, merges, starts corrections or changes defaults. A passed check is evidence, not publication authority.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {
    repoId: { type: 'string' }, action: { type: 'string', enum: ['read', 'prepare'] },
    targetRef: { type: 'string' }, changes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string' }, dependsOn: { type: 'array', items: { type: 'string' } },
    }, required: ['id'] } },
    checks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string' }, command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, timeoutMs: { type: 'integer' },
    }, required: ['name', 'command', 'args', 'timeoutMs'] } },
  }, required: ['repoId', 'action'] },
}];
export async function handleIntegrationQueue(args: Record<string, unknown>) {
  if (process.env.O8_WORKER_TOKEN) return textResult('Operator token required. Workers cannot prepare integration candidates.', true);
  try {
    const repoId = requiredString(args, 'repoId');
    if (args.action !== 'read' && args.action !== 'prepare') return textResult('Choose read or prepare.', true);
    return jsonResult(await apiFetch(`/api/repos/${encodeURIComponent(repoId)}/integration-queue`, args.action === 'prepare' ? {
      method: 'POST', retry: false, timeoutMs: 2700000,
      body: JSON.stringify({ targetRef: args.targetRef, changes: args.changes, checks: args.checks }),
    } : undefined));
  } catch { return textResult('Integration queue unavailable. Inspect the saved queue with an operator credential before retrying.', true); }
}
