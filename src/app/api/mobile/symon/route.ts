import * as handlers from '@/lib/mobile/symon-relay-route';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const unavailable = () => Response.json({ ok: false, error: 'desktop_unavailable' }, { status: 503 });

// The WS process owns the bridge sockets and active turns in native mode.
export const GET = ownedByNativeTransport(() => handlers.GET(), unavailable);
export const POST = ownedByNativeTransport(() => handlers.POST(), unavailable);
