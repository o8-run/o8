import { GET as getHandler, POST as postHandler } from '@/lib/mcp/setup-opencode-route';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const dynamic = 'force-dynamic';

const unavailable = () => Response.json({ error: 'OpenCode setup is unavailable.' }, { status: 503 });
// The WS process owns config writes for both native and Next callers.
export const GET = ownedByNativeTransport(getHandler, unavailable);
export const POST = ownedByNativeTransport(postHandler, unavailable);
