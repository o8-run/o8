import { NextRequest } from 'next/server';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const dynamic = 'force-dynamic';

// Do not initialize provider clients, spend services or the abuse limiter in Next.
export const POST = ownedByNativeTransport(
  async request => (await import('@/lib/llm/proxy-route')).POST(new NextRequest(request)),
  () => Response.json({ error: 'Model service unavailable' }, { status: 503 }),
  { forwardHeaders: ['cookie', 'x-tab-id', 'x-cortex-repo-path'] },
);
