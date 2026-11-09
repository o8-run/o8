import { NextResponse } from 'next/server';
import * as drain from '@/app/api/panel/cloud-jobs/drain/route';

/**
 * The restart drain, as the WS process serves it. Drain state is SQLite, keyed by boot id, and
 * Next's cloud claims honour a drain only when their boot id matches; a claim with a different
 * boot id deletes the drain row (sqlite-job-claim.ts). The shell sets one O8_BOOT_ID on both
 * processes. Without it each process falls back to its own id, so a drain begun here would be
 * silently undone by Next's next claim: refuse instead of starting one.
 */
function unsharedBoot(): Response | null {
  if (process.env.O8_BOOT_ID?.trim()) return null;
  return NextResponse.json({
    ok: false, retryable: true,
    error: 'The restart drain needs the app boot identity; retry once the app has started.',
  }, { status: 503, headers: { 'Cache-Control': 'no-store, max-age=0' } });
}

export async function GET() {
  return unsharedBoot() ?? drain.GET();
}

export async function POST(request: Request) {
  return unsharedBoot() ?? drain.POST(request);
}
