/**
 * MCP Config Generator
 *
 * Emits the Claude Desktop / Claude Code MCP server config for the current
 * o8 install. Lets a real user install the packaged Tauri app, hit this
 * endpoint, and get a copy-paste-ready config without hardcoded dev paths.
 *
 * Two install modes for the operator MCP compatibility proxy:
 *   1. Dev checkout — use `tsx` against the thin proxy source in-tree.
 *   2. Packaged Tauri app — use `node` against the bundled proxy .mjs in the
 *      resource dir. The proxy forwards stdio JSON-RPC to the single in-app
 *      /api/mcp host; the standalone full server remains available for
 *      headless flows when the app isn't running.
 *
 * Returns:
 *   {
 *     server: { "o8": { command, args, env } },
 *     fullConfig: { "mcpServers": { ... } },
 *     instructions: { claudeDesktop, claudeCode },
 *     diagnostics: { nodeInstalled, codexInstalled, ghInstalled, ... }
 *   }
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from '@/lib/providers/child-process';
import { getApiBase, resolvePortInfo } from '@/lib/panel/api-port';
import { getCliAccessStatus } from '@/lib/access-points/cli-status';
import { getMcpSetupReadiness } from '@/lib/mcp/setup-readiness';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toClaudeDesktopJson } from '@/lib/mcp/tool-spine/emit-claude-desktop';
import { getDataDir } from '@/lib/data-dir-migration';
import { resolveO8WebviewSocketPath } from '@/lib/mcp/o8-webview-socket';

function findCommand(name: string): string | null {
  try {
    const which = execSync(`command -v ${name} 2>/dev/null`, { windowsHide: true, encoding: 'utf-8' }).trim();
    return which || null;
  } catch {
    return null;
  }
}

// The o8 server config comes from the Tool-Spine
// claude-desktop projection (Set B) — see the GET handler. repoPath is
// irrelevant to this surface (cortex/externals filtered out); process.cwd()
// keeps resolver inputs identical to the old builder.

function buildInstructions(): { claudeDesktop: string; claudeCode: string } {
  const home = process.env.HOME || '';
  const claudeDesktopConfigPath = process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : process.platform === 'win32'
      ? '%APPDATA%\\Claude\\claude_desktop_config.json'
      : join(home, '.config', 'Claude', 'claude_desktop_config.json');

  return {
    claudeDesktop: [
      `1. Open ${claudeDesktopConfigPath}`,
      '2. Merge the "o8" entry into your existing "mcpServers" object.',
      '3. Fully quit Claude Desktop (⌘Q on macOS) and reopen it.',
      '4. The o8 tools should appear in the /mcp slash menu.',
    ].join('\n'),
    claudeCode: [
      '1. In the project where you want o8 access, save the full config below as `.mcp.json`.',
      '2. Restart Claude Code (or run /mcp reload).',
      '3. The o8 tools should appear in the /mcp slash menu.',
    ].join('\n'),
  };
}

export async function GET() {
  try {
    const nodeBin = findCommand('node');
    const codexBin = findCommand('codex');
    const ghBin = findCommand('gh');
    const portInfo = resolvePortInfo();
    let webviewSocketPath: string | null = null;
    let webviewToolsBlockedReason: string | null = null;
    try {
      webviewSocketPath = resolveO8WebviewSocketPath();
    } catch (error) {
      webviewToolsBlockedReason = error instanceof Error ? error.message : String(error);
    }

    const dataDir = getDataDir();
    const dbPath = join(dataDir, 'cortex-ide.db');
    const dbExists = existsSync(dbPath);
    const dbSize = dbExists ? statSync(dbPath).size : 0;
    const mcpReady = getMcpSetupReadiness();
    const mcpServers = mcpReady.ready
      ? toClaudeDesktopJson(buildToolRegistry(process.cwd()), {}).mcpServers as Record<string, unknown>
      : {};
    const server = mcpServers['o8'] ?? null;
    const fullConfig = { mcpServers };

    return NextResponse.json({
      setupReady: mcpReady.ready,
      setupBlockedReason: mcpReady.reason,
      setupBlockedDetail: mcpReady.detail,
      server,
      fullConfig,
      instructions: buildInstructions(),
      diagnostics: {
        apiBase: getApiBase(),
        apiPort: portInfo.apiPort,
        wsPort: portInfo.wsPort,
        portSource: portInfo.source,
        bundled: Boolean(process.env.O8_BUNDLED_MCP_PATH),
        platform: process.platform,
        nodeInstalled: Boolean(nodeBin),
        nodeBin,
        codexInstalled: Boolean(codexBin),
        codexBin,
        ghInstalled: Boolean(ghBin),
        ghBin,
        dataDir,
        dbExists,
        dbSize,
        webviewSocketPath,
        webviewToolsAvailable: webviewSocketPath ? existsSync(webviewSocketPath) : false,
        webviewToolsBlockedReason,
        cli: getCliAccessStatus(),
      },
    });
  } catch (error) {
    console.error('[setup/mcp-config] error:', error);
    return NextResponse.json(
      { error: 'Failed to generate MCP config', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
