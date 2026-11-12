import { NextRequest } from 'next/server';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const unavailable = () => Response.json({ error: 'The native service is unavailable.' }, { status: 503 });
export const GET = ownedByNativeTransport(async request => (await import('@/lib/chatgpt-plan/route')).GET(new NextRequest(request)), unavailable, { forwardHeaders: ['cookie'] });
export const POST = ownedByNativeTransport(async request => (await import('@/lib/chatgpt-plan/route')).POST(new NextRequest(request)), unavailable, { forwardHeaders: ['cookie'] });
export const DELETE = ownedByNativeTransport(async request => (await import('@/lib/chatgpt-plan/route')).DELETE(new NextRequest(request)), unavailable, { forwardHeaders: ['cookie'] });
