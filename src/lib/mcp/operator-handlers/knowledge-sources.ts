import { apiFetch, jsonResult, type McpTool } from './shared';
export const KNOWLEDGE_SOURCE_TOOLS: McpTool[] = [{
  name: 'cortex_knowledge_sources',
  description: 'List, add or remove operator-approved read-only markdown knowledge folders. Sources never become dispatch targets. Credential-shaped chunks are skipped before distillation. Removing a source deletes its derived facts, not its files.',
  inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'add', 'remove'] }, path: { type: 'string' }, name: { type: 'string' }, id: { type: 'string' },
    include: { type: 'array', items: { type: 'string' } }, exclude: { type: 'array', items: { type: 'string' } },
  }, required: ['action'], additionalProperties: false },
}];
export async function handleKnowledgeSources(args: Record<string, unknown>) {
  if (!['list', 'add', 'remove'].includes(String(args.action))) throw new Error('Choose list, add or remove.');
  return jsonResult(await apiFetch('/api/cortex/sources', args.action === 'list' ? {} : { method: 'POST', body: JSON.stringify(args) }));
}
