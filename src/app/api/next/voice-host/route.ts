import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { getWsBase } from '@/lib/panel/api-port';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function relay(req: NextRequest) {
  try {
    let body: Buffer | undefined;
    if (req.method === 'POST') {
      const chunks: Uint8Array[] = []; let bytes = 0;
      const reader = req.body?.getReader();
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 64 * 1024) {
          await reader.cancel();
          return NextResponse.json({ ok: false, error: 'Voice request exceeds 64 KiB.' }, { status: 413 });
        }
        chunks.push(value);
      }
      body = Buffer.concat(chunks);
    }
    const origin = process.env.CORTEX_REALTIME_INTERNAL_ORIGIN ?? getWsBase();
    const response = await fetch(`${origin}/internal/next/voice-host`, {
      method: req.method, headers: { Authorization: `Bearer ${getOrCreateWsToken()}`, 'Content-Type': 'application/json' },
      body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(2500),
    });
    return new Response(await response.text(), { status: response.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ ok: false, code: 'VOICE_HOST_UNAVAILABLE' }, { status: 503 });
  }
}
export const GET = relay;
export const POST = relay;
