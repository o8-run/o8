export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/orchestrator/openclaw-agents — the openclaw agents available
 * on this machine.
 *
 * The mobile /openclaw surface is grouped by agent: it builds one group per
 * agent from this list, and the operator picks the agent per chat. `id` is the
 * stable key (passed back as the `agent` field on WS messages + chat-history);
 * `name` is the display name and may collide across agents — key on `id`.
 *
 * Ungated, consistent with its /api/mobile/orchestrator/ siblings (the whole
 * /api/mobile/* surface except push/* is deliberately absent from
 * GATED_PREFIXES so LAN/Tailscale mobile clients reach it).
 *
 * Returns: { agents: Array<{ id: string; name: string }> }. Never throws — an
 * unreadable/missing openclaw config yields { agents: [] }.
 */

import { NextResponse } from 'next/server';
import { listOpenclawAgents } from '@/lib/lane/orchestrator-backends/openclaw-catalog';

export function GET() {
  return NextResponse.json(
    { agents: listOpenclawAgents() },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
