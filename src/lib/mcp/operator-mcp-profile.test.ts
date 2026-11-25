import { afterEach, describe, expect, it } from 'vitest';
import { handleOperatorMcpMessage, operatorToolsForProfile } from './operator-mcp-host';

const originalProfile = process.env.O8_OPERATOR_MCP_PROFILE;

afterEach(() => {
  if (originalProfile === undefined) delete process.env.O8_OPERATOR_MCP_PROFILE;
  else process.env.O8_OPERATOR_MCP_PROFILE = originalProfile;
});

describe('operator MCP process profiles', () => {
  it('blocks a hidden tool even when a client calls it without discovery', async () => {
    process.env.O8_OPERATOR_MCP_PROFILE = 'visualizations';
    const response = await handleOperatorMcpMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'o8_task_create', arguments: { title: 'escape profile' } },
    });

    expect(response).toMatchObject({
      id: 7,
      result: {
        isError: true,
        content: [{ type: 'text' }],
      },
    });
    expect(JSON.stringify(response)).toContain('Tool unavailable in operator MCP profile visualizations');
  });

  it('fails closed for an unknown explicit profile while preserving the normal default', () => {
    const fullNames = operatorToolsForProfile('full').map((tool) => tool.name);
    expect(fullNames).toContain('o8_update_apply');
    expect(fullNames).toContain('o8_problem_list');
    expect(fullNames).toContain('o8_problem_get');
    expect(fullNames).toContain('o8_truth_query');
    expect(fullNames.some((name) => name.startsWith('o8_view_'))).toBe(false);
    expect(operatorToolsForProfile('misspelled-dogfood')).toEqual([]);
  });

  it('publishes strict Broadcast tools only in the full profile', () => {
    const fullTools = operatorToolsForProfile('full');
    const restrictedNames = operatorToolsForProfile('visualizations').map((tool) => tool.name);
    expect(fullTools.find((tool) => tool.name === 'o8_broadcast_token')?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: expect.any(Object),
      required: ['action'],
    });
    expect(restrictedNames).not.toContain('o8_broadcast_token');
    expect(fullTools.find((tool) => tool.name === 'o8_broadcast_post')?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { enum: ['commentary', 'conversation', 'focus'] },
        title: { maxLength: 120 },
        goal: { maxLength: 400 },
      },
      required: ['kind'],
    });
    expect(restrictedNames).not.toContain('o8_broadcast_post');
  });
});
