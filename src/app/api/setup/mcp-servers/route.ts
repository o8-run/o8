import { POST as handler, PATCH as patchHandler, DELETE as deleteHandler } from '@/lib/mcp/setup-mcp-servers-route';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export { GET } from '@/lib/mcp/setup-mcp-servers-route';
export const dynamic = 'force-dynamic';

// Invalidate the native owner's MCP session cache after storing a server.
export const POST = ownedByNativeTransport(handler, () => Response.json(
  { error: 'MCP setup is unavailable.' }, { status: 503 },
));

export const PATCH = ownedByNativeTransport(patchHandler, () => Response.json(
  { error: 'MCP setup is unavailable.' }, { status: 503 },
));
export const DELETE = ownedByNativeTransport(deleteHandler, () => Response.json(
  { error: 'MCP setup is unavailable.' }, { status: 503 },
));
