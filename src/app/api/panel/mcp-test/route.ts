export const dynamic = 'force-dynamic';

/**
 * Panel-gated "test connection" probe for a registered external MCP server.
 *
 * POST /api/panel/mcp-test { serverName?: string; serverId?: string }
 *
 * Spawns the server (stdio) or hits its URL (http), sends `initialize` +
 * `tools/list` over JSON-RPC, and returns the tool count or a structured
 * error. The child is killed afterward so we never leave an orphan.
 *
 * Also accepts an inline config (no DB lookup) for the "add server" form
 * so users can preflight before saving.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { listExternalMcpServers } from '@/lib/mcp/external-servers';
import { testMcpConnection, type McpTestInput } from '@/lib/mcp/test-connection';

interface TestRequestBody {
  serverId?: string;
  serverName?: string;
  inline?: {
    transport?: 'stdio' | 'http';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  };
}

function resolveInputByLookup(body: TestRequestBody): McpTestInput | { error: string } {
  const servers = listExternalMcpServers();
  const target = body.serverId
    ? servers.find((s) => s.id === body.serverId)
    : body.serverName
      ? servers.find((s) => s.name === body.serverName)
      : null;
  if (!target) {
    return { error: 'Server not found' };
  }
  const config = target.transport === 'http'
    ? { type: 'http' as const, url: target.url || target.command, headers: target.oauthToken ? { Authorization: `Bearer ${target.oauthToken}` } : undefined }
    : { type: 'stdio' as const, command: target.command, args: target.args, env: target.env ?? undefined };
  if (config.type === 'http') {
    return {
      transport: 'http',
      url: config.url,
      headers: config.headers,
    };
  }
  return {
    transport: 'stdio',
    command: config.command,
    args: config.args,
    env: config.env,
  };
}

function resolveInlineInput(inline: NonNullable<TestRequestBody['inline']>): McpTestInput | { error: string } {
  if (inline.transport === 'http') {
    const url = typeof inline.url === 'string' ? inline.url.trim() : '';
    if (!url) return { error: 'HTTP test needs a url' };
    return {
      transport: 'http',
      url,
      headers: inline.headers,
    };
  }
  const command = typeof inline.command === 'string' ? inline.command.trim() : '';
  if (!command) return { error: 'stdio test needs a command' };
  return {
    transport: 'stdio',
    command,
    args: Array.isArray(inline.args) ? inline.args.filter((a): a is string => typeof a === 'string') : [],
    env: inline.env ?? undefined,
  };
}

export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const body = await request.json().catch(() => ({})) as TestRequestBody;

  const resolved = body.inline
    ? resolveInlineInput(body.inline)
    : resolveInputByLookup(body);

  if ('error' in resolved) {
    return NextResponse.json({ ok: false, error: resolved.error }, { status: 400 });
  }

  try {
    const result = await testMcpConnection(resolved);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Test failed' },
      { status: 500 },
    );
  }
}
