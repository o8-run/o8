import { NextResponse, type NextRequest } from 'next/server';
import { readPacketTranscriptEvents, readSessionTranscriptEvents } from '@/lib/orchestrator/packet-transcript';
import { transcriptWindow } from '@/lib/orchestrator/packet-transcript-window';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { findLaneBySession } from '@/lib/lane/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(parsed));
}

function parseCursor(raw: string | null): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parseTail(raw: string | null): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

export async function GET(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  const params = request.nextUrl.searchParams;
  const packetId = (params.get('packetId') ?? '').trim();
  // sessionKey fallback — a dispatched tab always knows its lane sessionKey,
  // but packetId resolution depends on the client's mission-state projection,
  // which goes stale when missions are created outside the desktop flow (MCP
  // dispatch, #1389). Live-hit 2026-07-04: every packet tab stuck on "Agent
  // working…" because the poll never resolved a packetId.
  const sessionKey = (params.get('sessionKey') ?? '').trim();
  const limit = parseLimit(params.get('limit'));
  const cursor = parseCursor(params.get('cursor'));
  const tail = parseTail(params.get('tail'));
  const fullHistory = !tail || params.get('history') === 'complete';

  if (!packetId && !sessionKey) {
    return NextResponse.json(
      { ok: false, error: { code: 'packet_id_required', message: 'packetId or sessionKey is required' } },
      { status: 400, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
  const resolvedPacketId = packetId || findLaneBySession(sessionKey)?.packetId || null;
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(request), resolvedPacketId);
  if (ownershipRefusal) {
    return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
  }

  try {
    const native = params.has('cursorToken');
    const readback = packetId
      ? await (native ? readPacketTranscriptEvents(packetId, fullHistory, true) : readPacketTranscriptEvents(packetId, fullHistory))
      : { packetId: '', ...(await (native ? readSessionTranscriptEvents(sessionKey, fullHistory, true) : readSessionTranscriptEvents(sessionKey, fullHistory))) };

    if (readback.unsupportedReason) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: readback.unsupportedReason,
            message: `Transcript readback for ${readback.runtime ?? 'unknown'} sessions is not implemented yet.`,
          },
          packetId,
          sessionKey: readback.sessionKey,
          runtime: readback.runtime,
        },
        { status: 501, headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    }

    const window = transcriptWindow(readback.events, cursor, limit, tail, params.get('cursorToken'));

    return NextResponse.json(
      {
        packetId,
        sessionKey: readback.sessionKey || null,
        ...window,
        // Existing consumers retain their event shape; native callers opt in
        // to identity/checkpoint fields with cursorToken, including the first read.
        events: params.has('cursorToken') ? window.events : window.events.map(({ eventId, ...event }) => { void eventId; return event; }),
        historyComplete: readback.historyComplete === true && (!tail || readback.events.length <= limit),
        earliestEventTime: readback.earliestEventTime ?? null,
        terminalReason: readback.terminalReason ?? null,
        ...(readback.note ? { note: readback.note } : {}),
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    const message = 'Unable to read packet transcript.';
    console.error('[packet-transcript] read failed:', error);
    return NextResponse.json(
      {
        ok: false,
        error: { code: 'packet_transcript_failed', message },
      },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }
}
