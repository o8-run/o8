export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/orchestrator/openclaw-availability — is the openclaw
 * orchestrator backend usable on this machine?
 *
 * The mobile /openclaw screen polls this to flip from a "coming online"
 * placeholder to the live surface. `available` is true iff the operator's
 * openclaw config exists AND has the o8 operator MCP server registered — the
 * two preconditions `ensureOpenclawProfile()` (src/lib/lane/orchestrator-backends/
 * openclaw.ts) requires before it can generate the governed `o8` profile.
 *
 * Ungated, consistent with its /api/mobile/orchestrator/ siblings (the whole
 * /api/mobile/* surface except push/* is deliberately absent from
 * GATED_PREFIXES so LAN/Tailscale mobile clients reach it).
 *
 * Returns: { available: boolean, reason?: string }. Never throws.
 */

import { NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { OPENCLAW_SOURCE_CONFIG as OPENCLAW_CONFIG } from '@/lib/lane/orchestrator-backends/openclaw-catalog';

function checkOpenclawAvailability(): { available: boolean; reason?: string } {
  if (!existsSync(OPENCLAW_CONFIG)) {
    return { available: false, reason: 'openclaw is not configured on this machine.' };
  }
  try {
    const config = JSON.parse(readFileSync(OPENCLAW_CONFIG, 'utf-8')) as {
      mcp?: { servers?: Record<string, unknown> };
    };
    if (!config.mcp?.servers?.o8) {
      return {
        available: false,
        reason: 'The o8 MCP server is not registered in openclaw — add it via o8 Settings → MCP.',
      };
    }
    return { available: true };
  } catch {
    return { available: false, reason: 'The openclaw config could not be read.' };
  }
}

export function GET() {
  return NextResponse.json(checkOpenclawAvailability(), {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
