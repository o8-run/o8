import { existsSync } from 'node:fs';

export interface McpSetupReadiness {
  ready: boolean;
  reason: string | null;
  detail: string | null;
}

export function getMcpSetupReadiness(): McpSetupReadiness {
  const packaged = process.env.O8_PACKAGED_APP === '1';
  const bundledPath = process.env.O8_BUNDLED_MCP_PATH;
  if (packaged && (!bundledPath || !existsSync(bundledPath))) {
    return {
      ready: false,
      reason: 'bundled_mcp_not_ready',
      detail: 'o8 is still finishing first launch. Wait for startup to finish, then run Connect again.',
    };
  }
  return { ready: true, reason: null, detail: null };
}
