import type { NextRequest } from 'next/server';
import * as handlers from '@/lib/mobile/symon-confirm-route';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const unavailable = () => Response.json({ ok: false, error: 'desktop_unavailable' }, { status: 503 });

// The WS process owns the bridge sockets and active turns in native mode.
export const POST = ownedByNativeTransport((request: Request) => handlers.POST(request as NextRequest), unavailable);
