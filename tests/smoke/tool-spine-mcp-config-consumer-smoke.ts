/**
 * Tool-Spine Step-E1 regression lock (live): the mcp-config GET response server
 * objects.
 *
 * mcp-config/route.ts GET returned { server, fullConfig } from
 * its own buildServerConfig copy; it now derives them from the Tool-Spine
 * claude-desktop projection (Set B). No file write — the parity unit is the
 * returned object. PACKAGED mode (set inline) so resolution is deterministic
 * (dev tsx-vs-npx is spec risk #3).
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/tool-spine-mcp-config-consumer-smoke.ts
 */

import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './require-temp-data-dir';
import { insertExternalMcpServer } from '@/lib/mcp/external-servers';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toClaudeDesktopJson } from '@/lib/mcp/tool-spine/emit-claude-desktop';

function main(): void {
  // Force PACKAGED resolution.
  const bundleDir = mkdtempSync(join(tmpdir(), 'mc-bundle-'));
  const bundlePath = join(bundleDir, 'operator-mcp-server.mjs');
  const proxyPath = join(bundleDir, 'operator-mcp-proxy.mjs');
  writeFileSync(bundlePath, '');
  writeFileSync(proxyPath, '');
  process.env.O8_BUNDLED_MCP_PATH = bundlePath;
  process.env.O8_BUNDLED_MCP_DIR = bundleDir;
  process.env.O8_NODE_BIN = '/usr/local/bin/node';
  const cmBin = join(mkdtempSync(join(tmpdir(), 'mc-cm-')), 'codebase-memory-mcp');
  writeFileSync(cmBin, '');
  process.env.O8_CODEBASE_MEMORY_BIN = cmBin;

  // Externals in the DB MUST NOT leak into this Set-B surface.
  insertExternalMcpServer({ name: 'zeta-stdio', transport: 'stdio', command: 'zeta', args: ['--x'], env: { K: 'v' }, enabled: true });
  insertExternalMcpServer({ name: 'alpha-http', transport: 'http', command: 'https://a/mcp', url: 'https://a/mcp', oauthToken: 'tok', enabled: true });

  // The exact GET-handler expression (mcp-config/route.ts).
  const mcpServers = toClaudeDesktopJson(buildToolRegistry(process.cwd()), {}).mcpServers as Record<string, Record<string, unknown>>;
  const server = mcpServers['o8'];
  const fullConfig = { mcpServers };

  // Set-B shape: o8 only, NO externals leak, NO type field, even with a
  // codebase-memory binary on disk.
  assert.deepStrictEqual(Object.keys(mcpServers), ['o8'], 'only o8 (externals filtered out)');
  assert(!('type' in server), 'server (o8) has no type field');
  assert.deepStrictEqual(server, { command: '/usr/local/bin/node', args: [proxyPath], env: { O8_API_BASE: 'http://127.0.0.1:3001' } }, 'o8 stdio shape');

  // fullConfig wraps the same map.
  assert.deepStrictEqual(fullConfig, { mcpServers }, 'fullConfig = { mcpServers }');
  assert.strictEqual(JSON.stringify(fullConfig.mcpServers.o8), JSON.stringify(server), 'fullConfig.o8 === server');

  console.log('[tool-spine-mcp-config-consumer-smoke] PASS');
}

main();
