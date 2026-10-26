/**
 * Tool-Spine Step-A regression lock (live, DB-touching).
 *
 * Proves the registry shim reproduces the legacy `getMcpServersConfig` output
 * byte-for-byte under controlled env, and that every emitter runs over the live
 * `buildToolRegistry` without throwing. Run:
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/tool-spine-parity-smoke.ts
 *
 * The temp data dir gives a fresh DB (no externals), a fixed ws-token/ws-port,
 * and a non-git repo (slug = ''), making the output deterministic.
 */

import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { smokeDataDir } from './require-temp-data-dir';
import { getMcpServersConfig } from '@/lib/lane/orchestrator-mcp-config';
import { externalServerToMcpConfig, insertExternalMcpServer, listEnabledExternalMcpServers } from '@/lib/mcp/external-servers';
import { buildToolRegistry, devMcpServerLaunch, resolveToolSpineApiBase, resolveToolSpineWsPort } from '@/lib/mcp/tool-spine/build';
import { toClaudeServersMap, toClaudeJson } from '@/lib/mcp/tool-spine/emit-claude';
import { toCodexToml } from '@/lib/mcp/tool-spine/emit-codex';
import { toClaudeDesktopJson } from '@/lib/mcp/tool-spine/emit-claude-desktop';
import { toOpenclawJson } from '@/lib/mcp/tool-spine/emit-openclaw';
import { toGeminiSettings } from '@/lib/mcp/tool-spine/emit-gemini';

function main(): void {
  // Pin the env-derived values so the golden is deterministic.
  writeFileSync(join(smokeDataDir, 'ws-token'), 'test-ws-token-fixed\n');
  writeFileSync(join(smokeDataDir, 'ws-port'), '3002\n');
  process.env.O8_MCP_TOOL_LOADING = 'full';

  const repo = mkdtempSync(join(tmpdir(), 'tool-spine-repo-')); // non-git → slug ''
  const repoRoot = process.cwd();
  const operatorPath = join(repoRoot, 'src/lib/mcp/operator-mcp-proxy.ts');
  const cortexPath = join(repoRoot, 'src/lib/mcp/cortex-mcp-server.ts');
  const apiBase = resolveToolSpineApiBase();
  const ownedEnv = process.env.CORTEX_IDE_OWNED_CODEX_ROOT
    ? { CORTEX_IDE_OWNED_CODEX_ROOT: process.env.CORTEX_IDE_OWNED_CODEX_ROOT } : {};

  // ── 1. Byte-for-byte parity: the shim reproduces the legacy output ──
  const expected = {
    operator: {
      type: 'stdio',
      ...devMcpServerLaunch(operatorPath),
      env: { O8_API_BASE: apiBase, O8_MCP_TOOL_LOADING: 'full', O8_DATA_DIR: smokeDataDir,
        O8_VISUALIZATION_REPO_PATH: repo, ...ownedEnv },
    },
    cortex: {
      type: 'stdio',
      ...devMcpServerLaunch(cortexPath),
      env: {
        CORTEX_API_BASE: apiBase,
        O8_MCP_TOOL_LOADING: 'full', O8_DATA_DIR: smokeDataDir, ...ownedEnv,
        CORTEX_REPO_PATH: repo,
        CORTEX_REPO_SLUG: '',
        WS_PORT: resolveToolSpineWsPort(),
        WS_TOKEN: 'test-ws-token-fixed',
      },
    },
  };

  const actual = getMcpServersConfig(repo);
  assert.deepStrictEqual(actual, expected, 'shim output must match the legacy golden byte-for-byte');
  assert.deepStrictEqual(Object.keys(actual), ['operator', 'cortex'], 'key order is [operator, cortex]');

  // The registry projection IS the shim — prove they agree explicitly.
  const registry = buildToolRegistry(repo);
  assert.deepStrictEqual(toClaudeServersMap(registry), expected, 'toClaudeServersMap == legacy map');
  assert.deepStrictEqual(toClaudeJson(registry), { mcpServers: expected }, 'toClaudeJson wraps in mcpServers');

  // ── 2. Every other emitter runs over the LIVE registry without throwing ──
  const codexToml = toCodexToml(registry);
  assert(codexToml.includes('[mcp_servers.operator]'), 'codex TOML has operator block');
  assert(codexToml.includes('[mcp_servers.cortex]'), 'codex TOML has cortex block');
  assert(!codexToml.endsWith('\n'), 'codex serializer adds no trailing newline (caller does)');

  const desktop = toClaudeDesktopJson(registry, { mcpServers: { filesystem: { command: 'fs' } } });
  assert.deepStrictEqual((desktop.mcpServers as Record<string, unknown>).filesystem, { command: 'fs' }, 'unknown server preserved');
  const o8Entry = (desktop.mcpServers as Record<string, unknown>).o8 as Record<string, unknown>;
  assert(o8Entry && !('type' in o8Entry), 'desktop o8 entry has no type field');
  assert(o8Entry.command === expected.operator.command, 'desktop o8 entry is the operator stdio config');

  const openclaw = toOpenclawJson(registry);
  assert.deepStrictEqual(Object.keys(openclaw.servers), ['o8'], 'openclaw emits only o8');
  assert(!('type' in (openclaw.servers.o8 as Record<string, unknown>)), 'openclaw o8 entry has no type');

  const gemini = toGeminiSettings(registry);
  const gemO8 = (gemini.mcpServers as Record<string, unknown>).o8 as Record<string, unknown>;
  assert(gemO8 && gemO8.command === expected.operator.command && !('type' in gemO8), 'gemini o8 entry is stdio with no type');

  // ── 3. Externals-present parity (the path that drifts: ordering + passthrough) ──
  // Production always carries externals; this is the only case that exercises
  // "externals slot first" and external-config passthrough. Insert ≥1 stdio + ≥1
  // http external, then assert the shim places them first in DB (createdAt =
  // insertion) order and passes each through byte-identically.
  insertExternalMcpServer({ name: 'zeta-stdio', transport: 'stdio', command: 'zeta', args: ['--x'], env: { K: 'v' }, enabled: true });
  insertExternalMcpServer({ name: 'alpha-http', transport: 'http', command: 'https://a/mcp', url: 'https://a/mcp', oauthToken: 'tok123', enabled: true });

  const withExternals = getMcpServersConfig(repo);
  assert.deepStrictEqual(
    Object.keys(withExternals),
    ['zeta-stdio', 'alpha-http', 'operator', 'cortex'],
    'externals slot first (insertion order), then operator, cortex',
  );
  // Byte-identical passthrough: each external entry equals externalServerToMcpConfig(record).
  const records = listEnabledExternalMcpServers();
  for (const record of records) {
    assert.deepStrictEqual(
      withExternals[record.name],
      externalServerToMcpConfig(record, repo),
      `external "${record.name}" config passes through unchanged`,
    );
  }
  // Stdio uses a broker reference; HTTP folds oauth into a Bearer header.
  assert.deepStrictEqual(withExternals['zeta-stdio'], externalServerToMcpConfig(records.find(record => record.name === 'zeta-stdio')!, repo), 'stdio external uses a stable broker reference');
  assert.deepStrictEqual(withExternals['alpha-http'], { type: 'http', url: 'https://a/mcp', headers: { Authorization: 'Bearer tok123' } }, 'http external passthrough');
  // operator/cortex builtins still trail the externals, unchanged.
  assert.deepStrictEqual(withExternals.operator, expected.operator, 'operator unchanged with externals present');
  assert.deepStrictEqual(withExternals.cortex, expected.cortex, 'cortex unchanged with externals present');

  console.log('[tool-spine-parity-smoke] PASS');
  console.log(JSON.stringify(withExternals, null, 2));
}

main();
