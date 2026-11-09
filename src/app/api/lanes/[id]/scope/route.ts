import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelOrWorkerAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext, workerPacketRefusal } from '@/lib/auth/principal';
import { getPacketScope, projectPacketScope } from '@/lib/lanes/scope';
import { requestPacketScopeExpansion } from '@/lib/orchestrator/packet-scope-expansion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelOrWorkerAuth(req);
  if (denied) return denied;

  const { id } = await params;
  const scope = await getPacketScope({ laneId: id })
    ?? await getPacketScope({ packetId: id });
  if (!scope) {
    return NextResponse.json({ ok: false, note: 'Packet scope not found.' }, { status: 404 });
  }
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(req), scope.packetId);
  if (ownershipRefusal) {
    return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
  }

  return NextResponse.json(projectPacketScope(
    scope,
    req.nextUrl.searchParams.get('includeDirectives') === 'true',
  ), {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = requirePanelOrWorkerAuth(req);
  if (denied) return denied;

  const { id } = await params;
  const scope = await getPacketScope({ laneId: id })
    ?? await getPacketScope({ packetId: id });
  if (!scope?.packetId) {
    return NextResponse.json({ ok: false, note: 'Packet scope not found.' }, { status: 404 });
  }
  const ownershipRefusal = workerPacketRefusal(resolveRequestPrincipalContext(req), scope.packetId);
  if (ownershipRefusal) {
    return NextResponse.json({ ok: false, error: ownershipRefusal }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as { paths?: unknown; reason?: unknown } | null;
  const paths = Array.isArray(body?.paths)
    ? body.paths.filter((path): path is string => typeof path === 'string')
    : [];
  const reason = typeof body?.reason === 'string' ? body.reason : '';
  try {
    const result = await requestPacketScopeExpansion({ packetId: scope.packetId, paths, reason });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }, { status: 400 });
  }
}
