import { NextResponse } from 'next/server';
import * as handlers from '@/lib/tts/route';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const dynamic = 'force-dynamic';

// The edge-tts installer is per-process; one process owns it (#5422).
export const POST = ownedByNativeTransport(handlers.POST,
  () => NextResponse.json({ error: 'Steffan voice unavailable', code: 'edge_voice_unavailable' }, { status: 503 }));
