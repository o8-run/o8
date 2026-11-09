import { NextResponse } from 'next/server';
import { getSymonMcpCatalog } from '@/lib/mcp/symon-tools';
import { authorizeSymonMcpRoute } from '@/lib/mcp/symon-mcp-route-auth';

export async function GET(request: Request) {
  const denied = authorizeSymonMcpRoute(request);
  if (denied) return denied;

  try {
    const catalog = await getSymonMcpCatalog({ refresh: true });
    return NextResponse.json({ ok: true, ...catalog });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to load connected MCP tools.' },
      { status: 500 },
    );
  }
}
