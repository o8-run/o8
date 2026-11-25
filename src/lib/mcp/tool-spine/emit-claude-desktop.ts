/**
 * Emitter: Claude Desktop / Claude Code `~/.claude.json` (Set B) — merge-preserving.
 *
 * This is the outage fix. `toClaudeDesktopJson` writes ONLY the keys this
 * registry names onto the claude-desktop surface; every unknown server
 * (`filesystem`, `playwright`, …) and every top-level key survives via the
 * spreads. The desktop `o8` entry carries NO `type` field —
 * `toClaudeDesktopEntry` strips it for stdio → `{ command, args, env }`.
 *
 * I/O (readClaudeConfig, atomic write + `.o8-backup-<ts>` + trailing newline)
 * stays in the route; this module is pure.
 */

import type { OrchestratorMcpServerConfig } from '@/lib/mcp/external-servers';
import { entriesForSurface, type ToolRegistry } from './registry';

export interface ClaudeDesktopConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Project one server config into the Claude Desktop wire shape. stdio servers
 * are written WITHOUT the `type` discriminator (`{ command, args, env }`),
 * matching the legacy `buildServerConfig` output.
 */
export function toClaudeDesktopEntry(config: OrchestratorMcpServerConfig): Record<string, unknown> {
  if (config.type === 'http') {
    return { url: config.url, ...(config.headers ? { headers: config.headers } : {}) };
  }
  return { command: config.command, args: config.args, env: config.env ?? {} };
}

export function toClaudeDesktopJson(r: ToolRegistry, existing: ClaudeDesktopConfig): ClaudeDesktopConfig {
  const next: ClaudeDesktopConfig = { ...existing };
  const servers: Record<string, unknown> = { ...(isRecord(existing.mcpServers) ? existing.mcpServers : {}) };
  for (const { name, config } of entriesForSurface(r, 'claude-desktop')) {
    servers[name] = toClaudeDesktopEntry(config);
  }
  next.mcpServers = servers;
  return next;
}
