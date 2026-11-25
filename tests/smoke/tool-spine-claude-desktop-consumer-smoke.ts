/**
 * Tool-Spine Step-D regression lock (live): the Claude Desktop consumer's
 * WRITTEN ~/.claude.json + its backup.
 *
 * claude-desktop/route.ts (GET preview + POST write) was repointed onto the
 * Tool-Spine claude-desktop projection (toClaudeDesktopJson); the file I/O moved
 * to claude-desktop-config-io.ts. The parity unit is the merged file content.
 * Runs in PACKAGED mode (set inline) so resolution is deterministic — the dev
 * tsx-vs-npx divergence is spec risk #3, proven byte-identical in packaged mode
 * by the one-time ceremony.
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/tool-spine-claude-desktop-consumer-smoke.ts
 */

import assert from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import './require-temp-data-dir';
import { atomicWriteConfig } from '@/lib/mcp/claude-desktop-config-io';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { entriesForSurface } from '@/lib/mcp/tool-spine/registry';
import { toClaudeDesktopJson } from '@/lib/mcp/tool-spine/emit-claude-desktop';

// A realistic ~/.claude.json: several unrelated top-level keys + a non-o8 server.
const EXISTING = {
  $schema: 'https://example/schema.json',
  theme: 'dark',
  globalShortcut: 'Cmd+E',
  mcpServers: {
    filesystem: { command: 'fs-mcp', args: ['/Users/me'] },
    github: { command: 'gh-mcp', env: { GH_TOKEN: 'x' } },
  },
};

function main(): void {
  // Force PACKAGED resolution so the o8 entry is deterministic. A present
  // codebase-memory binary must no longer add an entry.
  const bundleDir = mkdtempSync(join(tmpdir(), 'cd-bundle-'));
  const bundlePath = join(bundleDir, 'operator-mcp-server.mjs');
  const proxyPath = join(bundleDir, 'operator-mcp-proxy.mjs');
  writeFileSync(bundlePath, '');
  writeFileSync(proxyPath, '');
  process.env.O8_BUNDLED_MCP_PATH = bundlePath;
  process.env.O8_BUNDLED_MCP_DIR = bundleDir;
  process.env.O8_NODE_BIN = '/usr/local/bin/node';
  const cmBin = join(mkdtempSync(join(tmpdir(), 'cd-cm-')), 'codebase-memory-mcp');
  writeFileSync(cmBin, '');
  process.env.O8_CODEBASE_MEMORY_BIN = cmBin;

  const registry = buildToolRegistry(process.cwd());
  const installed = entriesForSurface(registry, 'claude-desktop').map((e) => e.name);
  assert.deepStrictEqual(installed, ['o8'], 'claude-desktop surface = o8 only');

  const merged = toClaudeDesktopJson(registry, EXISTING);
  const servers = merged.mcpServers as Record<string, Record<string, unknown>>;

  // #2 — merge preservation: top-level keys + non-o8 servers survive byte-identical.
  assert.strictEqual(merged.$schema, 'https://example/schema.json', '$schema preserved');
  assert.strictEqual(merged.theme, 'dark', 'theme preserved');
  assert.strictEqual(merged.globalShortcut, 'Cmd+E', 'globalShortcut preserved');
  assert.deepStrictEqual(servers.filesystem, { command: 'fs-mcp', args: ['/Users/me'] }, 'filesystem untouched');
  assert.deepStrictEqual(servers.github, { command: 'gh-mcp', env: { GH_TOKEN: 'x' } }, 'github untouched');

  // #3 — type-strip: o8 is {command,args,env} with NO type.
  assert(!('type' in servers.o8), 'o8 entry has no type field');
  assert.deepStrictEqual(servers.o8, { command: '/usr/local/bin/node', args: [proxyPath], env: { O8_API_BASE: 'http://127.0.0.1:3001' } }, 'o8 stdio shape');
  assert(!('codebase-memory' in servers), 'codebase-memory is never written');

  // Key order: existing first, then o8.
  assert.deepStrictEqual(Object.keys(servers), ['filesystem', 'github', 'o8'], 'merge order');

  // #4 + #1 — real write: trailing newline + backup content == original (name ignored).
  const cfgDir = mkdtempSync(join(tmpdir(), 'cd-cfg-'));
  const cfgPath = join(cfgDir, 'claude_desktop_config.json');
  const originalOnDisk = JSON.stringify(EXISTING, null, 2) + '\n';
  writeFileSync(cfgPath, originalOnDisk);

  atomicWriteConfig(cfgPath, merged);

  const written = readFileSync(cfgPath, 'utf-8');
  assert.strictEqual(written, JSON.stringify(merged, null, 2) + '\n', 'written file = merged content + trailing newline');
  assert(written.endsWith('\n'), 'trailing newline preserved');

  // Backup: timestamped NAME is ignored (glob); only its CONTENT is asserted.
  const backups = readdirSync(dirname(cfgPath)).filter((f) => f.startsWith(`${basename(cfgPath)}.o8-backup-`));
  assert.strictEqual(backups.length, 1, 'exactly one timestamped backup written');
  assert.strictEqual(readFileSync(join(cfgDir, backups[0]), 'utf-8'), originalOnDisk, 'backup content == pre-merge original');

  console.log('[tool-spine-claude-desktop-consumer-smoke] PASS (' + written.length + 'B written, backup ' + backups[0].replace(/o8-backup-\d+/, 'o8-backup-<ts>') + ')');
}

main();
