/**
 * Gemini CLI Auto-Register
 *
 * POST — merge o8's managed MCP servers (o8 operator + codebase-memory) into the
 *        user's Gemini CLI config without touching any other server or top-level
 *        key. Mirrors /api/setup/claude-desktop (merge-preserving read → atomic
 *        write + .o8-backup-<ts>, reusing the shared claude-desktop-config-io).
 * GET  — preview: current managed entries + whether they're up to date.
 *
 * TARGET: user-level ~/.gemini/settings.json (the GLOBAL tool config, like Claude
 * Desktop's ~/.claude.json). Gemini ALSO reads a PROJECT-level .gemini/settings.json
 * for per-project overrides — deliberately out of scope: o8's operator MCP is a
 * global tool, not repo-scoped, so it belongs in the user config.
 *
 * The entry shapes come ENTIRELY from the Tool-Spine gemini emitter
 * (toGeminiSettings): stdio = { command, args, [env] } with NO `type`;
 * streamable-HTTP = { httpUrl, [headers] }. We never hand-roll the Gemini shape.
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readClaudeConfig, atomicWriteConfig } from '@/lib/mcp/claude-desktop-config-io';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toGeminiSettings, toGeminiSettingsMerged } from '@/lib/mcp/tool-spine/emit-gemini';

function getGeminiConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return join(home, '.gemini', 'settings.json');
}

export async function GET() {
  try {
    const path = getGeminiConfigPath();
    const fileExists = existsSync(path);
    const config = readClaudeConfig(path);
    const existingServers = config.mcpServers && typeof config.mcpServers === 'object'
      ? (config.mcpServers as Record<string, unknown>)
      : {};

    const proposed = toGeminiSettings(buildToolRegistry(process.cwd())).mcpServers as Record<string, unknown>;
    const managedNames = Object.keys(proposed);

    const upToDate = managedNames.every(
      (name) => existingServers[name] && JSON.stringify(existingServers[name]) === JSON.stringify(proposed[name]),
    );

    return NextResponse.json({
      path,
      fileExists,
      proposed,
      managedNames,
      alreadyRegistered: managedNames.some((name) => name in existingServers),
      alreadyUpToDate: fileExists && upToDate,
      otherServers: Object.keys(existingServers).filter((k) => !managedNames.includes(k)),
      size: fileExists ? statSync(path).size : 0,
    });
  } catch (error) {
    console.error('[setup/gemini] GET error:', error);
    return NextResponse.json(
      { error: 'Failed to inspect Gemini config', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { remove?: unknown };
    const remove = body.remove === true;
    const path = getGeminiConfigPath();

    const registry = buildToolRegistry(process.cwd());
    const managedNames = Object.keys(toGeminiSettings(registry).mcpServers);
    const config = readClaudeConfig(path);

    if (remove) {
      const servers =
        config.mcpServers && typeof config.mcpServers === 'object' ? (config.mcpServers as Record<string, unknown>) : null;
      const removed: string[] = [];
      if (servers) {
        for (const name of managedNames) {
          if (name in servers) {
            delete servers[name];
            removed.push(name);
          }
        }
      }
      if (removed.length > 0) {
        atomicWriteConfig(path, config, 'gemini');
        return NextResponse.json({ ok: true, action: 'removed', path, removed });
      }
      return NextResponse.json({ ok: true, action: 'no-op', path, detail: 'o8 was not registered' });
    }

    const merged = toGeminiSettingsMerged(registry, config);
    atomicWriteConfig(path, merged, 'gemini');

    return NextResponse.json({
      ok: true,
      action: 'installed',
      path,
      installed: managedNames,
      detail: 'Restart the Gemini CLI (or start a new session) to load the o8 tools.',
    });
  } catch (error) {
    console.error('[setup/gemini] POST error:', error);
    return NextResponse.json(
      { ok: false, error: 'Failed to write Gemini config', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
