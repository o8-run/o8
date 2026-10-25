import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { configuredMcpEnvironment, configuredRuntimeId } from './spawn-environment';

const failure = () => new Error('MCP config is invalid or its credential policy changed. Rebuild it and retry.');

/** Applies equally to JSON files, Codex TOML and app-server thread overrides. */
export function assertMcpServers(servers: unknown): void {
  if (servers === undefined) return;
  try {
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw failure();
    for (const server of Object.values(servers) as Array<Record<string, unknown>>) {
      if (!server || typeof server !== 'object') throw failure();
      if (server.enabled === false || server.type === 'http' || server.type === 'sse' || (!server.command && server.url)) continue;
      if (typeof server.command !== 'string') throw failure();
      const env = server.env ?? {};
      const args = server.args ?? [];
      if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(value => typeof value !== 'string')
        || !Array.isArray(args) || args.some(value => typeof value !== 'string')) throw failure();
      const current = configuredMcpEnvironment(server.command, env as Record<string, string>, false, args);
      if (Object.entries(env).some(([name, value]) => value && current[name] !== value)) throw failure();
    }
  } catch { throw failure(); }
}

function readConfig(file: string): string {
  if (statSync(file).size > 4 * 1024 * 1024) throw failure();
  return readFileSync(file, 'utf8');
}

/** A prepared file is a reference, not authority to keep using an old payer.
 * Recheck inside the process-creation store lock, including Codex's implicit file.
 */
export function assertMcpConfigArguments(args: readonly string[], env: NodeJS.ProcessEnv, runtimeId?: string): void {
  try {
    if ((runtimeId === 'codex' || configuredRuntimeId(args[0] ?? '') === 'codex') && env.CODEX_HOME) {
      const file = join(env.CODEX_HOME, 'config.toml');
      if (existsSync(file)) assertMcpServers(parseToml(readConfig(file)).mcp_servers);
    }
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const source = arg === '--mcp-config' ? args[++index]
        : arg.startsWith('--mcp-config=') ? arg.slice('--mcp-config='.length) : undefined;
      if (source === undefined) continue;
      const config = JSON.parse(source.startsWith('{') ? source : readConfig(source));
      if (!config || typeof config !== 'object' || !config.mcpServers) throw failure();
      assertMcpServers(config.mcpServers);
    }
  } catch { throw failure(); }
}
