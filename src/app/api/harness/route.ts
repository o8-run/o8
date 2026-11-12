import type { NextRequest } from 'next/server';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const unavailable = () => Response.json({ ok: false, error: { code: 'harness_unavailable', message: 'Harness owner is unavailable.' } }, { status: 503 });
export const POST = ownedByNativeTransport(async request =>
  (await import('@/lib/harness/route')).POST(request as NextRequest), unavailable);
