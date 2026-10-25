import { withMcpConfigPolicy } from '@/lib/providers/mcp-config-policy';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import { repoHash } from './orchestrator-session-core';
import type { ToolProfile } from '@/lib/mcp/tool-spine/registry';
import type { toClaudeJson } from '@/lib/mcp/tool-spine/emit-claude';
const MCP_CONFIG_DIR = join(getDataDir(), 'mcp');
/** Generate a temporary MCP config file for orchestrator context sources.
 *
 * `profile` selects the tool surface: `'full'` (default) is unchanged — same
 * path, byte-identical content. `'propose'` (Collide proposer) strips the
 * operator server and writes to a SEPARATE `-propose` file so a concurrent
 * full-profile turn for the same repo can never clobber it back to a config
 * that carries dispatch (the #1075 lockout would otherwise race). `'fable'`
 * likewise gets its own `-fable` file (keeps operator + cortex, strips externals)
 * so a concurrent full turn for the same repo can't clobber its surface either. */
type ClaudeMcpConfig = ReturnType<typeof toClaudeJson>;

export function ensureMcpConfig(repoPath: string, profile: ToolProfile, config: ClaudeMcpConfig, threadId?: string | null): string {
  if (!existsSync(MCP_CONFIG_DIR)) mkdirSync(MCP_CONFIG_DIR, { recursive: true });

  const suffix = `${profile === 'full' ? '' : `-${profile}`}${threadId ? `-${repoHash(threadId)}` : ''}`;
  const configPath = join(MCP_CONFIG_DIR, `orchestrator-${repoHash(repoPath)}${suffix}.json`);
  // The caller fingerprints this exact object. Keeping construction out of the
  // writer prevents transient resolver state from making the stored hash differ
  // from the config the CLI actually reads.
  withMcpConfigPolicy(config, 'claude-code', () => writeFileSync(configPath, JSON.stringify(config, null, 2)));
  console.log(`[orchestrator-session] MCP config written to ${configPath}`);
  return configPath;
}
