import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const unavailable = () => Response.json({ error: 'Native owner unavailable.' }, { status: 503 });
export const GET = ownedByNativeTransport(async request => (await import('@/app/api/panel/operator-defaults/handler')).GET(request as NextRequest), unavailable);
export const POST = ownedByNativeTransport(async request => (await import('@/app/api/panel/operator-defaults/handler')).POST(request as NextRequest), unavailable);
