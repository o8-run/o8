import {
  apiFetch,
  errorText,
  jsonResult,
  textResult,
  type McpTool,
  type McpToolResult,
} from './shared';

export const BROADCAST_TOOLS: McpTool[] = [
  {
    name: 'o8_broadcast_post',
    description: 'Set or clear the live Broadcast focus, or post commentary and conversation lines.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['commentary', 'conversation', 'focus'] },
        actor: { type: 'string', minLength: 1, maxLength: 160 },
        audience: { type: 'string', maxLength: 160 },
        text: { type: 'string', minLength: 1, maxLength: 2000 },
        title: { type: 'string', minLength: 1, maxLength: 120 },
        goal: { type: 'string', maxLength: 400 },
        issue: { type: 'integer', minimum: 1 },
        clear: { type: 'boolean' },
        laneId: { type: 'string', maxLength: 160 },
        packetId: { type: 'string', maxLength: 160 },
      },
      required: ['kind'],
    },
  },
  {
    name: 'o8_broadcast_token',
    description: 'Mint or revoke a read-only bearer for the live Broadcast spectator surface. A minted bearer is returned once and only its hash is stored.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['mint', 'revoke'] },
        id: { type: 'string', minLength: 1, description: 'Required when action is revoke.' },
        label: { type: 'string', maxLength: 120, description: 'Optional operator label when action is mint.' },
      },
      required: ['action'],
    },
  },
];

export async function handleBroadcastPost(args: Record<string, unknown>): Promise<McpToolResult> {
  if (args.kind !== 'commentary' && args.kind !== 'conversation' && args.kind !== 'focus') {
    return textResult('kind must be commentary, conversation, or focus.', true);
  }
  if (args.kind === 'focus') {
    if (args.clear !== undefined && typeof args.clear !== 'boolean') {
      return textResult('clear must be a boolean.', true);
    }
    if (args.clear !== true && (typeof args.title !== 'string' || !args.title.trim())) {
      return textResult('title is required when focus is not cleared.', true);
    }
    if (args.goal !== undefined && typeof args.goal !== 'string') {
      return textResult('goal must be a string.', true);
    }
    if (args.issue !== undefined && (!Number.isSafeInteger(args.issue) || Number(args.issue) < 1)) {
      return textResult('issue must be a positive integer.', true);
    }
    try {
      const result = await apiFetch('/api/broadcast/post', {
        method: 'POST',
        body: JSON.stringify(args.clear === true
          ? { kind: 'focus', clear: true }
          : {
              kind: 'focus',
              title: (args.title as string).trim(),
              goal: typeof args.goal === 'string' ? args.goal.trim() : undefined,
              issue: args.issue,
            }),
      });
      return jsonResult(result);
    } catch (error) {
      return textResult(`o8_broadcast_post failed: ${errorText(error)}`, true);
    }
  }
  if (typeof args.actor !== 'string' || !args.actor.trim()) {
    return textResult('actor is required.', true);
  }
  if (typeof args.text !== 'string' || !args.text.trim()) {
    return textResult('text is required.', true);
  }
  for (const name of ['audience', 'laneId', 'packetId'] as const) {
    if (args[name] !== undefined && typeof args[name] !== 'string') {
      return textResult(`${name} must be a string.`, true);
    }
  }
  try {
    const result = await apiFetch('/api/broadcast/post', {
      method: 'POST',
      body: JSON.stringify({
        kind: args.kind,
        actor: args.actor.trim(),
        audience: typeof args.audience === 'string' ? args.audience.trim() : undefined,
        text: args.text.trim(),
        refs: {
          laneId: typeof args.laneId === 'string' ? args.laneId.trim() : undefined,
          packetId: typeof args.packetId === 'string' ? args.packetId.trim() : undefined,
        },
      }),
    });
    return jsonResult(result);
  } catch (error) {
    return textResult(`o8_broadcast_post failed: ${errorText(error)}`, true);
  }
}

export async function handleBroadcastToken(args: Record<string, unknown>): Promise<McpToolResult> {
  const action = args.action;
  if (action !== 'mint' && action !== 'revoke') {
    return textResult('action must be mint or revoke.', true);
  }
  if (action === 'mint' && args.label !== undefined && typeof args.label !== 'string') {
    return textResult('label must be a string.', true);
  }
  if (action === 'revoke' && (typeof args.id !== 'string' || !args.id.trim())) {
    return textResult('id is required when action is revoke.', true);
  }
  try {
    const result = await apiFetch('/api/broadcast/tokens', {
      method: 'POST',
      body: JSON.stringify(action === 'mint'
        ? { action, label: typeof args.label === 'string' ? args.label : undefined }
        : { action, id: (args.id as string).trim() }),
      acceptedErrorStatuses: [404],
    }) as { ok?: boolean };
    return result.ok ? jsonResult(result) : textResult(JSON.stringify(result), true);
  } catch (error) {
    return textResult(`o8_broadcast_token failed: ${errorText(error)}`, true);
  }
}
