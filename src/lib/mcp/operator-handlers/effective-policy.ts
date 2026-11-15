import { apiFetch, jsonResult, requiredString, textResult, type McpTool } from './shared';

export const EFFECTIVE_POLICY_TOOL: McpTool = {
  name: 'get_effective_policy',
  description: 'Read composed review and merge policy for a lane or packet at its current HEAD. Operator only; this read grants no execution authority.',
  inputSchema: { type: 'object', properties: { laneId: { type: 'string', description: 'Lane or packet ID.' } }, required: ['laneId'] },
};

export async function handleGetEffectivePolicy(args: Record<string, unknown>) {
  try {
    const id = requiredString(args, 'laneId');
    return jsonResult(await apiFetch(`/api/lanes/${encodeURIComponent(id)}/policy`));
  } catch {
    return textResult('Effective policy could not be read. An operator must inspect the policy and work revision.', true);
  }
}
