import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = ownedByNativeTransport(
  async request => (await import('@/lib/devices/agent-route')).POST(request),
  () => Response.json({ error: 'Device worker owner unavailable' }, { status: 503 }),
  // The handler validates MCP's mirrored routing headers (prepareMcpHttp).
  { forwardHeaders: ['accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name'] },
);
