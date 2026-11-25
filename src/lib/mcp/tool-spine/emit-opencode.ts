/**
 * Emitter: OpenCode CLI `~/.config/opencode/opencode.json` `mcp` block (Set B).
 *
 * Schema verified against opencode.ai/config.json (the published JSON schema) +
 * the live opencode 1.4.x CLI + opencode.ai/docs/mcp-servers:
 *   - top key is `mcp` (NOT `mcpServers`), keyed by server name;
 *   - local stdio = { type:'local', command:[cmd, ...args], environment?:{…} }
 *     — OpenCode folds command+args into ONE array, and the env field is
 *     `environment` (not `env`);
 *   - remote = { type:'remote', url, headers?:{…} }.
 * Empty `environment` is omitted to match the CLI's own minimal output.
 *
 * Surfaces: operator ("o8").
 */

import { entriesForSurface, type ToolRegistry } from './registry';
import type { ClaudeDesktopConfig } from './emit-claude-desktop';

export function toOpencodeJson(r: ToolRegistry): { mcp: Record<string, unknown> } {
  const mcp: Record<string, unknown> = {};
  for (const { name, config } of entriesForSurface(r, 'opencode')) {
    mcp[name] = config.type === 'http'
      ? { type: 'remote', url: config.url, ...(config.headers ? { headers: config.headers } : {}) }
      : {
          type: 'local',
          command: [config.command, ...config.args],
          ...(config.env && Object.keys(config.env).length ? { environment: config.env } : {}),
        };
  }
  return { mcp };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge-preserving projection (mirrors `toClaudeDesktopJson` / `toGeminiSettingsMerged`):
 * write ONLY o8's managed entries into the user's config under `mcp`, leaving
 * every other server + every other top-level key byte-identical. `ClaudeDesktopConfig`
 * is the shared mergeable-JSON-config shape — its `[key]: unknown` index holds
 * OpenCode's `mcp` key. I/O (read, atomic write, `.o8-backup`, trailing newline)
 * stays in the caller.
 */
export function toOpencodeJsonMerged(r: ToolRegistry, existing: ClaudeDesktopConfig): ClaudeDesktopConfig {
  const next: ClaudeDesktopConfig = { ...existing };
  const mcp: Record<string, unknown> = { ...(isRecord(existing.mcp) ? existing.mcp : {}) };
  for (const [name, entry] of Object.entries(toOpencodeJson(r).mcp)) {
    mcp[name] = entry;
  }
  next.mcp = mcp;
  return next;
}
