/**
 * Tool-Spine Phase-2 OpenCode wiring test (live): the consumer that configures
 * the OpenCode CLI (~/.config/opencode/opencode.json) from the registry.
 *
 * NEW behavior (OpenCode had no config surface) — proven by positive + preservation
 * (opencode.json `mcp` format + merge), not a before/after baseline. PACKAGED mode
 * so the o8 entry is the stable command:[<node>, <bundled .mjs>] shape.
 *
 *   CORTEX_IDE_DATA_DIR=$(mktemp -d) NODE_OPTIONS='--conditions=react-server' \
 *     npx tsx tests/smoke/tool-spine-opencode-consumer-smoke.ts
 */

import assert from 'node:assert';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import './require-temp-data-dir';
import { atomicWriteConfig, type ClaudeDesktopConfig } from '@/lib/mcp/claude-desktop-config-io';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { entriesForSurface, type ToolRegistry } from '@/lib/mcp/tool-spine/registry';
import { toOpencodeJson, toOpencodeJsonMerged } from '@/lib/mcp/tool-spine/emit-opencode';

// A realistic ~/.config/opencode/opencode.json: unrelated top-level keys + the
// user's own MCP server under `mcp`.
const EXISTING: ClaudeDesktopConfig = {
  $schema: 'https://opencode.ai/config.json',
  theme: 'opencode',
  model: 'opencode/gpt-5-nano',
  mcp: {
    'my-tool': { type: 'local', command: ['my-mcp', '--flag'] },
  },
};

function main(): void {
  // Force PACKAGED resolution + put a codebase-memory binary on disk.
  const bundleDir = mkdtempSync(join(tmpdir(), 'oc-bundle-'));
  const bundlePath = join(bundleDir, 'operator-mcp-server.mjs');
  const proxyPath = join(bundleDir, 'operator-mcp-proxy.mjs');
  writeFileSync(bundlePath, '');
  writeFileSync(proxyPath, '');
  process.env.O8_BUNDLED_MCP_PATH = bundlePath;
  process.env.O8_BUNDLED_MCP_DIR = bundleDir;
  process.env.O8_NODE_BIN = '/usr/local/bin/node';
  const cmBin = join(mkdtempSync(join(tmpdir(), 'oc-cm-')), 'codebase-memory-mcp');
  writeFileSync(cmBin, '');
  process.env.O8_CODEBASE_MEMORY_BIN = cmBin;

  const registry = buildToolRegistry(process.cwd());

  // Surface membership — operator (o8) only, NOT widened.
  assert.deepStrictEqual(entriesForSurface(registry, 'opencode').map((e) => e.name), ['o8'], 'opencode surface = o8 only');

  const merged = toOpencodeJsonMerged(registry, EXISTING);
  const mcp = merged.mcp as Record<string, Record<string, unknown>>;
  const projection = toOpencodeJson(registry).mcp as Record<string, unknown>;

  // ── Positive: managed entries match the emitter projection exactly ──
  for (const name of Object.keys(projection)) {
    assert.deepStrictEqual(mcp[name], projection[name], `${name} matches toOpencodeJson projection`);
  }
  // local shape: type:'local', folded command array, environment intact on o8.
  assert.deepStrictEqual(mcp.o8, { type: 'local', command: ['/usr/local/bin/node', proxyPath], environment: { O8_API_BASE: 'http://127.0.0.1:3001' } }, 'o8 local shape (folded command + environment)');
  assert(!('codebase-memory' in mcp), 'codebase-memory is never written');

  // ── Preservation: other servers + top-level keys byte-identical ──
  assert.deepStrictEqual(mcp['my-tool'], { type: 'local', command: ['my-mcp', '--flag'] }, 'user server preserved');
  assert.strictEqual(merged.$schema, 'https://opencode.ai/config.json', '$schema preserved');
  assert.strictEqual(merged.theme, 'opencode', 'theme preserved');
  assert.strictEqual(merged.model, 'opencode/gpt-5-nano', 'model preserved');
  assert.deepStrictEqual(Object.keys(mcp), ['my-tool', 'o8'], 'merge order: existing first');

  // ── http → type:remote with url (not httpUrl) — via the merge path ──
  const httpReg: ToolRegistry = {
    repoPath: '/repo',
    entries: [{ id: 'external:remote', name: 'remote', source: 'external', label: 'remote', surfaces: ['opencode'], config: { type: 'http', url: 'https://h/mcp', headers: { A: 'b' } } }],
  };
  const httpMerged = (toOpencodeJsonMerged(httpReg, {}).mcp) as Record<string, unknown>;
  assert.deepStrictEqual(httpMerged.remote, { type: 'remote', url: 'https://h/mcp', headers: { A: 'b' } }, 'http maps to type:remote with url + headers');

  // ── Real write: trailing newline + backup content == original (name globbed) ──
  const cfgDir = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
  const cfgPath = join(cfgDir, 'opencode.json');
  const originalOnDisk = JSON.stringify(EXISTING, null, 2) + '\n';
  writeFileSync(cfgPath, originalOnDisk);
  atomicWriteConfig(cfgPath, merged);

  const written = readFileSync(cfgPath, 'utf-8');
  assert.strictEqual(written, JSON.stringify(merged, null, 2) + '\n', 'written file = merged + trailing newline');
  const backups = readdirSync(dirname(cfgPath)).filter((f) => f.startsWith(`${basename(cfgPath)}.o8-backup-`));
  assert.strictEqual(backups.length, 1, 'one timestamped backup');
  assert.strictEqual(readFileSync(join(cfgDir, backups[0]), 'utf-8'), originalOnDisk, 'backup content == pre-merge original');

  console.log('[tool-spine-opencode-consumer-smoke] PASS (' + written.length + 'B written)');
}

main();
