import type { NextRequest } from 'next/server';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const unavailable = () => Response.json({ error: 'Session transform owner is unavailable.' }, { status: 503 });

export const GET = ownedByNativeTransport(async request =>
  (await import('@/lib/runtime/session-transform-route')).GET(request as NextRequest), unavailable);
export const POST = ownedByNativeTransport(async request =>
  (await import('@/lib/runtime/session-transform-route')).POST(request as NextRequest), unavailable);
