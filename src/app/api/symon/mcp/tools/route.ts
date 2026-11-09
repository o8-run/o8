import { NextResponse } from 'next/server';
import * as handlers from '@/lib/mcp/symon-mcp-tools-route';
import { ownedByNativeTransport } from '@/lib/ws-server/native-owner';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Connected MCP sessions are per process; one process owns them (#5422).
export const GET = ownedByNativeTransport(handlers.GET,
  () => NextResponse.json({ ok: false, error: 'Connected MCP tools are unavailable.' }, { status: 503 }));
