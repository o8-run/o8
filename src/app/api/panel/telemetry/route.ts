import { NextResponse } from 'next/server';

import { sanitizeProductEvent } from '@/lib/analytics/events';
import { emitProductEvent, isProductTelemetryEnabled } from '@/lib/analytics/server';

export const dynamic = 'force-dynamic';

/** Browser egress probe: persisted preference plus first-run disclosure gate. */
export async function GET() {
  return NextResponse.json({ enabled: isProductTelemetryEnabled() });
}

/**
 * Browser product-event forwarder. Consent is checked before parsing the body,
 * then checked again by emitProductEvent() immediately before network egress.
 */
export async function POST(request: Request) {
  try {
    if (!isProductTelemetryEnabled()) {
      return NextResponse.json({ ok: true, emitted: false });
    }

    const body = (await request.json().catch(() => null)) as { event?: unknown; props?: unknown } | null;
    const payload = sanitizeProductEvent(body?.event, body?.props);
    if (!payload) {
      return NextResponse.json({ ok: false, emitted: false, reason: 'event not allowed' }, { status: 400 });
    }

    const emitted = await emitProductEvent(payload.event, 'props' in payload ? payload.props : undefined);
    return NextResponse.json({ ok: true, emitted });
  } catch {
    return NextResponse.json({ ok: false, emitted: false });
  }
}
