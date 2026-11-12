import { POST as handler } from '@/lib/mcp/setup-mcp-servers-route';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export { GET, PATCH, DELETE } from '@/lib/mcp/setup-mcp-servers-route';
export const dynamic = 'force-dynamic';

// Invalidate the native owner's MCP session cache after storing a server.
export const POST = ownedByNativeTransport(handler, () => Response.json(
  { error: 'MCP setup is unavailable.' }, { status: 503 },
));
