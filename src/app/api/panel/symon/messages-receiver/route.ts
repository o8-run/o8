import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const unavailable = () => Response.json({ ok: false, error: 'receiver_unavailable' }, { status: 503 });
// The receiver belongs to WS in every mode. Next never imports its state or brain.
export const GET = ownedByNativeTransport(async () => unavailable(), unavailable, { alwaysForward: true });
export const POST = ownedByNativeTransport(async () => unavailable(), unavailable, { alwaysForward: true });
