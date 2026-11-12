import { NextRequest } from 'next/server';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const unavailable = () => Response.json({ error: 'The native service is unavailable.' }, { status: 503 });
export const GET = ownedByNativeTransport(async request => (await import('@/lib/approvals/route')).GET(new NextRequest(request)), unavailable, { forwardHeaders: ['cookie', 'x-o8-agent-tool'] });
export const POST = ownedByNativeTransport(async request => (await import('@/lib/approvals/route')).POST(new NextRequest(request)), unavailable, { forwardHeaders: ['cookie', 'x-o8-agent-tool'] });
