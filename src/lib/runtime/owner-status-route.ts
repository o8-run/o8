import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { isNativeCortexReader } from '@/lib/cortex/owner-process';
export async function GET(request: Request): Promise<Response> {
  if (!headersIndicateLoopback(name => request.headers.get(name)) || resolveRequestPrincipalContext(request).role !== 'operator') {
    return Response.json({ error: 'Runtime ownership requires the local operator.' }, { status: 403 });
  }
  if (!isNativeCortexReader() || process.env.O8_NEXT_O8D !== '1') return new Response(null, { status: 404 });
  return Response.json({ schema: 'o8/runtime-owner/v1', owner: 'ws', pid: process.pid }, { headers: { 'Cache-Control': 'no-store' } });
}
