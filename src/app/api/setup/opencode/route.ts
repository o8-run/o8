/**
 * OpenCode 2 CLI Auto-Register
 *
 * POST — merge o8's managed MCP servers (o8 operator + codebase-memory) into the
 *        user's OpenCode config under `mcp`, without touching any other server or
 *        top-level key. Mirrors /api/setup/gemini (merge-preserving read → atomic
 *        write + .o8-backup-<ts>, reusing the shared claude-desktop-config-io).
 * GET  — preview: current managed entries + whether they're up to date.
 *
 * TARGET: user-level global ~/.config/opencode/opencode.json (XDG-aware), the
 * GLOBAL tool config — matching how o8 hits ~/.claude.json / ~/.gemini/settings.json.
 * OpenCode also reads a PROJECT-level opencode.json (which OVERRIDES the global on
 * conflicts) and honors an OPENCODE_CONFIG env override — both out of scope: o8's
 * operator MCP is a global tool, not repo-scoped.
 *
 * The entry shapes come ENTIRELY from the Tool-Spine opencode emitter
 * (toOpencodeJson): top key `mcp`; local = { type:'local', command:[cmd, ...args],
 * [environment] }; remote = { type:'remote', url, [headers] }. Never hand-rolled.
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readClaudeConfig, atomicWriteConfig, type ClaudeDesktopConfig } from '@/lib/mcp/claude-desktop-config-io';
import { buildToolRegistry } from '@/lib/mcp/tool-spine/build';
import { toOpencodeJson, toOpencodeJsonMerged } from '@/lib/mcp/tool-spine/emit-opencode';

function getOpencodeConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg || join(process.env.HOME || process.env.USERPROFILE || '', '.config');
  return join(base, 'opencode', 'opencode.json');
}

// OpenCode's MCP servers live under the `mcp` top-level key, which ClaudeDesktopConfig
// (the shared mergeable-JSON config) carries via its [key]: unknown index.
function mcpOf(config: ClaudeDesktopConfig): Record<string, unknown> {
  const mcp = config.mcp;
  return mcp && typeof mcp === 'object' && !Array.isArray(mcp) ? (mcp as Record<string, unknown>) : {};
}

export async function GET() {
  try {
    const path = getOpencodeConfigPath();
    const fileExists = existsSync(path);
    const config = readClaudeConfig(path);
    const existingServers = mcpOf(config);

    const proposed = toOpencodeJson(buildToolRegistry(process.cwd())).mcp;
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
    console.error('[setup/opencode] GET error:', error);
    return NextResponse.json(
      { error: 'Failed to inspect OpenCode config', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { remove?: unknown };
    const remove = body.remove === true;
    const path = getOpencodeConfigPath();

    const registry = buildToolRegistry(process.cwd());
    const managedNames = Object.keys(toOpencodeJson(registry).mcp);
    const config = readClaudeConfig(path);

    if (remove) {
      const servers = config.mcp && typeof config.mcp === 'object' ? (config.mcp as Record<string, unknown>) : null;
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
        atomicWriteConfig(path, config, 'opencode');
        return NextResponse.json({ ok: true, action: 'removed', path, removed });
      }
      return NextResponse.json({ ok: true, action: 'no-op', path, detail: 'o8 was not registered' });
    }

    const merged = toOpencodeJsonMerged(registry, config);
    atomicWriteConfig(path, merged, 'opencode');

    return NextResponse.json({
      ok: true,
      action: 'installed',
      path,
      installed: managedNames,
      detail: 'Restart the OpenCode 2 CLI (or start a new session) to load the o8 tools.',
    });
  } catch (error) {
    console.error('[setup/opencode] POST error:', error);
    return NextResponse.json(
      { ok: false, error: 'Failed to write OpenCode config', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
