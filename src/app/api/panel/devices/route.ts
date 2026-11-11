import * as handlers from '@/lib/devices/route';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const unavailable = () => Response.json({ error: { code: 'device_unavailable', message: 'Device controls are unavailable.' } }, { status: 503 });

// The WS process owns the manager and its child processes in native mode.
export const GET = ownedByNativeTransport(handlers.GET, unavailable);
export const POST = ownedByNativeTransport(handlers.POST, unavailable);
