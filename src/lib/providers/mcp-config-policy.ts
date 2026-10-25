import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { childEnvironment, configuredMcpEnvironment, configuredRuntimeId, providerCredentialName } from './spawn-environment';
import { containsProviderCredential } from './credential-materials';
import { withProviderStoreLock } from './store-lock';
import { deferredMcpArgumentsForCheck } from './deferred-mcp-arguments';

const failure = () => new Error('MCP config is invalid or its credential policy changed. Rebuild it and retry.');
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const permittedValues = (env: Record<string, string | undefined>) => new Set(Object.entries(env)
  .filter(([name, value]) => providerCredentialName(name) && value).map(([, value]) => value!));
type ConfigTraversal = { depth: number; files: Set<string>; cwd?: string; receipts?: Map<string, string | null> };

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
export function assertMcpServers(servers: unknown, runtimeId?: string, traversal: ConfigTraversal = { depth: 0, files: new Set() }): void {
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
      assertMcpConfigArguments([command, ...args], current, configuredRuntimeId(command), undefined, traversal);
    }
  } catch { throw failure(); }
}

/** Read-only validation also accepts inert entries used during profile setup. */
export function assertMcpConfiguration(config: unknown, runtimeId: string | undefined, traversal: ConfigTraversal = { depth: 0, files: new Set() }): void {
  if (!record(config)) throw failure();
  assertMcpServers(config.mcpServers, runtimeId, traversal);
  assertMcpServers(config.mcp_servers, runtimeId, traversal);
  if (record(config.mcp)) assertMcpServers(config.mcp.servers ?? config.mcp, runtimeId, traversal);
}

/** File writes, process launches and HTTP request creation share the same OS store lock. */
export function withMcpConfigPolicy<T>(config: unknown, runtimeId: string | undefined, write: () => T, cwd?: string): T {
  return withProviderStoreLock(() => {
    assertMcpConfiguration(config, runtimeId, { depth: 0, files: new Set(), cwd });
    return write();
  });
}

function readConfig(file: string, traversal: ConfigTraversal): string {
  if (statSync(file).size > 4 * 1024 * 1024) throw failure();
  const content = readFileSync(file, 'utf8');
  traversal.receipts?.set(file, createHash('sha256').update(content).digest('hex'));
  return content;
}

/** Bind delayed launches to the exact file contents that passed validation,
 * including absence of an implicit config and all nested stdio references.
 */
export function captureMcpConfigReceipts(args: readonly string[], env: Record<string, string | undefined>, cwd: string): Array<[string, string | null]> {
  return withProviderStoreLock(() => {
    const receipts = new Map<string, string | null>();
    assertMcpConfigArguments(args, env, undefined, undefined, { depth: 0, files: new Set(), cwd, receipts });
    return [...receipts];
  });
}

/** A prepared file is a reference, not authority to keep using an old payer.
 * Recheck inside the process-creation store lock, including Codex's implicit file.
 */
export function assertMcpConfigArguments(args: readonly string[], env: Record<string, string | undefined>, runtimeId?: string, prepared?: object,
  traversal: ConfigTraversal = { depth: 0, files: new Set() }): void {
  try {
    if (traversal.depth > 64) throw failure();
    const owner = runtimeId ?? configuredRuntimeId(args[0] ?? '');
    const allowed = permittedValues(env);
    // Only the trusted worker builder may defer a nested CLI's env; arbitrary
    // -c URLs, config overrides and every other argument are scanned in full.
    const checked = owner === 'codex' && prepared ? deferredMcpArgumentsForCheck(prepared, args) : args;
    assertValues(checked, allowed);
    if (owner === 'codex') {
      const home = env.CODEX_HOME || join(env.HOME || env.USERPROFILE || homedir(), '.codex');
      const file = resolve(traversal.cwd ?? process.cwd(), join(home, 'config.toml'));
      if (existsSync(file)) {
        if (traversal.files.has(file)) throw failure();
        const files = new Set(traversal.files).add(file);
        assertMcpServers(parseToml(readConfig(file, traversal)).mcp_servers, owner, { ...traversal, depth: traversal.depth + 1, files });
      } else traversal.receipts?.set(file, null);
    }
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const source = arg === '--mcp-config' ? args[++index]
        : arg.startsWith('--mcp-config=') ? arg.slice('--mcp-config='.length) : undefined;
      if (source === undefined) continue;
      const file = source.startsWith('{') ? source : resolve(traversal.cwd ?? process.cwd(), source);
      if (traversal.files.has(file)) throw failure();
      const config = JSON.parse(source.startsWith('{') ? source : readConfig(file, traversal));
      if (!record(config) || !config.mcpServers) throw failure();
      assertMcpServers(config.mcpServers, owner, { ...traversal, depth: traversal.depth + 1, files: new Set(traversal.files).add(file) });
    }
  } catch { throw failure(); }
}
