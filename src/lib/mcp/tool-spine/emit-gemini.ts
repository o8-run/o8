/**
 * Emitter: Gemini CLI `~/.gemini/settings.json` mcpServers (NEW — closes the gap).
 *
 * The Gemini runtime had no MCP injection. This ships it. Schema verified
 * against the installed Gemini CLI + `google-gemini/gemini-cli`
 * Gemini CLI's MCP server documentation: top key `mcpServers`; stdio is implied by
 * `command` (NO `type` field) with optional `args`/`env`; the streamable-HTTP
 * URL field is `httpUrl` (NOT `url` — `url` is the SSE field), with `headers`.
 * o8's operator server is streamable-HTTP-or-stdio, so it maps to `httpUrl`/
 * `command` accordingly. Empty `env` is omitted to match the CLI's own format.
 *
 * Surfaces: operator ("o8").
 */

import { entriesForSurface, type ToolRegistry } from './registry';

export function toGeminiSettings(r: ToolRegistry): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {};
  for (const { name, config } of entriesForSurface(r, 'gemini')) {
    mcpServers[name] = config.type === 'http'
      ? { httpUrl: config.url, ...(config.headers ? { headers: config.headers } : {}) }
      : {
          command: config.command,
          args: config.args,
          ...(config.env && Object.keys(config.env).length ? { env: config.env } : {}),
        };
  }
  return { mcpServers };
}

/** A Gemini CLI settings.json — mcpServers + arbitrary other top-level keys. */
export interface GeminiSettings {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge-preserving projection (mirrors `toClaudeDesktopJson`): write ONLY o8's
 * managed entries into the user's settings, leaving every other server + every
 * other top-level key (security / general / ui / tools …) byte-identical. I/O
 * (read, atomic write, `.o8-backup`, trailing newline) stays in the caller.
 */
export function toGeminiSettingsMerged(r: ToolRegistry, existing: GeminiSettings): GeminiSettings {
  const next: GeminiSettings = { ...existing };
  const servers: Record<string, unknown> = { ...(isRecord(existing.mcpServers) ? existing.mcpServers : {}) };
  for (const [name, entry] of Object.entries(toGeminiSettings(r).mcpServers)) {
    servers[name] = entry;
  }
  next.mcpServers = servers;
  return next;
}
