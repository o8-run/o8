/**
 * GET /api/panel/release-health?version=X — updater kill-switch check.
 *
 * The desktop webview CSP forbids connecting to raw.githubusercontent.com, so
 * the UpdateCard asks the server (operator bearer only) to fetch the release-health
 * manifest and decide whether the target version is pulled. FAIL-OPEN: any
 * error returns `{ pulled: false }` so the update proceeds. Never throws.
 */

import { NextResponse } from 'next/server';

import { evaluateReleaseHealth } from '@/lib/app-update/release-health';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET(request: Request) {
  try {
    const version = new URL(request.url).searchParams.get('version')?.trim();
    if (!version) {
      // No version to evaluate — fail open.
      return NextResponse.json({ pulled: false }, { headers: NO_STORE });
    }
    const decision = await evaluateReleaseHealth(version);
    return NextResponse.json(decision, { headers: NO_STORE });
  } catch (error) {
    console.error('[app-update] release-health route error:', error instanceof Error ? error.message : error);
    // Fail open on any unexpected error.
    return NextResponse.json({ pulled: false }, { headers: NO_STORE });
  }
}
