import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { childEnvironment, configuredMcpEnvironment, configuredRuntimeId, providerCredentialName } from './spawn-environment';
import { containsProviderCredential } from './credential-materials';
import { withProviderStoreLock } from './store-lock';

const failure = () => new Error('MCP config is invalid or its credential policy changed. Rebuild it and retry.');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const permittedValues = (env: Record<string, string | undefined>) => new Set(Object.entries(env)
  .filter(([name, value]) => providerCredentialName(name) && value).map(([, value]) => value!));

/** Inspect every field, including remote headers, encoded URL values and Basic
 * authorization. Historical fingerprints reject removed/rotated saved keys.
 */
function assertValues(value: unknown, allowed: ReadonlySet<string>, depth = 0): void {
  if (depth > 64) throw failure();
  if (typeof value === 'string') {
    const candidates = [value];
    try { candidates.push(decodeURIComponent(value)); } catch { /* Ordinary non-URL text. */ }
    try {
      const url = new URL(value);
      // Decode each component independently: a malformed escape elsewhere in
      // the URL must not hide an encoded provider key in a query parameter.
      for (const part of [url.username, url.password, url.pathname, url.hash, ...Array.from(url.searchParams).flat()]) {
        candidates.push(part);
        try { candidates.push(decodeURIComponent(part)); } catch { /* Check the remaining components. */ }
      }
    } catch { /* Ordinary non-URL text. */ }
    const basic = /^Basic\s+([\s\S]+)$/i.exec(value.trim());
    if (basic) candidates.push(Buffer.from(basic[1], 'base64').toString('utf8'));
    if (candidates.some(candidate => containsProviderCredential(candidate, allowed))) throw failure();
  } else if (Array.isArray(value)) {
    for (const item of value) assertValues(item, allowed, depth + 1);
  } else if (record(value)) {
    for (const [name, item] of Object.entries(value)) {
      assertValues(name, allowed, depth + 1);
      assertValues(item, allowed, depth + 1);
    }
  }
}

/** Stdio belongs to its configured child CLI; HTTP/SSE belongs to the CLI
 * consuming the configuration. Missing runtime authority always denies keys.
 */
export function assertMcpServers(servers: unknown, runtimeId?: string): void {
  if (servers === undefined) return;
  try {
    if (!record(servers)) throw failure();
    for (const [name, value] of Object.entries(servers)) {
      if (!record(value)) throw failure();
      const command = Array.isArray(value.command) ? value.command[0] : value.command;
      const remote = ['http', 'sse', 'remote'].includes(String(value.type)) || !command && (value.url || value.httpUrl);
      if (remote || !command) {
        const allowed = permittedValues(childEnvironment({ runtimeId, inherit: false }));
        assertValues(name, allowed);
        assertValues(value, allowed);
        continue;
      }
      if (typeof command !== 'string') throw failure();
      const env = value.env ?? value.environment ?? {};
      const args = Array.isArray(value.command) ? value.command.slice(1) : value.args ?? [];
      if (!record(env) || Object.values(env).some(item => typeof item !== 'string')
        || !Array.isArray(args) || args.some(item => typeof item !== 'string')) throw failure();
      const current = configuredMcpEnvironment(command, env as Record<string, string>, false, args);
      if (Object.entries(env).some(([name, item]) => item && current[name] !== item)) throw failure();
      const allowed = permittedValues(current);
      assertValues(name, allowed);
      assertValues(value, allowed);
    }
  } catch { throw failure(); }
}

/** Read-only validation also accepts inert entries used during profile setup. */
export function assertMcpConfiguration(config: unknown, runtimeId: string | undefined): void {
  if (!record(config)) throw failure();
  assertMcpServers(config.mcpServers, runtimeId);
  assertMcpServers(config.mcp_servers, runtimeId);
  if (record(config.mcp)) assertMcpServers(config.mcp.servers ?? config.mcp, runtimeId);
}

/** File writes, process launches and HTTP request creation share the same OS store lock. */
export function withMcpConfigPolicy<T>(config: unknown, runtimeId: string | undefined, write: () => T): T {
  return withProviderStoreLock(() => {
    assertMcpConfiguration(config, runtimeId);
    return write();
  });
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
    const owner = runtimeId ?? configuredRuntimeId(args[0] ?? '');
    if (owner === 'codex' && env.CODEX_HOME) {
      const file = join(env.CODEX_HOME, 'config.toml');
      if (existsSync(file)) assertMcpServers(parseToml(readConfig(file)).mcp_servers, owner);
    }
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const source = arg === '--mcp-config' ? args[++index]
        : arg.startsWith('--mcp-config=') ? arg.slice('--mcp-config='.length) : undefined;
      if (source === undefined) continue;
      const config = JSON.parse(source.startsWith('{') ? source : readConfig(source));
      if (!record(config) || !config.mcpServers) throw failure();
      assertMcpServers(config.mcpServers, owner);
    }
  } catch { throw failure(); }
}
