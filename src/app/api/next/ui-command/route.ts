import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { getWsBase } from '@/lib/panel/api-port';
import { MAX_UI_COMMAND_BYTES, parseUiCommand } from '@/lib/next/ui-command';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REALTIME_INTERNAL_ORIGIN =
  process.env.CORTEX_REALTIME_INTERNAL_ORIGIN ?? getWsBase();
const REALTIME_INTERNAL_TIMEOUT_MS = 2_500;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    // Bound streamed requests too; Content-Length is neither required nor trusted.
    const reader = req.body?.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_UI_COMMAND_BYTES) {
          await reader.cancel();
          return NextResponse.json({ ok: false, error: 'UI command exceeds 64 KiB.' }, { status: 413 });
        }
        chunks.push(Buffer.from(value));
      }
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 });
  }

  const command = parseUiCommand(body);
  if (!command) {
    return NextResponse.json(
      { ok: false, error: 'A known kind and an object payload are required.' },
      { status: 400 },
    );
  }

  try {
    const response = await fetch(`${REALTIME_INTERNAL_ORIGIN}/internal/ui-command`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getOrCreateWsToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(REALTIME_INTERNAL_TIMEOUT_MS),
    });
    if (!response.ok) {
      return NextResponse.json({ ok: false, error: 'Failed to broadcast UI command.' }, { status: 502 });
    }
    const payload = await response.json() as { recipients: number };
    return NextResponse.json({ ok: true, recipients: payload.recipients });
  } catch (error) {
    console.error('[next/ui-command] internal fetch failed', error);
    return NextResponse.json({ ok: false, error: 'Realtime bridge unavailable.' }, { status: 502 });
  }
}
