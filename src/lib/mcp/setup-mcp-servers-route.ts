export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import {
  insertExternalMcpServer,
  listExternalMcpServers,
  updateExternalMcpServer,
  removeExternalMcpServer,
  type ExternalMcpTransport,
} from '@/lib/mcp/external-servers';

function isTransport(value: unknown): value is ExternalMcpTransport {
  return value === 'stdio' || value === 'http';
}

function parseArgs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('Args must be an array of strings');
  }
  return [...value] as string[];
}

function parseEnv(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmedKey = key.trim();
    if (!trimmedKey) {
      continue;
    }
    next[trimmedKey] = raw;
  }

  return Object.keys(next).length > 0 ? next : null;
}

export async function GET() {
  try {
    const servers = listExternalMcpServers().map((server) => ({
      ...server,
      env: null,
      envJson: null,
      oauthToken: null,
      hasEnv: Boolean(server.env && Object.keys(server.env).length > 0),
      hasOAuthToken: Boolean(server.oauthToken),
    }));
    return NextResponse.json({ servers });
  } catch (error) {
    console.error('[mcp-servers] load failed:', error);
    return NextResponse.json(
      { error: 'Failed to load MCP servers' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as {
      name?: unknown;
      transport?: unknown;
      command?: unknown;
      args?: unknown;
      env?: unknown;
      enabled?: unknown;
      workerInjection?: unknown;
      symonInjection?: unknown;
    };

    if (typeof body.name !== 'string' || !body.name.trim()) {
      return NextResponse.json({ error: 'Server name is required' }, { status: 400 });
    }
    if (!isTransport(body.transport)) {
      return NextResponse.json({ error: 'Transport must be "stdio" or "http"' }, { status: 400 });
    }
    if (typeof body.command !== 'string' || !body.command.trim()) {
      return NextResponse.json(
        { error: body.transport === 'http' ? 'Server URL is required' : 'Command is required' },
        { status: 400 },
      );
    }

    const server = insertExternalMcpServer({
      name: body.name,
      transport: body.transport,
      command: body.command,
      args: parseArgs(body.args),
      env: parseEnv(body.env),
      enabled: body.enabled !== false,
      workerInjection: body.transport === 'stdio' && body.workerInjection === true,
      symonInjection: body.symonInjection === true,
    });

    return NextResponse.json({ ok: true, server: { ...server, env: null, envJson: null, oauthToken: null } });
  } catch {
    console.error('[api] setup/mcp-servers failed');
    return NextResponse.json(
      { error: 'Failed to create MCP server' },
      { status: 400 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as {
      id?: unknown;
      enabled?: unknown;
      workerInjection?: unknown;
      symonInjection?: unknown;
    };
    if (typeof body.id !== 'string' || !body.id.trim()) {
      return NextResponse.json({ error: 'Server id is required' }, { status: 400 });
    }
    const hasEnabled = typeof body.enabled === 'boolean';
    const hasWorkerInjection = typeof body.workerInjection === 'boolean';
    const hasSymonInjection = typeof body.symonInjection === 'boolean';
    if (!hasEnabled && !hasWorkerInjection && !hasSymonInjection) {
      return NextResponse.json(
        { error: 'Enabled, workerInjection, or symonInjection must be a boolean' },
        { status: 400 },
      );
    }

    const server = updateExternalMcpServer(body.id, {
      ...(hasEnabled ? { enabled: body.enabled as boolean } : {}),
      ...(hasWorkerInjection ? { workerInjection: body.workerInjection as boolean } : {}),
      ...(hasSymonInjection ? { symonInjection: body.symonInjection as boolean } : {}),
    });
    if (!server) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, server: { ...server, env: null, envJson: null, oauthToken: null } });
  } catch (error) {
    console.error('[api] setup/mcp-servers failed:', error);
    return NextResponse.json(
      { error: 'Failed to update MCP server' },
      { status: 400 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { id?: unknown };
    if (typeof body.id !== 'string' || !body.id.trim()) {
      return NextResponse.json({ error: 'Server id is required' }, { status: 400 });
    }

    const removed = removeExternalMcpServer(body.id);
    if (!removed) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[api] setup/mcp-servers failed:', error);
    return NextResponse.json(
      { error: 'Failed to remove MCP server' },
      { status: 400 },
    );
  }
}
