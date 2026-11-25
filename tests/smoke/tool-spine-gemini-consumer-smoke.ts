/**
 * Tool-Spine Phase-2 Gemini wiring test (live): the consumer that configures the
 * Gemini CLI (~/.gemini/settings.json) from the registry.
 *
 * NEW behavior (Gemini had no config surface) — proven by positive + preservation
 * (gemini-cli format + merge), not a before/after baseline. PACKAGED mode so the
 * o8 entry is the stable {command:<node>, args:[<bundled .mjs>]} shape.
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/tool-spine-gemini-consumer-smoke.ts
 */

import assert from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import './require-temp-data-dir';
import { atomicWriteConfig } from '@/lib/mcp/claude-desktop-config-io';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { entriesForSurface, type ToolRegistry } from '@/lib/mcp/tool-spine/registry';
import { toGeminiSettings, toGeminiSettingsMerged } from '@/lib/mcp/tool-spine/emit-gemini';

// A realistic ~/.gemini/settings.json: o8-unrelated top-level keys + the user's
// own MCP server.
const EXISTING = {
  security: { auth: { selectedType: 'gemini-api-key' } },
  general: { vimMode: false },
  ui: { showLineNumbers: false },
  mcpServers: {
    'chrome-devtools': { command: 'npx', args: ['chrome-devtools-mcp@latest'] },
  },
};

function main(): void {
  // Force PACKAGED resolution + put a codebase-memory binary on disk.
  const bundleDir = mkdtempSync(join(tmpdir(), 'gm-bundle-'));
  const bundlePath = join(bundleDir, 'operator-mcp-server.mjs');
  const proxyPath = join(bundleDir, 'operator-mcp-proxy.mjs');
  writeFileSync(bundlePath, '');
  writeFileSync(proxyPath, '');
  process.env.O8_BUNDLED_MCP_PATH = bundlePath;
  process.env.O8_BUNDLED_MCP_DIR = bundleDir;
  process.env.O8_NODE_BIN = '/usr/local/bin/node';
  const cmBin = join(mkdtempSync(join(tmpdir(), 'gm-cm-')), 'codebase-memory-mcp');
  writeFileSync(cmBin, '');
  process.env.O8_CODEBASE_MEMORY_BIN = cmBin;

  const registry = buildToolRegistry(process.cwd());

  // Surface membership — operator (o8) only, NOT widened.
  assert.deepStrictEqual(entriesForSurface(registry, 'gemini').map((e) => e.name), ['o8'], 'gemini surface = o8 only');

  const merged = toGeminiSettingsMerged(registry, EXISTING);
  const servers = merged.mcpServers as Record<string, Record<string, unknown>>;
  const projection = toGeminiSettings(registry).mcpServers as Record<string, unknown>;

  // ── Positive: managed entries match the emitter projection exactly ──
  for (const name of Object.keys(projection)) {
    assert.deepStrictEqual(servers[name], projection[name], `${name} matches toGeminiSettings projection`);
  }
  // stdio shape: no `type`; env intact on o8.
  assert.deepStrictEqual(servers.o8, { command: '/usr/local/bin/node', args: [proxyPath], env: { O8_API_BASE: 'http://127.0.0.1:3001' } }, 'o8 stdio shape (env intact)');
  assert(!('type' in servers.o8), 'o8 has no type field');
  assert(!('codebase-memory' in servers), 'codebase-memory is never written');

  // ── Preservation: other servers + top-level keys byte-identical ──
  assert.deepStrictEqual(servers['chrome-devtools'], { command: 'npx', args: ['chrome-devtools-mcp@latest'] }, 'user server preserved');
  assert.deepStrictEqual(merged.security, { auth: { selectedType: 'gemini-api-key' } }, 'security preserved');
  assert.deepStrictEqual(merged.general, { vimMode: false }, 'general preserved');
  assert.deepStrictEqual(merged.ui, { showLineNumbers: false }, 'ui preserved');
  assert.deepStrictEqual(Object.keys(servers), ['chrome-devtools', 'o8'], 'merge order: existing first');

  // ── http → httpUrl (not url) — the streamable-HTTP branch, via the merge path ──
  const httpReg: ToolRegistry = {
    repoPath: '/repo',
    entries: [{ id: 'external:remote', name: 'remote', source: 'external', label: 'remote', surfaces: ['gemini'], config: { type: 'http', url: 'https://h/mcp', headers: { A: 'b' } } }],
  };
  const httpMerged = toGeminiSettingsMerged(httpReg, {}).mcpServers as Record<string, unknown>;
  assert.deepStrictEqual(httpMerged.remote, { httpUrl: 'https://h/mcp', headers: { A: 'b' } }, 'http maps to httpUrl with headers');

  // ── Real write: trailing newline + backup content == original (name globbed) ──
  const cfgDir = mkdtempSync(join(tmpdir(), 'gm-cfg-'));
  const cfgPath = join(cfgDir, 'settings.json');
  const originalOnDisk = JSON.stringify(EXISTING, null, 2) + '\n';
  writeFileSync(cfgPath, originalOnDisk);
  atomicWriteConfig(cfgPath, merged);

  const written = readFileSync(cfgPath, 'utf-8');
  assert.strictEqual(written, JSON.stringify(merged, null, 2) + '\n', 'written file = merged + trailing newline');
  const backups = readdirSync(dirname(cfgPath)).filter((f) => f.startsWith(`${basename(cfgPath)}.o8-backup-`));
  assert.strictEqual(backups.length, 1, 'one timestamped backup');
  assert.strictEqual(readFileSync(join(cfgDir, backups[0]), 'utf-8'), originalOnDisk, 'backup content == pre-merge original');

  console.log('[tool-spine-gemini-consumer-smoke] PASS (' + written.length + 'B written)');
}

main();
