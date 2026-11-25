/**
 * Emitter: OpenClaw governed-profile `mcp` block (Set B).
 *
 * Returns `{ servers: { o8: <stdio-stripped config> } }` — the caller assigns it
 * to the profile's `mcp` key (`o8Config.mcp = toOpenclawJson(r)`). This REPLACES
 * the current "read whatever the user pre-registered + throw if missing"
 * passthrough with a registry-derived entry. The openclaw surface carries only
 * the operator (renamed "o8"); cortex and DB externals are not
 * part of the governed profile.
 *
 * Phase 1 emits the current stdio shape (byte-identical to what
 * `openclaw mcp set o8` wrote). The stdio→http convergence is a flagged
 * fast-follow — one field swap, registry unchanged.
 */

import { entriesForSurface, type ToolRegistry } from './registry';
import { toClaudeDesktopEntry } from './emit-claude-desktop';

export function toOpenclawJson(r: ToolRegistry): { servers: Record<string, unknown> } {
  const servers: Record<string, unknown> = {};
  for (const { name, config } of entriesForSurface(r, 'openclaw')) {
    servers[name] = toClaudeDesktopEntry(config);
  }
  return { servers };
}
