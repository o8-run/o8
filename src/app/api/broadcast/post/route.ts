import { POST as handler } from '@/lib/broadcast/post-route';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = ownedByNativeTransport(handler, () => Response.json(
  { error: 'Broadcast is unavailable.' }, { status: 503 },
));
