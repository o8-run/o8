import * as handlers from '@/lib/devices/route';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const unavailable = () => Response.json({ error: { code: 'device_unavailable', message: 'Device controls are unavailable.' } }, { status: 503 });

// The WS process owns the manager and its child processes in native mode.
// Next checks the caller's page and forwards its origin, which frames the viewer.
// The WS listener checks the operator again before it uses that origin.
const pageOrigin = (request: Request): string | Response => {
  try { return handlers.pageOrigin(request); } catch (error) { return handlers.failure(error); }
};
export const GET = ownedByNativeTransport(handlers.GET, unavailable, { pageOrigin });
export const POST = ownedByNativeTransport(handlers.POST, unavailable, { pageOrigin });
