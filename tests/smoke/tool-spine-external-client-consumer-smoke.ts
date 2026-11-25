/**
 * Tool-Spine Step-E2 regression lock (live): the external-client forwarded
 * server object + BOTH serialized wire shapes.
 *
 * external-client/route.ts forwards o8's operator entry to the Hermes / OpenClaw
 * MCP CLIs — hermes as an argv (`mcp add o8 --command … --args … --env K=V`),
 * openclaw as a JSON blob (`mcp set o8 '<json>'`). The builder now comes from the
 * Tool-Spine claude-desktop projection (the THIRD/last buildServerConfig copy
 * gone). This tests the OBJECT + both shapes; it does NOT spawn the CLIs.
 *
 * SURFACE-SPECIFIC behavior (verified, not inferred from E1): external-client
 * forwards ONLY o8 — never externals — EVEN WHEN a codebase-memory binary is
 * present on disk. PACKAGED mode (spec risk #3).
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/tool-spine-external-client-consumer-smoke.ts
 */

import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './require-temp-data-dir';
import { insertExternalMcpServer } from '@/lib/mcp/external-servers';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toClaudeDesktopJson } from '@/lib/mcp/tool-spine/emit-claude-desktop';
import { hermesAddArgs, openclawSetPayload, type ForwardedServer } from '@/lib/mcp/external-client-args';

function main(): void {
  // Force PACKAGED resolution, AND put a codebase-memory binary on disk — to
  // prove external-client still forwards o8 ONLY.
  const bundleDir = mkdtempSync(join(tmpdir(), 'ec-bundle-'));
  const bundlePath = join(bundleDir, 'operator-mcp-server.mjs');
  const proxyPath = join(bundleDir, 'operator-mcp-proxy.mjs');
  writeFileSync(bundlePath, '');
  writeFileSync(proxyPath, '');
  process.env.O8_BUNDLED_MCP_PATH = bundlePath;
  process.env.O8_BUNDLED_MCP_DIR = bundleDir;
  process.env.O8_NODE_BIN = '/usr/local/bin/node';
  const cmBin = join(mkdtempSync(join(tmpdir(), 'ec-cm-')), 'codebase-memory-mcp');
  writeFileSync(cmBin, '');
  process.env.O8_CODEBASE_MEMORY_BIN = cmBin;

  // Externals in the DB must not leak into the forwarded shapes.
  insertExternalMcpServer({ name: 'zeta-stdio', transport: 'stdio', command: 'zeta', args: ['--x'], env: { K: 'v' }, enabled: true });

  // The exact buildServerConfig() expression (external-client/route.ts).
  const projected = toClaudeDesktopJson(buildToolRegistry(process.cwd()), {}).mcpServers as Record<string, unknown>;
  const o8 = projected['o8'] as { command: string; args: string[]; env?: Record<string, string> };
  const server: ForwardedServer = { command: o8.command, args: o8.args, env: o8.env ?? {} };

  // Forwarded object = the operator entry, no type.
  assert.deepStrictEqual(server, { command: '/usr/local/bin/node', args: [proxyPath], env: { O8_API_BASE: 'http://127.0.0.1:3001' } }, 'forwarded object = operator stdio entry');

  // Shape 1 — hermes argv.
  const hermes = hermesAddArgs(server);
  assert.deepStrictEqual(
    hermes,
    ['mcp', 'add', 'o8', '--command', '/usr/local/bin/node', '--args', proxyPath, '--env', 'O8_API_BASE=http://127.0.0.1:3001'],
    'hermes argv shape',
  );

  // Shape 2 — openclaw JSON blob.
  const openclaw = openclawSetPayload(server);
  assert.strictEqual(
    openclaw,
    JSON.stringify({ command: '/usr/local/bin/node', args: [proxyPath], env: { O8_API_BASE: 'http://127.0.0.1:3001' } }),
    'openclaw JSON shape',
  );

  // o8-ONLY: codebase-memory is AVAILABLE in the projection but must NOT appear
  // in either forwarded shape; externals must not appear either.
  assert(!projected['codebase-memory'], 'the projection never carries codebase-memory');
  for (const shape of [hermes.join(' '), openclaw]) {
    assert(!shape.includes('codebase-memory'), 'forwarded shape must not contain codebase-memory');
    assert(!shape.includes('zeta'), 'forwarded shape must not contain externals');
  }

  console.log('[tool-spine-external-client-consumer-smoke] PASS (hermes ' + hermes.length + ' args, openclaw ' + openclaw.length + 'B)');
}

main();
