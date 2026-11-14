import { NextRequest, NextResponse } from 'next/server';
import { getOperatorDefaults } from '@/lib/operator/defaults';
import { requestNextPill } from '@/lib/next/browser-pipe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Existing API authorization applies; this route grants no voice/control authority. */
export async function POST(request: NextRequest) {
  if (Number(request.headers.get('content-length') ?? 0) > 8192) {
    return NextResponse.json({ native: false }, { status: 413 });
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 8192) { await reader.cancel(); return NextResponse.json({ native: false }, { status: 413 }); }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ native: false }, { status: 400 }); }
  if (!body || typeof body !== 'object' || !['prepare', 'frame', 'release'].includes(String(body.action))) {
    return NextResponse.json({ native: false }, { status: 400 });
  }
  const { values } = await getOperatorDefaults();
  const enabled = values.nativeDictationPill === true;
  const reply = await requestNextPill(enabled ? body : { action: 'release' }) as { ok?: boolean; finishSession?: number | null } | null;
  return NextResponse.json({ native: enabled && reply?.ok === true, ...(enabled && typeof reply?.finishSession === 'number' ? { finishSession: reply.finishSession } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
}
