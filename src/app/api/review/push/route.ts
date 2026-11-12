import { NextResponse } from 'next/server';
import { POST as handlePost } from '@/lib/review/push-route';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = ownedByNativeTransport(handlePost, () =>
  NextResponse.json({ error: 'Push failed' }, { status: 503 }));
